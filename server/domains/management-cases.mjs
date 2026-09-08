import crypto from "node:crypto";
import { enrichProject } from "./project-status.mjs";

const STATES = new Set(["decision_needed", "in_progress", "waiting", "delegated", "resolved"]);
const PRIORITIES = new Set(["P0", "P1", "P2"]);
function parse(value, fallback = []) { try { return JSON.parse(value || ""); } catch { return fallback; } }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function addDays(date, count) { const value = new Date(`${date}T00:00:00+08:00`); value.setUTCDate(value.getUTCDate() + count); return value.toISOString().slice(0, 10); }
function rank(priority) { return { P0: 0, P1: 1, P2: 2 }[priority] ?? 3; }
function actionFor(category) { return ({ execution_risk: "指派或调整截止日", team_blocker: "确认解决路径", project_risk: "制定缓解方案", decision_needed: "处理或委派", meeting_follow_up: "准备会议" }[category] || "查看详情"); }

export function createManagementCases({ database, now = () => new Date() }) {
  function db() { return database(); }
  function upsert(candidate) {
    const stamp = now().toISOString(); const sourceHash = hash(candidate.key);
    db().prepare(`INSERT INTO management_cases(id,category,state,priority,title,management_summary,owner_id,owner_name,due_at,project_id,source_hash,created_at,updated_at,resolved_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(source_hash) DO UPDATE SET category=excluded.category,priority=excluded.priority,title=excluded.title,management_summary=excluded.management_summary,owner_id=COALESCE(excluded.owner_id,management_cases.owner_id),owner_name=COALESCE(excluded.owner_name,management_cases.owner_name),due_at=COALESCE(excluded.due_at,management_cases.due_at),project_id=COALESCE(excluded.project_id,management_cases.project_id),updated_at=excluded.updated_at`)
      .run(crypto.randomUUID(), candidate.category, "decision_needed", candidate.priority, candidate.title, candidate.summary, candidate.ownerId || null, candidate.ownerName || null, candidate.dueAt || null, candidate.projectId || null, sourceHash, stamp, stamp);
    const item = db().prepare("SELECT * FROM management_cases WHERE source_hash=?").get(sourceHash);
    db().prepare(`INSERT INTO management_case_evidence(id,case_id,source_type,source_id,role,excerpt,occurred_at,created_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(case_id,source_type,source_id) DO UPDATE SET excerpt=excluded.excerpt,occurred_at=excluded.occurred_at`)
      .run(crypto.randomUUID(), item.id, candidate.sourceType, candidate.sourceId, "primary", candidate.excerpt || null, candidate.occurredAt || stamp, stamp);
    return item;
  }
  function refresh(date) {
    const dueSoon = addDays(date, 2);
    for (const todo of db().prepare("SELECT * FROM todos WHERE status!='done' AND due_date IS NOT NULL AND due_date!='' AND due_date<=?").all(dueSoon)) {
      const overdue = todo.due_date < date;
      upsert({ key: `todo:${todo.id}`, category: "execution_risk", priority: overdue ? "P0" : todo.priority || "P1", title: todo.title, summary: overdue ? `待办已逾期，原截止日为 ${todo.due_date}。` : `待办将在 ${todo.due_date} 前到期。`, dueAt: todo.due_date, projectId: todo.project_id, sourceType: "todo", sourceId: todo.id, excerpt: todo.note, occurredAt: todo.due_date });
    }
    for (const email of db().prepare("SELECT * FROM emails WHERE needs_action=1 AND source='outlook' AND (importance='high' OR priority='high')").all()) {
      upsert({ key: `email:${email.id}`, category: "decision_needed", priority: "P0", title: email.subject, summary: "高优先级邮件仍待处理。", dueAt: email.due_at ? String(email.due_at).slice(0, 10) : null, sourceType: "outlook", sourceId: email.id, excerpt: [email.sender, email.priority_reason].filter(Boolean).join(" · "), occurredAt: email.received_at });
    }
    for (const report of db().prepare("SELECT * FROM dingtalk_reports WHERE report_date=?").all(date)) {
      const entries = [...parse(report.blockers), ...parse(report.needs_review)];
      entries.forEach((text, index) => upsert({ key: `report:${report.id}:${index}:${text}`, category: "team_blocker", priority: index < parse(report.blockers).length ? "P0" : "P1", title: String(text), summary: `${report.user_name || "成员"} 在日志中提出需要主管关注的事项。`, ownerId: report.user_id, ownerName: report.user_name, dueAt: date, sourceType: "report", sourceId: `${report.id}:${index}`, excerpt: String(text), occurredAt: report.report_date }));
    }
    const phases = db().prepare("SELECT * FROM project_phases").all(); const byProject = new Map();
    for (const phase of phases) { if (!byProject.has(phase.project_id)) byProject.set(phase.project_id, []); byProject.get(phase.project_id).push(phase); }
    for (const project of db().prepare("SELECT * FROM projects").all().map((item) => enrichProject(item, byProject.get(item.id) || [], date))) {
      if (project.status !== "at_risk" && project.status !== "overdue") continue;
      upsert({ key: `project:${project.id}:${project.status}`, category: "project_risk", priority: project.status === "overdue" ? "P0" : "P1", title: project.name, summary: `${project.owner || "未设置负责人"}负责，当前进度 ${project.progress}% ，状态为${project.status === "overdue" ? "已逾期" : "存在风险"}。`, ownerName: project.owner, projectId: project.id, sourceType: "project", sourceId: project.id, occurredAt: date });
    }
    for (const meeting of db().prepare("SELECT * FROM calendars WHERE day=?").all(date)) {
      upsert({ key: `calendar:${meeting.id}:${date}`, category: "meeting_follow_up", priority: "P2", title: meeting.title, summary: "今日会议，请确认会前准备和会后行动项。", dueAt: date, sourceType: "calendar", sourceId: meeting.id, excerpt: meeting.location || "", occurredAt: meeting.start_at });
    }
  }
  function list(filters = {}) {
    const clauses = []; const values = [];
    if (filters.state) { clauses.push("state=?"); values.push(filters.state); }
    if (filters.category) { clauses.push("category=?"); values.push(filters.category); }
    if (filters.ownerId) { clauses.push("owner_id=?"); values.push(filters.ownerId); }
    const items = db().prepare(`SELECT * FROM management_cases ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, COALESCE(due_at,'9999-12-31'), updated_at DESC`).all(...values);
    return items.map((item) => ({ ...item, recommendedAction: actionFor(item.category) }));
  }
  function detail(id) {
    const item = db().prepare("SELECT * FROM management_cases WHERE id=?").get(id); if (!item) return null;
    const evidence = db().prepare("SELECT * FROM management_case_evidence WHERE case_id=? ORDER BY occurred_at DESC").all(id);
    const actions = db().prepare("SELECT id,action_type,status,external_id,created_at,executed_at FROM management_case_actions WHERE case_id=? ORDER BY created_at DESC").all(id);
    return { ...item, recommendedAction: actionFor(item.category), evidence, actions };
  }
  function update(id, patch) {
    const item = detail(id); if (!item) return null;
    if (patch.state && !STATES.has(patch.state)) throw new Error("不支持的管理事项状态");
    if (patch.priority && !PRIORITIES.has(patch.priority)) throw new Error("不支持的优先级");
    const resolvedAt = patch.state === "resolved" ? now().toISOString() : item.resolved_at;
    db().prepare("UPDATE management_cases SET state=COALESCE(?,state),priority=COALESCE(?,priority),owner_id=COALESCE(?,owner_id),owner_name=COALESCE(?,owner_name),due_at=COALESCE(?,due_at),management_summary=COALESCE(?,management_summary),resolved_at=?,updated_at=? WHERE id=?")
      .run(patch.state, patch.priority, patch.ownerId, patch.ownerName, patch.dueAt, patch.managementSummary, resolvedAt, now().toISOString(), id);
    return detail(id);
  }
  function recordActionPreview(caseId, preview, actionType) {
    const id = crypto.randomUUID(); const stamp = now().toISOString(); const idempotencyKey = crypto.randomUUID();
    db().prepare("INSERT INTO management_case_actions(id,case_id,action_type,payload_json,status,preview_id,idempotency_key,external_id,result_json,created_at,executed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, caseId, actionType, JSON.stringify(preview.payload), "previewed", preview.id, idempotencyKey, null, null, stamp, null);
    return { id, idempotencyKey, previewId: preview.id };
  }
  function recordActionResult(idempotencyKey, { status, result = null, externalId = null }) {
    db().prepare("UPDATE management_case_actions SET status=?,external_id=?,result_json=?,executed_at=? WHERE idempotency_key=?")
      .run(status, externalId, JSON.stringify(result), now().toISOString(), idempotencyKey);
  }
  function dashboard(date) {
    refresh(date); const items = list({});
    const open = items.filter((item) => item.state !== "resolved");
    return { date, total: open.length, updatedAt: now().toISOString(), completeness: { local: "complete", dws: "not_synced" }, groups: {
      decisionNeeded: open.filter((item) => item.state === "decision_needed").slice(0, 5),
      risks: open.filter((item) => ["execution_risk", "team_blocker", "project_risk"].includes(item.category)).slice(0, 5),
      responsibility: [...new Map(open.filter((item) => item.owner_name).map((item) => [item.owner_name, item])).values()].slice(0, 5),
      actions: [...open].sort((a, b) => rank(a.priority) - rank(b.priority)).slice(0, 5),
    } };
  }
  return { refresh, list, detail, update, recordActionPreview, recordActionResult, dashboard };
}
