import express from "express";
import { config, configured } from "../config.mjs";
import { dingtalk } from "../dingtalk.mjs";
import { getDb } from "../db.mjs";
import { ai } from "../ai.mjs";
import { resolveDateKey } from "../local-date.mjs";
import { buildDashboard } from "../workbench-domain.mjs";

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
    displayName: config.displayName,
  });
});

router.get("/overview", (req, res) => {
  try {
    const dashboard = buildDashboard(getDb(), resolveDateKey(req.query.date));
    res.json({
      date: dashboard.date,
      pendingEmails: dashboard.attention.filter((item) => item.kind === "email"),
      meetings: dashboard.meetings,
      teamBlockers: dashboard.pulse.blockers.map((item) => item.text),
      needReview: dashboard.pulse.reviewRequests.map((item) => item.text),
      notSubmitted: dashboard.pulse.missing.map((item) => item.name),
      openTodos: dashboard.metrics.todos.open,
      riskProjects: dashboard.projects.filter((item) => item.status === "at_risk" || item.status === "overdue"),
      availableDateHint: dashboard.availableDateHint,
    });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// ---- AI 今日工作建议：数据感知 + LLM 生成，带 1h 缓存 ----
const suggestionCache = new Map();
const SUGGESTION_TTL = 3600 * 1000;

function buildFallback(s) {
  const parts = [];
  if (s.riskProjects > 0) parts.push(`有 ${s.riskProjects} 个风险项目在跑，今天优先推进它们，别让进度再滑`);
  if (s.pendingEmails > 0) parts.push(`${s.pendingEmails} 封待处理邮件，先挑高优先级的回掉`);
  if (s.meetingCount > 0) parts.push(`今天 ${s.firstMeetings?.[0]?.time || ""} 的「${s.firstMeetings?.[0]?.title || "会议"}」会前留 30 分钟准备`);
  if (s.blockers > 0) parts.push(`${s.blockers} 个团队卡点需要你拍板`);
  if (s.openTodos > 0) parts.push(`还有 ${s.openTodos} 条未完成待办，先处理最高优先级和已逾期事项`);
  if (!parts.length) return "当前日期没有高优先级注意事项，可以安排一段不被打断的专注时间。";
  return parts.join("；") + "。";
}

router.get("/overview/suggestion", async (req, res) => {
  const db = getDb();
  let date;
  try { date = resolveDateKey(req.query.date); } catch (error) { return res.status(400).json({ error: error.message }); }
  const dashboard = buildDashboard(db, date);
  const riskNames = dashboard.projects.filter((item) => item.status === "at_risk" || item.status === "overdue").map((item) => item.name);
  const emails = dashboard.attention.filter((item) => item.kind === "email");

  const summary = {
    date,
    riskProjects: riskNames.length,
    riskNames,
    pendingEmails: emails.length,
    pendingTop: emails.slice(0, 3).map((item) => ({ subject: item.title, sender: item.detail, priority: item.priority })),
    meetingCount: dashboard.meetings.length,
    firstMeetings: dashboard.meetings.slice(0, 2).map((m) => ({ title: m.title, time: m.start })),
    blockers: dashboard.pulse.blockers.length,
    openTodos: dashboard.metrics.todos.open,
  };

  const force = req.query.force === "1";
  const feedback = req.query.feedback || "";
  const cacheKey = `${date}:${dashboard.inputHash}`;
  const cached = suggestionCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.ts < SUGGESTION_TTL) {
    return res.json({ suggestion: cached.text, cached: true, date, inputHash: dashboard.inputHash, sourceRefs: dashboard.attention.slice(0, 6).map((item) => item.sourceRef), generatedAt: cached.generatedAt });
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
  const generatedAt = new Date().toISOString();
  suggestionCache.set(cacheKey, { text: suggestion, ts: Date.now(), generatedAt });
  res.json({ suggestion, cached: false, date, inputHash: dashboard.inputHash, sourceRefs: dashboard.attention.slice(0, 6).map((item) => item.sourceRef), generatedAt });
});

export default router;
