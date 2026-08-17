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

// ---------------------------------------------------------------------------
// 日志模板（手动维护，替代旧的“调钉钉接口查全部模板 + 勾选”方案）
// 同步时按 report_templates 中 enabled=1 的模板名称（template_name）服务端过滤拉取。
// ---------------------------------------------------------------------------

// 列出全部手动维护的日志模板
router.get("/report-templates", (req, res) => {
  const db = getDb();
  const templates = db
    .prepare("SELECT id, name, enabled, created_at, updated_at FROM report_templates ORDER BY id")
    .all();
  res.json({ templates });
});

// 新增模板（仅需模板名称；名称必填、去重）
router.post("/report-templates", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "模板名称不能为空" });
  if (name.length > 100) return res.status(400).json({ error: "模板名称过长" });
  const db = getDb();
  if (db.prepare("SELECT 1 FROM report_templates WHERE name=?").get(name)) {
    return res.status(409).json({ error: "同名模板已存在" });
  }
  const now = new Date().toISOString();
  const r = db
    .prepare("INSERT INTO report_templates(name, enabled, created_at, updated_at) VALUES(?,1,?,?)")
    .run(name, now, now);
  const row = db
    .prepare("SELECT id, name, enabled, created_at, updated_at FROM report_templates WHERE id=?")
    .get(r.lastInsertRowid);
  res.status(201).json({ ok: true, template: row });
});

// 修改模板（可改名称和/或启用状态）
router.put("/report-templates/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "模板 ID 非法" });
  const db = getDb();
  const old = db.prepare("SELECT * FROM report_templates WHERE id=?").get(id);
  if (!old) return res.status(404).json({ error: "模板不存在" });
  const body = req.body || {};
  const sets = [];
  const vals = [];
  if ("name" in body) {
    const name = String(body.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "模板名称不能为空" });
    if (name.length > 100) return res.status(400).json({ error: "模板名称过长" });
    if (db.prepare("SELECT 1 FROM report_templates WHERE name=? AND id<>?").get(name, id)) {
      return res.status(409).json({ error: "同名模板已存在" });
    }
    sets.push("name=?");
    vals.push(name);
  }
  if ("enabled" in body) {
    sets.push("enabled=?");
    vals.push(body.enabled ? 1 : 0);
  }
  if (!sets.length) return res.status(400).json({ error: "没有可更新的字段" });
  sets.push("updated_at=?");
  vals.push(new Date().toISOString());
  vals.push(id);
  db.prepare(`UPDATE report_templates SET ${sets.join(", ")} WHERE id=?`).run(...vals);
  const row = db
    .prepare("SELECT id, name, enabled, created_at, updated_at FROM report_templates WHERE id=?")
    .get(id);
  res.json({ ok: true, template: row });
});

// 删除模板
router.delete("/report-templates/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "模板 ID 非法" });
  const db = getDb();
  const r = db.prepare("DELETE FROM report_templates WHERE id=?").run(id);
  if (!r.changes) return res.status(404).json({ error: "模板不存在" });
  res.json({ ok: true });
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
