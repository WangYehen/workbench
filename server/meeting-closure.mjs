import crypto from "node:crypto";
import { getDb } from "./db.mjs";
import { ai as defaultAi } from "./ai.mjs";

const ITEM_KINDS = new Set(["action", "decision", "risk"]);
const ITEM_STATES = new Set(["draft", "selected", "ignored", "created", "failed"]);
const PRIORITIES = new Set(["P0", "P1", "P2"]);
const PRIORITY_NUMBERS = { P0: "40", P1: "30", P2: "20" };

function nowIso(now) { return now().toISOString(); }
function array(value) { return Array.isArray(value) ? value : []; }
function valueAt(value, paths, fallback = null) {
  for (const path of paths) {
    let current = value;
    for (const part of path.split(".")) current = current?.[part];
    if (current != null && current !== "") return current;
  }
  return fallback;
}
function json(value, fallback = []) { try { return JSON.parse(value || ""); } catch { return fallback; } }
function clean(value, fallback = "") { return String(value ?? fallback).replace(/\s+/g, " ").trim(); }
function minutesId(raw) { return String(valueAt(raw, ["taskUuid", "taskUUID", "taskId", "id", "uuid"], "")); }
function dateIso(days = 0, now = new Date()) { const d = new Date(now); d.setDate(d.getDate() + days); return d.toISOString(); }

function meetingFrom(raw) {
  const basic = raw?.basic || raw?.data?.basic || raw;
  const summaryValue = valueAt(raw, ["summary.content", "summary", "data.summary.content", "data.summary", "abstract", "meetingSummary"], "");
  const keywords = array(valueAt(raw, ["keywords", "data.keywords", "keywordList"], []))
    .map((item) => clean(typeof item === "string" ? item : valueAt(item, ["name", "keyword", "text"], ""))).filter(Boolean);
  const id = minutesId(basic) || minutesId(raw);
  return {
    minutesId: id,
    title: clean(valueAt(basic, ["title", "name", "meetingTitle"], "未命名会议")),
    meetingAt: valueAt(basic, ["startTime", "startAt", "createTime", "createdAt", "time"], null),
    organizer: clean(valueAt(basic, ["creatorName", "organizerName", "creator.nick", "creator", "ownerName"], "")),
    summary: clean(typeof summaryValue === "string" ? summaryValue : valueAt(summaryValue, ["content", "text"], "")),
    keywords,
    sourceUrl: valueAt(basic, ["url", "shareUrl", "link"], null),
  };
}

function nativeItems(raw) {
  const list = array(valueAt(raw, ["actionItems", "items", "data.actionItems", "data.items", "result.items"], []));
  return list.map((item) => ({
    title: clean(typeof item === "string" ? item : valueAt(item, ["title", "content", "text", "name"], "")),
    note: clean(typeof item === "object" ? valueAt(item, ["description", "note", "detail"], "") : ""),
    assigneeName: clean(typeof item === "object" ? valueAt(item, ["assigneeName", "ownerName", "executorName"], "") : ""),
    dueDate: valueAt(item, ["dueDate", "deadline", "due"], null),
  })).filter((item) => item.title);
}

