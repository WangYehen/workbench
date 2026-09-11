import crypto from "node:crypto";
import { getDb } from "../db.mjs";
import { createTodoSyncService } from "./todo-sync.mjs";
import { localDateString } from "../core/local-date.mjs";

const tools = [
  { name: "workbench.dashboard", mode: "read", description: "读取工作台今日概览" },
  { name: "workbench.team_reports", mode: "read", description: "读取指定日期团队日志" },
  { name: "dws.report.list", mode: "read", description: "从钉钉读取指定时间范围的日志（自动翻页）" },
  { name: "dws.report.detail", mode: "read", description: "读取单篇钉钉日志正文" },
  { name: "dws.report.missing", mode: "read", description: "对比团队成员与日报提交名单" },
  { name: "workbench.todos", mode: "read", description: "读取工作台待办" },
  { name: "dws.calendar.agenda", mode: "read", description: "读取钉钉日程" },
  { name: "dws.todo.related", mode: "read", description: "读取与当前用户相关的钉钉待办" },
  { name: "dws.minutes.search", mode: "read", description: "搜索钉钉听记" },
  { name: "dws.chat.search", mode: "read", description: "搜索钉钉消息上下文" },
  { name: "dws.contact.lookup", mode: "read", description: "查询钉钉人员" },
  { name: "dws.calendar.create", mode: "write", description: "创建钉钉日程（需要确认）" },
  { name: "dws.todo.assign", mode: "write", description: "创建并指派钉钉待办（需要确认）" },
  { name: "dws.chat.send", mode: "write", description: "发送钉钉消息（需要确认）" },
  { name: "workbench.persist_management_cases", mode: "write", description: "将阻塞点写入管理事项（需要确认）" },
];

const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
const parse = (value, fallback = []) => { try { return JSON.parse(value || ""); } catch { return fallback; } };
const valueAt = (value, paths, fallback = null) => { for (const path of paths) { let v = value; for (const key of path.split(".")) v = v?.[key]; if (v != null && v !== "") return v; } return fallback; };
function findReportContent(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.report_content)) return value.report_content;
  if (Array.isArray(value.reportContent)) return value.reportContent;
  if (value.result) { const found = findReportContent(value.result); if (found.length) return found; }
  if (value.data) { const found = findReportContent(value.data); if (found.length) return found; }
  return [];
}

