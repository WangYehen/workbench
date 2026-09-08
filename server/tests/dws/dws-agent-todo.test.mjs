import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createDwsAgentTools } from "../../domains/dws-agent-tools.mjs";
import { createDwsAgentService } from "../../domains/dws-agent.mjs";
import { createTodoSyncService } from "../../domains/todo-sync.mjs";
import express from "express";
import { createTodosRouter } from "../../routers/todos.js";

function todoDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE todos (
    id TEXT PRIMARY KEY,title TEXT NOT NULL,note TEXT,status TEXT,priority TEXT,due_date TEXT,
    created_at TEXT,completed_at TEXT,source_type TEXT,source_id TEXT,project_id TEXT,assignee_id TEXT,
    external_task_id TEXT,dws_profile TEXT,sync_status TEXT,sync_error TEXT,
    local_updated_at TEXT,external_updated_at TEXT,last_sync_at TEXT,sync_direction TEXT
  ); CREATE UNIQUE INDEX idx_todos_source ON todos(source_type,source_id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL;`);
  return db;
}

test("DWS Agent 创建自己的待办后按 taskId 回读并同步工作台", async () => {
  const db = todoDb();
  const calls = [];
  const dwsClient = {
    async currentProfile() { return { id: "test-profile" }; },
    async write(command) {
      calls.push(command);
      return { data: { arguments: [], result: { subject: "开需求评审", taskId: "57065828086" }, success: true }, ledger: { complete: true } };
    },
    async read(command) {
      if (command[0] === "contact") return { data: { result: [{ orgEmployeeModel: { userId: "u1" } }] } };
      calls.push(command);
      return { data: { ok: true, data: { subject: "开需求评审", taskId: "57065828086", dueTime: 1788849000000, priority: 20, participantIds: ["u1"], isDone: false } }, ledger: { complete: true } };
    },
  };
  const tools = createDwsAgentTools({ database: () => db, dwsClient });
  const result = await tools.execute("dws.todo.assign", { title: "开需求评审", due_date: "2026-09-08T14:30:00+08:00", assignee: "当前用户" });

  assert.deepEqual(calls[0], ["todo", "task", "create", "--title", "开需求评审", "--executors", "u1", "--priority", "20", "--due", "2026-09-08T06:30:00.000Z", "--profile", "test-profile"]);
  assert.deepEqual(calls[1], ["todo", "+get", "--task-id", "57065828086", "--profile", "test-profile"]);
  assert.equal(result.taskId, "57065828086");
  assert.equal(result.verified, true);
  const saved = db.prepare("SELECT * FROM todos WHERE source_type='dws_todo' AND source_id=?").get("57065828086");
  assert.equal(saved.title, "开需求评审");
  assert.equal(saved.assignee_id, "u1");
  assert.equal(saved.sync_status, "synced");
  db.close();
});

test("手动待办同步保留同一条本地记录，重复提交只创建一次，日期按上海时区", async () => {
  const db = todoDb(); let writes = 0;
  const dwsClient = {
    currentProfile: async () => ({ id: "p" }),
    read: async (command) => command[0] === "contact" ? { data: { userId: "u1" } } : { data: { result: { taskId: "external1", subject: "测试待办", priority: 40, dueTime: Date.parse("2026-09-09T00:30:00+08:00") } } },
    write: async (command) => { writes++; assert.equal(command[command.indexOf("--priority") + 1], "40"); return { data: { data: { result: { taskId: "external1" } } } }; },
  };
  const service = createTodoSyncService({ database: () => db, dwsClient });
  const first = await service.create({ title: "测试待办", priority: "P0" }, { id: "manual1" });
  const second = await service.create({ title: "测试待办", priority: "P0" }, { id: "manual1" });
  assert.equal(first.verified, true); assert.equal(second.todo.id, first.todo.id);
  assert.equal(first.todo.source_type, "manual"); assert.equal(first.todo.due_date, "2026-09-09");
  assert.equal(writes, 1); assert.equal(db.prepare("SELECT count(*) n FROM todos").get().n, 1); db.close();
});

test("回读失败保留外部 ID，恢复后只回读不重新创建", async () => {
  const db = todoDb(); let writes = 0; let fail = true;
  const service = createTodoSyncService({ database: () => db, dwsClient: {
    currentProfile: async () => ({ id: "p" }),
    write: async () => { writes++; return { data: { result: { taskId: "ext2" } } }; },
    read: async () => { if (fail) throw new Error("网络中断"); return { data: { taskId: "ext2", title: "同步测试", priority: 20 } }; },
  } });
  const first = await service.create({ title: "同步测试", executorId: "u" }, { id: "retry1" });
  assert.equal(first.verified, false); assert.equal(first.todo.external_task_id, "ext2");
  fail = false;
  assert.equal((await service.create({}, { id: "retry1" })).verified, true);
  assert.equal(writes, 1); db.close();
});

test("外部创建超时保留本地记录并阻止盲目重放", async () => {
  const db = todoDb(); let writes = 0;
  const service = createTodoSyncService({ database: () => db, dwsClient: {
    currentProfile: async () => ({ id: "p" }),
    write: async () => { writes++; throw new Error("timeout"); },
  } });
  const first = await service.create({ title: "同步测试", executorId: "u" }, { id: "timeout1" });
  await service.create({}, { id: "timeout1" });
  assert.equal(first.todo.sync_status, "unknown"); assert.equal(writes, 1); db.close();
});

test("工作台完成待办走 DWS 状态命令并按期望状态核验", async () => {
  const db = todoDb();
  db.prepare("INSERT INTO todos(id,title,status,priority,created_at,external_task_id,dws_profile,sync_status) VALUES(?,?,?,?,?,?,?,?)")
    .run("todo1", "创建钉钉任务", "inbox", "P2", new Date().toISOString(), "56815195951", "p", "synced");
  let externalDone = false;
  const writes = [];
  const service = createTodoSyncService({ database: () => db, dwsClient: {
    currentProfile: async () => ({ id: "p" }),
    write: async (command) => { writes.push(command); return { data: { ok: true, data: { taskId: "56815195951" } }, ledger: { complete: true } }; },
    read: async () => ({ data: { ok: true, data: { taskId: "56815195951", subject: "创建钉钉任务", priority: 20, isDone: externalDone } }, ledger: { complete: true } }),
  } });

  const failed = await service.syncFromWorkbench("todo1", { status: "done" });
  assert.equal(failed.verified, false);
  assert.equal(failed.todo.status, "done");
  assert.equal(failed.todo.sync_status, "unverified");
  assert.match(failed.error, /未达到本次期望状态/);
  assert.deepEqual(writes[0], ["todo", "task", "done", "--task-id", "56815195951", "--status", "true", "--profile", "p"]);

  externalDone = true;
  const verified = await service.syncFromWorkbench("todo1", { status: "done" });
  assert.equal(verified.verified, true);
  assert.equal(verified.todo.status, "done");
  assert.equal(verified.todo.sync_status, "synced");
  db.close();
});

test("真实 HTTP 手动创建自动同步；Agent 确认后同一列表可查询，确认前零写入", async (t) => {
  const db = agentDb(); let writes = 0;
  const external = new Map();
  const client = {
    currentProfile: async () => ({ id: "p" }),
    read: async (args) => args[0] === "contact" ? { data: { userId: "u" } } : { data: external.get(args[args.indexOf("--task-id") + 1]) },
    write: async (args) => {
      const taskId = `external-${++writes}`;
      external.set(taskId, { taskId, subject: args[args.indexOf("--title") + 1], priority: 30, isDone: false });
      return { data: { result: { taskId } } };
    },
  };
  const app = express(); app.use(express.json()); app.use("/todos", createTodosRouter({ database: () => db, client }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.close(); db.close(); });
  const url = `http://127.0.0.1:${server.address().port}/todos`;
  const body = JSON.stringify({ title: "手动同步", priority: "P1", requestId: "manual-request-1" });
  const post = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal((await (await post()).json()).verified, true);
  assert.equal((await (await post()).json()).verified, true); assert.equal(writes, 1);
  const agent = createDwsAgentService({ database: () => db, dwsClient: client, aiService: {
    agentPlan: async () => ({ kind: "confirmation", tool: "dws.todo.assign", arguments: { title: "Agent 同步", executorId: "u", priority: "P1" }, answer: "请确认创建待办" }),
  } });
  const conv = agent.createConversation();
  const run = await agent.runTurn(conv.id, "创建待办");
  assert.equal(writes, 1);
  const result = await agent.confirm(run.runId, run.preview.id, run.audit.idempotencyKey, conv.id);
  assert.equal(result.result.verified, true);
  const items = (await (await fetch(url)).json()).items;
  assert.equal(items.length, 2);
  assert.deepEqual(new Set(items.map(row=>row.source_type)), new Set(["manual", "dws_todo"]));
  assert.ok(items.every(row=>row.external_task_id && row.sync_status === "synced"));
});

