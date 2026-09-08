import express from "express";
import { getDb } from "../db.mjs";
import { dingtalk } from "../integrations/dingtalk.mjs";
import { localDateString, resolveDateKey } from "../core/local-date.mjs";
import { buildTeamPulse } from "../domains/workbench-domain.mjs";

const router = express.Router();

router.get("/members", (req, res) => {
  const db = getDb();
  res.json({ items: db.prepare("SELECT * FROM dingtalk_members").all() });
});

router.get("/reports", (req, res) => {
  const db = getDb();
  let date;
  try { date = resolveDateKey(req.query.date); } catch (error) { return res.status(400).json({ error: error.message }); }
  const rows = db.prepare("SELECT * FROM dingtalk_reports WHERE report_date=? ORDER BY user_name").all(date);
  const pulse = buildTeamPulse(db, date);
  const lastSyncRow = db.prepare("SELECT value_json FROM sync_state WHERE key='reports_last_sync_at'").get();
  const lastSyncAt = lastSyncRow ? (JSON.parse(lastSyncRow.value_json)?.at || "") : "";
  res.json({
    date,
    reports: rows.map((r) => ({
      ...r,
      blockers: safeJson(r.blockers),
      needs_review: safeJson(r.needs_review),
    })),
    submitted: pulse.submittedUnique,
    rosterTotal: pulse.rosterTotal,
    notSubmitted: pulse.missing,
    configured: dingtalk.isConfigured(),
    lastSyncAt,
  });
});

router.post("/sync/reports", async (req, res) => {
  if (!dingtalk.isConfigured()) return res.status(400).json({ error: "钉钉未配置" });
  try {
    const date = resolveDateKey(req.body.date);
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

router.get("/pulse", (req, res) => {
  try { res.json(buildTeamPulse(getDb(), resolveDateKey(req.query.date))); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

// 兼容旧团队负载接口：语义已调整为“团队态势”，不再回退到其他日期。
router.get("/load", (req, res) => {
  try {
    const pulse = buildTeamPulse(getDb(), resolveDateKey(req.query.date));
    res.json({ date: pulse.date, members: pulse.members.map((member) => ({ ...member, load: member.signalScore })), notSubmitted: pulse.missing, summary: pulse.summary });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

export default router;
