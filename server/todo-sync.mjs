import crypto from "node:crypto";
import { getDb } from "./db.mjs";

function unwrap(value) {
  for (let i = 0; i < 6 && value && !Array.isArray(value); i++) {
    if (value.taskId || value.userId) break;
    if (value.data != null) value = value.data;
    else if (value.result != null) value = value.result;
    else break;
  }
  return value;
}
function checked(response) {
  const value = response.data;
  if (value?.ok === false || value?.success === false || value?.error || response.ledger?.partial) {
    throw new Error("钉钉未确认操作成功，请检查连接或权限后核验。");
  }
  return unwrap(value);
}
function dueIso(value) {
  if (!value) return null;
  const input = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59+08:00` : value;
  if (typeof input !== "number" && !/(Z|[+-]\d\d:\d\d)$/.test(input)) throw new Error("截止时间需要包含时区");
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) throw new Error("截止时间无效");
  return date.toISOString();
}
function day(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

// Both creation entry points keep a durable local row before the non-idempotent external write.
export function createTodoSyncService({ database = getDb, dwsClient } = {}) {
  const db = () => database();
  const get = (id) => db().prepare("SELECT * FROM todos WHERE id=?").get(id);
  const hasColumn = (name) => db().prepare("PRAGMA table_info(todos)").all().some((column) => column.name === name);
  const markLocal = (id, patch) => {
    const now = new Date().toISOString();
    const status = patch.status;
    const row = get(id);
    if (!row) throw new Error("未找到待办");
    const completedAt = status === "done" ? (row.completed_at || now) : null;
    db().prepare("UPDATE todos SET status=?,completed_at=?,local_updated_at=?,sync_direction='workbench',sync_status=CASE WHEN external_task_id IS NULL THEN sync_status ELSE 'pending' END,sync_error=NULL WHERE id=?")
      .run(status, completedAt, now, id);
    return get(id);
  };
  async function syncFromWorkbench(id, patch = {}) {
    const row = markLocal(id, patch);
    if (!row.external_task_id) return { verified: true, todo: row, externalSkipped: true };
    try {
      const args = ["todo", "+complete", "--task-id", row.external_task_id];
      if (row.status !== "done") args.splice(1, 1, "+reopen");
      if (row.dws_profile) args.push("--profile", row.dws_profile);
      await dwsClient.write(args);
      const result = await verify(id, "dingtalk_readback");
      return { ...result, direction: "workbench" };
    } catch (error) {
      db().prepare("UPDATE todos SET sync_status='error',sync_error=?,sync_direction='workbench',last_sync_at=? WHERE id=?").run(error.message, new Date().toISOString(), id);
      return { verified: false, todo: get(id), error: error.message, direction: "workbench" };
    }
  }
  async function verify(id, direction = "dingtalk_readback") {
    const row = get(id);
    try {
      const args = ["todo", "+get", "--task-id", row.external_task_id];
      if (row.dws_profile) args.push("--profile", row.dws_profile);
      const detail = checked(await dwsClient.read(args));
      if (String(detail?.taskId || "") !== row.external_task_id) throw new Error("钉钉回读的待办 ID 不一致");
      const title = detail.subject || detail.title;
      if (!title) throw new Error("钉钉回读缺少标题");
      const priority = detail.priority >= 40 ? "P0" : detail.priority >= 30 ? "P1" : "P2";
      const executor = detail.executorIds?.[0] || detail.participantIds?.[0] || row.assignee_id;
      const syncedAt = new Date().toISOString();
      if (hasColumn("external_updated_at")) {
        db().prepare("UPDATE todos SET title=?,status=?,priority=?,due_date=?,completed_at=?,assignee_id=?,external_updated_at=?,last_sync_at=?,sync_direction=?,sync_status='synced',sync_error=NULL WHERE id=?")
          .run(title, detail.isDone ? "done" : "inbox", priority, day(detail.dueTime || detail.planFinishDate), detail.isDone ? (get(id).completed_at || syncedAt) : null, executor == null ? null : String(executor), detail.updatedAt || detail.updateTime || syncedAt, syncedAt, direction, id);
      } else {
        db().prepare("UPDATE todos SET title=?,status=?,priority=?,due_date=?,completed_at=?,assignee_id=?,sync_status='synced',sync_error=NULL WHERE id=?")
          .run(title, detail.isDone ? "done" : "inbox", priority, day(detail.dueTime || detail.planFinishDate), detail.isDone ? (get(id).completed_at || syncedAt) : null, executor == null ? null : String(executor), id);
      }
      return { verified: true, taskId: row.external_task_id, externalId: row.external_task_id, todo: get(id) };
    } catch (error) {
      db().prepare("UPDATE todos SET sync_status='unverified',sync_error=? WHERE id=?").run(error.message, id);
      return { verified: false, taskId: row.external_task_id, todo: get(id), error: error.message };
    }
  }
  async function syncFromDingtalk(event = {}) {
    const taskId = String(event.taskId || event.task_id || event.id || event.data?.taskId || "");
    if (!taskId) return { ignored: true, reason: "missing_task_id" };
    const row = db().prepare("SELECT * FROM todos WHERE external_task_id=?").get(taskId);
    if (!row) return { ignored: true, reason: "unmatched_task", taskId };
    const profile = event.profile || event.profileId || event.data?.profile;
    if (profile && row.dws_profile && profile !== row.dws_profile) return { ignored: true, reason: "profile_mismatch", taskId };
    const status = event.isDone === true || event.status === "done" || event.status === "completed" || event.eventType === "todo.completed" ? "done" : event.isDone === false || event.status === "inbox" || event.status === "open" || event.eventType === "todo.reopened" ? "inbox" : null;
    if (!status) return verify(row.id, "dingtalk_event");
    const changedAt = event.updatedAt || event.timestamp || new Date().toISOString();
    if (row.local_updated_at && Date.parse(row.local_updated_at) > Date.parse(changedAt)) return { ignored: true, reason: "local_newer", todo: row };
    db().prepare("UPDATE todos SET status=?,completed_at=?,external_updated_at=?,last_sync_at=?,sync_direction='dingtalk_event',sync_status='synced',sync_error=NULL WHERE id=?")
      .run(status, status === "done" ? (row.completed_at || changedAt) : null, changedAt, new Date().toISOString(), row.id);
    return { verified: true, todo: get(row.id), direction: "dingtalk_event" };
  }
  async function create(input, { id = `t${crypto.randomUUID()}`, source = "manual" } = {}) {
    const existing = get(id);
    if (existing) {
      if (existing.sync_status === "synced") return { verified: true, taskId: existing.external_task_id, todo: existing };
      if (existing.external_task_id) return verify(id);
      // Unknown write outcomes must never trigger a second create.
      return { verified: false, todo: existing, error: existing.sync_error || "同步正在进行，请稍后刷新。" };
    }
    const title = String(input.title || input.task || "").trim();
    if (!title) throw new Error("标题必填");
    const due = dueIso(input.due || input.dueDate || input.due_date || input.deadline);
    const priority = ({ P0: 40, P1: 30, P2: 20 })[input.priority] || Number(input.priority || 20);
    if (![10, 20, 30, 40].includes(priority)) throw new Error("待办优先级无效");
    db().prepare("INSERT INTO todos(id,title,note,status,priority,due_date,created_at,source_type,project_id,assignee_id,sync_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, title, input.note || input.description || "", "inbox", priority >= 40 ? "P0" : priority >= 30 ? "P1" : "P2", day(due), new Date().toISOString(), source, input.project_id || input.projectId || null, input.assignee_id || input.executorId || null, "pending");
    let writing = false;
    try {
      const profile = await dwsClient.currentProfile();
      const raw = profile.raw || {};
      const profileId = raw.corpId && raw.userId ? `${raw.corpId}:${raw.userId}` : profile.id;
      if (!profileId) throw new Error("请先在设置中选择钉钉组织");
      db().prepare("UPDATE todos SET dws_profile=? WHERE id=?").run(profileId, id);
      let executor = input.executorId || input.executors || input.assignee_id;
      const assignee = String(input.assignee || input.to || "").trim();
      let command;
      if (!executor && assignee && !/^(当前用户|自己|我|本人)$/.test(assignee)) {
        command = ["todo", "+assign", "--to", assignee, "--task", title, "--yes"];
        if (due) command.push("--due", due);
      } else {
        if (!executor) {
          const self = checked(await dwsClient.read(["contact", "user", "get-self", "--profile", profileId]));
          const users = Array.isArray(self) ? self : [self];
          if (users.length !== 1) throw new Error("无法唯一识别当前用户");
          executor = users[0]?.orgEmployeeModel?.userId || users[0]?.userId || users[0]?.userid;
          if (!executor) throw new Error("无法识别当前钉钉用户");
        }
        command = ["todo", "task", "create", "--title", title, "--executors", Array.isArray(executor) ? executor.join(",") : String(executor), "--priority", String(priority)];
        if (due) command.push("--due", due);
      }
      command.push("--profile", profileId);
      writing = true;
      const created = checked(await dwsClient.write(command));
      const taskId = String(created?.taskId || "");
      if (!taskId) throw new Error("创建结果缺少 taskId，请核验钉钉后再操作");
      db().prepare("UPDATE todos SET external_task_id=?,source_id=CASE WHEN source_type='dws_todo' THEN ? ELSE source_id END,sync_status='unverified' WHERE id=?").run(taskId, taskId, id);
      return verify(id);
    } catch (error) {
      db().prepare("UPDATE todos SET sync_status=?,sync_error=? WHERE id=?").run(writing ? "unknown" : "failed", error.message, id);
      return { verified: false, todo: get(id), error: error.message };
    }
  }
  return { create, verify, syncFromWorkbench, syncFromDingtalk };
}