function agentDb() {
  const db = todoDb();
  db.exec(`
    CREATE TABLE dws_agent_conversations(id TEXT PRIMARY KEY,title TEXT,status TEXT,created_at TEXT,updated_at TEXT,last_message_at TEXT);
    CREATE TABLE dws_agent_messages(id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,event_type TEXT,tool_name TEXT,payload_json TEXT,created_at TEXT);
    CREATE TABLE dws_agent_runs(id TEXT PRIMARY KEY,conversation_id TEXT,user_message_id TEXT,status TEXT,input_hash TEXT,output_json TEXT,error_json TEXT,created_at TEXT,completed_at TEXT);
    CREATE TABLE dws_agent_actions(id TEXT PRIMARY KEY,run_id TEXT,action_type TEXT,preview_json TEXT,confirmed INTEGER,idempotency_key TEXT,status TEXT,result_json TEXT,external_id TEXT,created_at TEXT,executed_at TEXT);
  `);
  return db;
}

test("查看今日待办固定走待办工具而不是日程工具", async () => {
  const db = agentDb();
  const called = [];
  const dwsClient = {
    async read(command) {
      called.push(command);
      return { data: { data: { count: 1, tasks: [{ taskId: "57065828086", title: "开需求评审" }] } }, ledger: { complete: true } };
    },
  };
  const service = createDwsAgentService({ database: () => db, dwsClient, now: () => new Date("2026-09-08T02:00:00.000Z") });
  const conversation = service.createConversation();
  const result = await service.runTurn(conversation.id, "查看今日待办");

  assert.deepEqual(called[0], ["todo", "+get-related-tasks"]);
  assert.match(result.answer, /开需求评审/);
  assert.doesNotMatch(result.answer, /日程/);
  db.close();
});