export function createMeetingClosureService({ database = getDb, dwsClient, aiService = defaultAi, now = () => new Date() } = {}) {
  const previews = new Map();
  function db() { return database(); }
  function detail(id) {
    const meeting = db().prepare("SELECT * FROM meeting_closures WHERE id=? OR minutes_id=?").get(id, id);
    if (!meeting) return null;
    const items = db().prepare("SELECT * FROM meeting_closure_items WHERE meeting_id=? ORDER BY CASE kind WHEN 'risk' THEN 0 WHEN 'decision' THEN 1 ELSE 2 END, created_at").all(meeting.id);
    return { ...meeting, keywords: json(meeting.keywords_json), aiMeta: json(meeting.ai_meta_json, null), items };
  }
  function refreshStatus(meetingId) {
    const rows = db().prepare("SELECT status FROM meeting_closure_items WHERE meeting_id=?").all(meetingId);
    const status = rows.some((row) => row.status === "failed") ? "failed" : rows.some((row) => ["draft", "selected"].includes(row.status)) ? "pending" : "processed";
    db().prepare("UPDATE meeting_closures SET status=?,updated_at=? WHERE id=?").run(status, nowIso(now), meetingId);
  }
  function list(view = "pending") {
    const items = db().prepare(`SELECT m.*, COUNT(i.id) item_count,
      SUM(CASE WHEN i.status IN ('draft','selected') THEN 1 ELSE 0 END) open_count,
      SUM(CASE WHEN i.status='failed' THEN 1 ELSE 0 END) failed_count
      FROM meeting_closures m LEFT JOIN meeting_closure_items i ON i.meeting_id=m.id
      GROUP BY m.id ORDER BY CASE m.status WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, COALESCE(m.meeting_at,m.updated_at) DESC`).all();
    return items.filter((item) => view === "all" || item.status === view).map((item) => ({ ...item, keywords: json(item.keywords_json) }));
  }
  async function currentUser() {
    const { data } = await dwsClient.read(["contact", "user", "get-self"]);
    const id = valueAt(data, ["userId", "userid", "result.userId", "result.userid", "data.userId"]);
    const name = valueAt(data, ["name", "nick", "result.name", "result.nick", "data.name"], "当前用户");
    if (!id) throw Object.assign(new Error("无法识别当前 DWS 用户，无法创建待办。"), { code: "DWS_CURRENT_USER_MISSING" });
    return { id: String(id), name: String(name) };
  }
  async function save(raw, { sourceUrl = null, enrich = true } = {}) {
    const meeting = meetingFrom(raw);
    if (!meeting.minutesId) throw Object.assign(new Error("听记未返回有效 ID，无法导入。"), { code: "MINUTES_ID_MISSING" });
    const stamp = nowIso(now); const id = `mc_${meeting.minutesId}`;
    db().prepare(`INSERT INTO meeting_closures(id,minutes_id,title,meeting_at,organizer,summary,keywords_json,source_url,status,ai_meta_json,sync_error,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(minutes_id) DO UPDATE SET title=excluded.title,meeting_at=excluded.meeting_at,organizer=excluded.organizer,summary=excluded.summary,keywords_json=excluded.keywords_json,source_url=COALESCE(excluded.source_url,meeting_closures.source_url),sync_error=NULL,updated_at=excluded.updated_at`)
      .run(id, meeting.minutesId, meeting.title, meeting.meetingAt, meeting.organizer, meeting.summary, JSON.stringify(meeting.keywords), sourceUrl || meeting.sourceUrl, "pending", null, null, stamp, stamp);
    const native = array(raw.__nativeActionItems);
    for (const item of native) insertItem(id, { ...item, kind: "action" });
    if (enrich && aiService?.available?.()) {
      const analysis = await aiService.analyzeMeetingClosure({ ...meeting, nativeActionItems: native });
      for (const title of array(analysis.decisions)) insertItem(id, { kind: "decision", title });
      for (const title of array(analysis.risks)) insertItem(id, { kind: "risk", title, priority: "P1" });
      db().prepare("UPDATE meeting_closures SET ai_meta_json=?,updated_at=? WHERE id=?").run(JSON.stringify(analysis.aiMeta || null), stamp, id);
    }
    refreshStatus(id);
    return detail(id);
  }
  function insertItem(meetingId, input) {
    const title = clean(input.title); if (!title) return;
    const stamp = nowIso(now); const priority = PRIORITIES.has(input.priority) ? input.priority : input.kind === "risk" ? "P1" : "P2";
    db().prepare(`INSERT INTO meeting_closure_items(id,meeting_id,kind,title,note,assignee_id,assignee_name,due_date,priority,status,external_task_id,result_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'draft',NULL,NULL,?,?) ON CONFLICT(meeting_id,kind,title) DO NOTHING`)
      .run(crypto.randomUUID(), meetingId, ITEM_KINDS.has(input.kind) ? input.kind : "action", title, clean(input.note), input.assigneeId || null, input.assigneeName || null, input.dueDate || null, priority, stamp, stamp);
  }
  async function loadMinutes(id, sourceUrl = null) {
    const [detailResult, actionResult] = await Promise.all([
      dwsClient.read(["minutes", "+detail", "--id", id, "--artifacts", "basic,summary,keywords"]),
      dwsClient.read(["minutes", "+action-items", "--id", id]),
    ]);
    const raw = { ...(detailResult.data || {}), __nativeActionItems: nativeItems(actionResult.data) };
    return save(raw, { sourceUrl });
  }
  async function syncRecent() {
    await dwsClient.currentProfile();
    const { data, ledger } = await dwsClient.read(["minutes", "+search", "--scope", "all", "--start", dateIso(-7, now()), "--end", dateIso(0, now()), "--page-all"]);
    const candidates = array(valueAt(data, ["items", "data.items", "result.items", "meetings"], []));
    const results = [];
    for (const candidate of candidates) {
      const id = minutesId(candidate); if (!id) continue;
      try { results.push(await loadMinutes(id, valueAt(candidate, ["url", "shareUrl"], null))); }
      catch (error) { results.push({ minutesId: id, error: error.message }); }
    }
    return { count: results.filter((item) => !item.error).length, results, partial: Boolean(ledger?.partial), failures: ledger?.failures || [] };
  }
  async function importMeeting(input) {
    const text = clean(input);
    const id = /^[\w-]{8,}$/.test(text) ? text : (text.match(/[?&](?:taskUuid|taskId|id)=([\w-]+)/i)?.[1] || "");
    if (!id) throw Object.assign(new Error("请输入有效的听记 ID、包含 taskUuid 的钉钉听记链接，或使用标题搜索。"), { code: "INVALID_MINUTES_REFERENCE" });
    return loadMinutes(id, /^https?:\/\//i.test(text) ? text : null);
  }
  async function search(query) {
    if (!clean(query)) throw Object.assign(new Error("请输入会议标题关键词。"), { code: "QUERY_REQUIRED" });
    const { data, ledger } = await dwsClient.read(["minutes", "+search", "--scope", "all", "--query", query, "--page-all"]);
    return { items: array(valueAt(data, ["items", "data.items", "result.items"], [])).map(meetingFrom).filter((item) => item.minutesId), partial: Boolean(ledger?.partial) };
  }
  function patchItem(id, patch) {
    const item = db().prepare("SELECT * FROM meeting_closure_items WHERE id=?").get(id);
    if (!item) throw Object.assign(new Error("未找到会议事项"), { code: "NOT_FOUND" });
    if (patch.kind && !ITEM_KINDS.has(patch.kind)) throw new Error("不支持的事项类型");
    if (patch.status && !ITEM_STATES.has(patch.status)) throw new Error("不支持的事项状态");
    if (patch.priority && !PRIORITIES.has(patch.priority)) throw new Error("不支持的优先级");
    db().prepare(`UPDATE meeting_closure_items SET title=COALESCE(?,title),note=COALESCE(?,note),assignee_id=COALESCE(?,assignee_id),assignee_name=COALESCE(?,assignee_name),due_date=COALESCE(?,due_date),priority=COALESCE(?,priority),status=COALESCE(?,status),updated_at=? WHERE id=?`)
      .run(patch.title == null ? null : clean(patch.title), patch.note == null ? null : clean(patch.note), patch.assigneeId, patch.assigneeName, patch.dueDate, patch.priority, patch.status, nowIso(now), id);
    refreshStatus(item.meeting_id); return db().prepare("SELECT * FROM meeting_closure_items WHERE id=?").get(id);
  }
  async function previewCreate(meetingId, ids) {
    const user = await currentUser();
    const items = db().prepare(`SELECT * FROM meeting_closure_items WHERE meeting_id=? AND id IN (${array(ids).map(() => "?").join(",") || "''"})`).all(meetingId, ...array(ids));
    const eligible = items.filter((item) => ["draft", "selected", "failed"].includes(item.status));
    if (!eligible.length) throw Object.assign(new Error("请选择至少一条可创建的行动项。"), { code: "NO_ELIGIBLE_ITEMS" });
    const payload = eligible.map((item) => ({ ...item, assignee_id: item.assignee_id || user.id, assignee_name: item.assignee_name || user.name }));
    const preview = { id: `meeting_preview_${crypto.randomUUID()}`, meetingId, items: payload, expiresAt: Date.now() + 10 * 60 * 1000 };
    previews.set(preview.id, preview); return preview;
  }
  async function confirmCreate(meetingId, { previewId, confirmed }) {
    const preview = previews.get(previewId);
    if (!confirmed || !preview || preview.meetingId !== meetingId || preview.expiresAt < Date.now()) throw Object.assign(new Error("预览已失效或尚未确认，请重新预览。"), { code: "DWS_CONFIRMATION_REQUIRED" });
    previews.delete(previewId); const results = [];
    for (const item of preview.items) {
      if (item.external_task_id) { results.push({ id: item.id, status: "created", taskId: item.external_task_id, duplicate: true }); continue; }
      try {
        const args = ["todo", "task", "create", "--title", item.title, "--executors", item.assignee_id, "--priority", PRIORITY_NUMBERS[item.priority] || "20"];
        if (item.due_date) args.push("--due", item.due_date);
        const created = await dwsClient.read(args); const taskId = String(valueAt(created.data, ["taskId", "todoTaskId", "result.taskId", "data.taskId", "id"], ""));
        if (!taskId) throw new Error("钉钉未返回待办 ID");
        await dwsClient.read(["todo", "task", "get", "--task-id", taskId]);
        const stamp = nowIso(now);
        db().prepare("UPDATE meeting_closure_items SET assignee_id=?,assignee_name=?,status='created',external_task_id=?,result_json=?,updated_at=? WHERE id=?")
          .run(item.assignee_id, item.assignee_name, taskId, JSON.stringify({ taskId, verified: true }), stamp, item.id);
        db().prepare(`INSERT INTO todos(id,title,note,status,priority,due_date,created_at,completed_at,source_type,source_id,project_id,assignee_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_type,source_id) DO NOTHING`)
          .run(`t${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`, item.title, item.note || "来自会议闭环", "inbox", item.priority, item.due_date, stamp, null, "meeting_closure", item.id, null, item.assignee_id);
        results.push({ id: item.id, status: "created", taskId });
      } catch (error) {
        db().prepare("UPDATE meeting_closure_items SET status='failed',result_json=?,updated_at=? WHERE id=?").run(JSON.stringify({ error: error.message, code: error.code || null }), nowIso(now), item.id);
        results.push({ id: item.id, status: "failed", error: error.message });
      }
    }
    refreshStatus(meetingId); return { results, meeting: detail(meetingId) };
  }
  return { list, detail, syncRecent, importMeeting, search, patchItem, previewCreate, confirmCreate, loadMinutes };
}
