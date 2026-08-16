import express from "express";
import { getDb, getRosterBaseline } from "../db.mjs";
import { dingtalk } from "../dingtalk.mjs";

const router = express.Router();

router.get("/members", (req, res) => {
  const db = getDb();
  res.json({ items: db.prepare("SELECT * FROM dingtalk_members").all() });
});

router.get("/reports", (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = db.prepare("SELECT * FROM dingtalk_reports WHERE report_date=? ORDER BY user_name").all(date);
  // 未提交基线：历史真实提交人；当日未在 dingtalk_reports 中即未提交。
  const baseline = getRosterBaseline(db);
  const submittedIds = new Set(rows.map((r) => r.user_id || r.user_name));
  const notSubmitted = baseline
    .filter((m) => !submittedIds.has(m.key))
    .map((m) => ({ user_id: m.key, name: m.name, dept_name: "" }));
  res.json({
    date,
    reports: rows.map((r) => ({
      ...r,
      blockers: safeJson(r.blockers),
      needs_review: safeJson(r.needs_review),
    })),
    submitted: rows.length,
    notSubmitted,
    configured: dingtalk.isConfigured(),
  });
});

router.post("/sync/reports", async (req, res) => {
  if (!dingtalk.isConfigured()) return res.status(400).json({ error: "钉钉未配置" });
  try {
    const date = req.body.date || new Date().toISOString().slice(0, 10);
    const items = await dingtalk.syncReports(date);
    res.json({ ok: true, count: items.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 拉取钉钉企业内全部日志模板（供页面勾选）
router.get("/dingtalk-templates", async (req, res) => {
  if (!dingtalk.isConfigured()) return res.status(400).json({ error: "钉钉未配置" });
  try {
    const templates = await dingtalk.fetchReportTemplates();
    res.json({ templates });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 读取已配置的「要拉取哪些模板」
router.get("/report-templates", (req, res) => {
  const db = getDb();
  const sel = db.prepare("SELECT value_json FROM sync_state WHERE key=?").get("selected_template_ids");
  const known = db.prepare("SELECT value_json FROM sync_state WHERE key=?").get("known_templates");
  res.json({
    selected: sel ? JSON.parse(sel.value_json) : [],
    known: known ? JSON.parse(known.value_json) : [],
  });
});

// 保存要拉取的模板 ID 列表
router.post("/report-templates", (req, res) => {
  const ids = Array.isArray(req.body.templateIds) ? req.body.templateIds.map(String) : [];
  const db = getDb();
  db.prepare(
    "INSERT INTO sync_state(key, value_json) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
  ).run("selected_template_ids", JSON.stringify(ids));
  res.json({ ok: true, selected: ids });
});

function safeJson(v) {
  try { return JSON.parse(v); } catch { return []; }
}

// 团队负载聚合：按真实提交人统计提交、阻塞、待审、负载指数（日期可指定，默认最近有日志日）
router.get("/load", (req, res) => {
  const db = getDb();
  const latestRow = db.prepare("SELECT MAX(report_date) mx FROM dingtalk_reports").get();
  const latest = latestRow?.mx;
  const today = new Date().toISOString().slice(0, 10);
  // 有效日期：传入优先；否则取最近有日志的日期（历史数据下避免页面恒空）。该日无日志则回退最近有日志日。
  let date = req.query.date || latest || today;
  if (!db.prepare("SELECT 1 FROM dingtalk_reports WHERE report_date=? LIMIT 1").get(date) && latest) date = latest;

  const reports = db.prepare("SELECT * FROM dingtalk_reports WHERE report_date=?").all(date);
  // 按真实提交人聚合：user_id 可能为空，用 user_name 兜底；同一人可能有多条日志则合并卡点/待审。
  const byUser = new Map();
  for (const r of reports) {
    const key = r.user_id || r.user_name;
    if (!byUser.has(key)) {
      byUser.set(key, { user_id: key, name: r.user_name, dept_name: r.dept_name || "", submitted: true, blockers: [], review: [] });
    }
    const cur = byUser.get(key);
    cur.blockers.push(...safeJson(r.blockers));
    cur.review.push(...safeJson(r.needs_review));
  }
  const items = [...byUser.values()]
    .map((m) => ({ ...m, load: m.blockers.length * 2 + m.review.length }))
    .sort((a, b) => b.load - a.load || a.name.localeCompare(b.name));

  // 未提交：历史真实提交人基线中，当日未出现在 dingtalk_reports 者。
  const baseline = getRosterBaseline(db);
  const submittedKeys = new Set(items.map((m) => m.user_id));
  const notSubmitted = baseline
    .filter((m) => !submittedKeys.has(m.key))
    .map((m) => ({ user_id: m.key, name: m.name }));

  const summary = {
    total: items.length,
    submitted: items.length,
    risk: items.filter((i) => i.blockers.length > 0).length,
    overloaded: items.filter((i) => i.load >= 4).length,
    notSubmitted: notSubmitted.length,
  };
  res.json({ date, members: items, notSubmitted, summary });
});

export default router;