export function createDwsAgentTools({ database = getDb, dwsClient, dashboard = null } = {}) {
  const todoSync = createTodoSyncService({ database, dwsClient });
  function db() { return database(); }
  function list() { return tools; }
  async function read(name, args = {}) {
    if (!toolMap.has(name) || toolMap.get(name).mode !== "read") throw Object.assign(new Error(`不可读取工具：${name}`), { code: "DWS_TOOL_NOT_ALLOWED" });
    if (name === "workbench.dashboard") return dashboard?.(args.date) || {};
    if (name === "workbench.team_reports") {
      const date = String(args.date || new Date().toISOString().slice(0, 10)).replace(/^today$/, new Date().toISOString().slice(0, 10));
      const rows = db().prepare("SELECT id,user_id,user_name,dept_name,report_date,template_name,content_json,blockers,needs_review,summary FROM dingtalk_reports WHERE report_date=? ORDER BY user_name").all(date);
      return { date, items: rows.map((row) => ({ ...row, content: parse(row.content_json), blockers: parse(row.blockers), needsReview: parse(row.needs_review) })), complete: true, source: "workbench.dingtalk_reports" };
    }
    if (name === "dws.report.list") {
      let date = String(args.date || localDateString());
      if (date === "today") date = localDateString();
      if (date === "previous_friday") { const d = new Date(); const delta = (d.getUTCDay() + 2) % 7 || 7; d.setUTCDate(d.getUTCDate() - delta); date = d.toISOString().slice(0, 10); }
      const reports = []; let cursor = "0"; let complete = false; let lastLedger = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await dwsClient.read(["report", "+inbox-list", "--start", `${date}T00:00:00+08:00`, "--end", `${date}T23:59:59+08:00`, "--cursor", cursor, "--size", "20"]);
        const payload = result.data?.data || result.data; const pageItems = payload?.reports || payload?.items || payload?.result?.reports || [];
        reports.push(...pageItems); lastLedger = result.ledger;
        const next = payload?.meta?.pagination?.next_token ?? payload?.next_token ?? payload?.nextCursor ?? null;
        if (payload?.meta?.pagination?.endpoint_exhausted === true || !next || String(next) === String(cursor) || pageItems.length === 0) { complete = true; break; }
        cursor = String(next);
      }
      if (args.includeDetails) {
        for (let offset = 0; offset < reports.length; offset += 4) {
          await Promise.all(reports.slice(offset, offset + 4).map(async (report) => {
            if (!report.reportId) return;
            try {
              const detail = await dwsClient.read(["report", "entry", "get", "--report-id", String(report.reportId)]); const fields = findReportContent(detail.data);
              if (!fields.length) throw new Error("DWS 详情响应中没有 report_content 字段");
              report.content = fields.filter((field) => ["今日遗留工作", "需要协作工作", "今日完成工作", "明日工作计划", "完成情况标注"].includes(field.key)).map((field) => ({ key: field.key, value: field.value || "" }));
            } catch (error) { report.detailError = error.message; }
          }));
        }
      }
      return { date, reports, count: reports.length, complete, _ledger: { ...(lastLedger || {}), complete }, source: "dws.report" };
    }
    if (name === "dws.report.detail") {
      if (!args.reportId) throw Object.assign(new Error("缺少 reportId"), { code: "DWS_REPORT_ID_REQUIRED" });
      const result = await dwsClient.read(["report", "entry", "get", "--report-id", String(args.reportId)]);
      return { ...(result.data?.data || result.data), _ledger: result.ledger, source: "dws.report" };
    }
    if (name === "dws.report.missing") {
      const reports = await read("dws.report.list", args);
      const submitted = new Set((reports.reports || []).map((item) => String(item.creatorUserId || item.userId || item.creator_user_id || "")).filter(Boolean));
      const members = db().prepare("SELECT user_id,user_name,dept_name FROM dingtalk_members WHERE enabled=1 ORDER BY user_name").all();
      const missing = members.filter((member) => !submitted.has(String(member.user_id))).map((member) => ({ userId: member.user_id, name: member.user_name, deptName: member.dept_name }));
      return { date: reports.date, submittedCount: submitted.size, memberCount: members.length, missing, complete: reports.complete, source: "dws.report + dingtalk_members", _ledger: reports._ledger };
    }
    if (name === "workbench.todos") return { items: db().prepare("SELECT * FROM todos ORDER BY status, priority, due_date").all(), complete: true };
    const command = {
      "dws.calendar.agenda": ["calendar", "+agenda"],
      "dws.todo.related": ["todo", "+get-related-tasks"],
      "dws.minutes.search": ["minutes", "+search", "--scope", "all", "--query", String(args.query || "")],
      "dws.chat.search": ["chat", "+search-msg", "--query", String(args.query || "")],
      "dws.contact.lookup": ["aisearch", "person", "--query", String(args.query || ""), "--dimension", "name"],
    }[name];
    if (!command) throw Object.assign(new Error(`未实现读取工具：${name}`), { code: "DWS_TOOL_NOT_IMPLEMENTED" });
    const result = await dwsClient.read(command);
    return { ...(result.data?.data || result.data), _ledger: result.ledger };
  }
  function preview(name, args = {}) {
    if (!toolMap.has(name) || toolMap.get(name).mode !== "write") throw Object.assign(new Error(`不可写入工具：${name}`), { code: "DWS_TOOL_NOT_ALLOWED" });
    const id = `agent_preview_${crypto.randomUUID()}`;
    if (name === "workbench.persist_management_cases") {
      const items = Array.isArray(args.items) ? args.items : [];
      return { id, name, kind: "local", payload: { items }, summary: `将写入 ${items.length} 条管理事项`, expiresAt: Date.now() + 10 * 60 * 1000 };
    }
    return { id, name, kind: "dws", payload: args, summary: `将执行 ${name}`, expiresAt: Date.now() + 10 * 60 * 1000 };
  }
  async function execute(name, payload = {}, options = {}) {
    if (name === "workbench.persist_management_cases") {
      const now = new Date().toISOString(); const created = [];
      for (const item of payload.items || []) {
        const sourceId = String(item.sourceId || `${item.ownerId || "unknown"}:${item.title}`);
        const hash = crypto.createHash("sha256").update(`agent:${sourceId}`).digest("hex");
        const id = `mc_${hash.slice(0, 24)}`;
        db().prepare(`INSERT INTO management_cases(id,category,state,priority,title,management_summary,owner_id,owner_name,due_at,project_id,source_hash,created_at,updated_at,resolved_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(source_hash) DO UPDATE SET title=excluded.title,management_summary=excluded.management_summary,priority=excluded.priority,owner_id=COALESCE(excluded.owner_id,management_cases.owner_id),owner_name=COALESCE(excluded.owner_name,management_cases.owner_name),updated_at=excluded.updated_at`)
          .run(id, item.category || "team_blocker", "decision_needed", item.priority || "P1", item.title, item.summary || "", item.ownerId || null, item.ownerName || null, item.dueAt || null, item.projectId || null, hash, now, now);
        const row = db().prepare("SELECT id FROM management_cases WHERE source_hash=?").get(hash);
        db().prepare(`INSERT INTO management_case_evidence(id,case_id,source_type,source_id,role,excerpt,occurred_at,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(case_id,source_type,source_id) DO UPDATE SET excerpt=excluded.excerpt`)
          .run(crypto.randomUUID(), row.id, item.sourceType || "dws.agent", sourceId, "primary", item.excerpt || item.summary || "", item.occurredAt || now, now);
        created.push(row.id);
      }
      return { createdIds: created, verified: true };
    }
    const args = { ...payload };
    if (name === "dws.calendar.create") {
      const command = ["calendar", "event", "create", "--title", String(args.title || "工作会议"), "--start", String(args.start), "--end", String(args.end)];
      if (args.attendees) command.push("--attendees", String(args.attendees));
      const result = await dwsClient.write(command);
      const data = result.data || {}; const externalId = data.id || data.eventId || data.calendarId || data.result?.id;
      if (externalId && args.start) {
        const start = new Date(args.start); const end = args.end ? new Date(args.end) : null; const day = Number.isNaN(start.getTime()) ? String(args.start).slice(0, 10) : start.toISOString().slice(0, 10);
        db().prepare(`INSERT INTO calendars(id,source,title,start_at,end_at,location,organizer,day,raw_json,attendee_count,accepted_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,raw_json=excluded.raw_json`).run(String(externalId), "dws-agent", args.title || "工作会议", args.start, args.end || null, args.location || null, args.organizer || null, day, JSON.stringify(data), Array.isArray(args.attendees) ? args.attendees.length : null, null, new Date().toISOString());
      }
      return { ...data, externalId, verified: Boolean(externalId), _ledger: result.ledger };
    }
    if (name === "dws.todo.assign") {
      return todoSync.create(args, { source: "dws_todo", ...(options.idempotencyKey ? { id: `agent_${options.idempotencyKey}` } : {}) });
    }
    if (name === "dws.chat.send") {
      const result = await dwsClient.write(["chat", "+messages-send", "--content", String(args.content), ...(args.userQuery ? ["--user-query", String(args.userQuery)] : []), ...(args.chatQuery ? ["--chat-query", String(args.chatQuery)] : [])]);
      return { ...result.data, _ledger: result.ledger };
    }
    throw Object.assign(new Error(`未实现写入工具：${name}`), { code: "DWS_TOOL_NOT_IMPLEMENTED" });
  }
  return { list, read, preview, execute };
}
