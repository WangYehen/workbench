import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createMeetingClosureService } from "./meeting-closure.mjs";

function memoryDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE meeting_closures(id TEXT PRIMARY KEY,minutes_id TEXT UNIQUE,title TEXT,meeting_at TEXT,organizer TEXT,summary TEXT,keywords_json TEXT,source_url TEXT,status TEXT,ai_meta_json TEXT,sync_error TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE meeting_closure_items(id TEXT PRIMARY KEY,meeting_id TEXT,kind TEXT,title TEXT,note TEXT,assignee_id TEXT,assignee_name TEXT,due_date TEXT,priority TEXT,status TEXT,external_task_id TEXT,result_json TEXT,created_at TEXT,updated_at TEXT,UNIQUE(meeting_id,kind,title));
    CREATE TABLE todos(id TEXT PRIMARY KEY,title TEXT,note TEXT,status TEXT,priority TEXT,due_date TEXT,created_at TEXT,completed_at TEXT,source_type TEXT,source_id TEXT,project_id TEXT,assignee_id TEXT,UNIQUE(source_type,source_id));
  `); return db;
}

function dws() {
  const calls = [];
  return {
    calls,
    currentProfile: async () => ({ id: "profile-1" }),
    read: async (args) => {
      calls.push(args);
      if (args[0] === "contact") return { data: { userId: "u-self", name: "主管" }, ledger: {} };
      if (args.includes("+detail")) return { data: { taskUuid: "minutes-001", title: "项目例会", startTime: "2026-09-04T01:00:00Z", creatorName: "小王", summary: "确认发布计划", keywords: ["发布"] }, ledger: {} };
      if (args.includes("+action-items")) return { data: { actionItems: [{ title: "确认上线排期", ownerName: "小李", dueDate: "2026-09-06" }] }, ledger: {} };
      if (args.includes("task") && args.includes("create")) return { data: { taskId: "todo-1" }, ledger: {} };
      if (args.includes("task") && args.includes("get")) return { data: { taskId: "todo-1", done: false }, ledger: {} };
      return { data: { items: [] }, ledger: {} };
    },
  };
}

test("导入听记只保存摘要与事项，重复导入不会重复创建事项", async () => {
  const db = memoryDb(); const client = dws();
  const service = createMeetingClosureService({ database: () => db, dwsClient: client, aiService: { available: () => false } });
  const first = await service.importMeeting("minutes-001");
  const second = await service.importMeeting("minutes-001");
  assert.equal(first.summary, "确认发布计划");
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM meeting_closures").get().c, 1);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='meeting_closures'").get().sql.includes("transcript"), false);
  db.close();
});

test("待办必须先预览确认，创建后回读并镜像到行动中心", async () => {
  const db = memoryDb(); const client = dws();
  const service = createMeetingClosureService({ database: () => db, dwsClient: client, aiService: { available: () => false } });
  const meeting = await service.importMeeting("minutes-001"); const item = meeting.items[0];
  const preview = await service.previewCreate(meeting.id, [item.id]);
  await assert.rejects(service.confirmCreate(meeting.id, { previewId: preview.id, confirmed: false }), { code: "DWS_CONFIRMATION_REQUIRED" });
  const result = await service.confirmCreate(meeting.id, { previewId: preview.id, confirmed: true });
  assert.equal(result.results[0].status, "created");
  assert.equal(result.meeting.items[0].external_task_id, "todo-1");
  assert.equal(db.prepare("SELECT source_type FROM todos").get().source_type, "meeting_closure");
  assert.equal(client.calls.some((args) => args.includes("get") && args.includes("todo-1")), true);
  db.close();
});
