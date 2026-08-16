import express from "express";
import { config, configured } from "../config.mjs";
import { dingtalk } from "../dingtalk.mjs";
import { getDb, getRosterBaseline } from "../db.mjs";
import { enrichProject } from "../project-status.mjs";
import { ai } from "../ai.mjs";

const router = express.Router();

function fmt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

router.get("/system", (req, res) => {
  res.json({
    configured: configured(),
    useDemoData: config.useDemoData,
    aiProvider: config.ai.provider,
    publicBaseUrl: config.publicBaseUrl,
  });
});

router.get("/overview", (req, res) => {
  const db = getDb();
  const latestRow = db.prepare("SELECT MAX(report_date) mx FROM dingtalk_reports").get();
  const latest = latestRow?.mx;
  const today = new Date().toISOString().slice(0, 10);
  // 有效日期：传入优先；否则取最近有日志的日期（历史数据下避免卡片恒为 0）。该日无日志则回退最近有日志日。
  let date = req.query.date || latest || today;
  if (!db.prepare("SELECT 1 FROM dingtalk_reports WHERE report_date=? LIMIT 1").get(date) && latest) date = latest;

  const pendingEmails = db.prepare("SELECT id, subject, sender, importance FROM emails WHERE needs_action=1 AND source='outlook' ORDER BY received_at DESC LIMIT 8").all();
  const meetings = db.prepare("SELECT id, title, start_at, end_at, location, organizer FROM calendars WHERE day=? ORDER BY start_at").all(date);
  const reports = db.prepare("SELECT user_name, blockers, needs_review FROM dingtalk_reports WHERE report_date=?").all(date);
  const blockers = reports.flatMap((r) => {
    try { return JSON.parse(r.blockers); } catch { return []; }
  });
  const needReview = reports.flatMap((r) => {
    try { return JSON.parse(r.needs_review); } catch { return []; }
  });
  // 未提交：历史真实提交人基线中，当日未出现在 dingtalk_reports 者（不再依赖写死种子名册）。
  const baseline = getRosterBaseline(db);
  const submittedKeys = new Set(
    db
      .prepare("SELECT DISTINCT COALESCE(NULLIF(user_id, ''), user_name) AS key FROM dingtalk_reports WHERE report_date=?")
      .all(date)
      .map((r) => r.key),
  );
  const notSubmitted = baseline.filter((m) => !submittedKeys.has(m.key)).map((m) => m.name);
  const openTodos = db.prepare("SELECT COUNT(*) c FROM todos WHERE status!='done'").get().c;

  // 风险项目自动预警：at_risk / overdue 纳入概览
  const projects = db.prepare("SELECT * FROM projects").all();
  const allPhases = db.prepare("SELECT * FROM project_phases").all();
  const phasesByProj = {};
  for (const p of allPhases) (phasesByProj[p.project_id] ||= []).push(p);
  const riskProjects = projects
    .map((p) => enrichProject(p, phasesByProj[p.id] || []))
    .filter((p) => p.status === "at_risk" || p.status === "overdue")
    .map((p) => ({ id: p.id, name: p.name, owner: p.owner, progress: p.progress, status: p.status, statusLabel: p.statusLabel }));

  res.json({
    date,
    pendingEmails,
    meetings: meetings.map((m) => ({ ...m, start: fmt(m.start_at), end: m.end_at ? fmt(m.end_at) : "" })),
    teamBlockers: blockers,
    needReview,
    notSubmitted,
    openTodos,
    riskProjects,
  });
});

// ---- AI 今日工作建议：数据感知 + LLM 生成，带 1h 缓存 ----
const suggestionCache = { text: null, ts: 0 };
const SUGGESTION_TTL = 3600 * 1000;

function buildFallback(s) {
  const parts = [];
  if (s.riskProjects > 0) parts.push(`有 ${s.riskProjects} 个风险项目在跑，今天优先推进它们，别让进度再滑`);
  if (s.pendingEmails > 0) parts.push(`${s.pendingEmails} 封待处理邮件，先挑高优先级的回掉`);
  if (s.meetingCount > 0) parts.push(`今天 ${s.firstMeetings?.[0]?.time || ""} 的「${s.firstMeetings?.[0]?.title || "会议"}」会前留 30 分钟准备`);
  if (s.blockers > 0) parts.push(`${s.blockers} 个团队卡点需要你拍板`);
  if (!parts.length) return "今天很清爽，挑一件重要但不紧急的事 deep work，或者早点收工。";
  return parts.join("；") + "。";
}

router.get("/overview/suggestion", async (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const projects = db.prepare("SELECT * FROM projects").all();
  const allPhases = db.prepare("SELECT * FROM project_phases").all();
  const phasesByProj = {};
  for (const p of allPhases) (phasesByProj[p.project_id] ||= []).push(p);
  const riskNames = projects
    .map((p) => enrichProject(p, phasesByProj[p.id] || []))
    .filter((p) => p.status === "at_risk" || p.status === "overdue")
    .map((p) => p.name);

  const pendingEmails = db.prepare("SELECT subject, sender, priority FROM emails WHERE needs_action=1 AND source='outlook' ORDER BY (priority='high') DESC, received_at DESC").all();
  const meetings = db.prepare("SELECT title, start_at FROM calendars WHERE day=? ORDER BY start_at").all(today);
  const reports = db.prepare("SELECT blockers FROM dingtalk_reports WHERE report_date=?").all(today);
  let blockerCount = 0;
  for (const r of reports) { try { blockerCount += JSON.parse(r.blockers).length; } catch { /* ignore */ } }

  const summary = {
    date: today,
    riskProjects: riskNames.length,
    riskNames,
    pendingEmails: pendingEmails.length,
    pendingTop: pendingEmails.slice(0, 3).map((e) => ({ subject: e.subject, sender: e.sender, priority: e.priority })),
    meetingCount: meetings.length,
    firstMeetings: meetings.slice(0, 2).map((m) => ({ title: m.title, time: fmt(m.start_at) })),
    blockers: blockerCount,
    openTodos: db.prepare("SELECT COUNT(*) c FROM todos WHERE status!='done'").get().c,
  };

  const force = req.query.force === "1";
  const feedback = req.query.feedback || "";
  if (!force && suggestionCache.text && Date.now() - suggestionCache.ts < SUGGESTION_TTL) {
    return res.json({ suggestion: suggestionCache.text, cached: true });
  }

  let suggestion;
  if (ai.available()) {
    try {
      const r = await ai.dailySuggestion(summary, feedback);
      suggestion = (r && (r.suggestion || r.text)) || buildFallback(summary);
    } catch {
      suggestion = buildFallback(summary);
    }
  } else {
    suggestion = buildFallback(summary);
  }
  suggestionCache.text = suggestion;
  suggestionCache.ts = Date.now();
  res.json({ suggestion, cached: false });
});

export default router;
