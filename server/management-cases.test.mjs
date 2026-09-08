import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createManagementCases } from "./management-cases.mjs";

function memoryDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE todos(id TEXT PRIMARY KEY,title TEXT,note TEXT,status TEXT,priority TEXT,due_date TEXT,project_id TEXT);
    CREATE TABLE emails(id TEXT PRIMARY KEY,subject TEXT,sender TEXT,importance TEXT,priority TEXT,priority_reason TEXT,needs_action INTEGER,source TEXT,due_at TEXT,received_at TEXT);
    CREATE TABLE dingtalk_reports(id TEXT PRIMARY KEY,user_id TEXT,user_name TEXT,report_date TEXT,blockers TEXT,needs_review TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,owner TEXT,progress INTEGER);
    CREATE TABLE project_phases(id TEXT PRIMARY KEY,project_id TEXT,phase TEXT,start_date TEXT,end_date TEXT);
    CREATE TABLE calendars(id TEXT PRIMARY KEY,title TEXT,day TEXT,location TEXT,start_at TEXT);
    CREATE TABLE management_cases(id TEXT PRIMARY KEY,category TEXT,state TEXT,priority TEXT,title TEXT,management_summary TEXT,owner_id TEXT,owner_name TEXT,due_at TEXT,project_id TEXT,source_hash TEXT UNIQUE,created_at TEXT,updated_at TEXT,resolved_at TEXT);
    CREATE TABLE management_case_evidence(id TEXT PRIMARY KEY,case_id TEXT,source_type TEXT,source_id TEXT,role TEXT,excerpt TEXT,occurred_at TEXT,created_at TEXT,UNIQUE(case_id,source_type,source_id));
    CREATE TABLE management_case_actions(id TEXT PRIMARY KEY,case_id TEXT,action_type TEXT,payload_json TEXT,status TEXT,preview_id TEXT,idempotency_key TEXT UNIQUE,external_id TEXT,result_json TEXT,created_at TEXT,executed_at TEXT);
  `);
  return db;
}

test("管理事项从逾期待办、日志阻塞和高优先级邮件确定性生成并去重", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?)").run("t1", "确认排期", "与研发确认", "inbox", "P1", "2026-08-31", null);
  db.prepare("INSERT INTO emails VALUES(?,?,?,?,?,?,?,?,?,?)").run("e1", "客户升级", "客户", "high", "high", "今晚回复", 1, "outlook", null, "2026-09-01T01:00:00Z");
  db.prepare("INSERT INTO dingtalk_reports VALUES(?,?,?,?,?,?)").run("r1", "u1", "小李", "2026-09-01", JSON.stringify(["接口依赖未就绪"]), "[]");
  const service = createManagementCases({ database: () => db, now: () => new Date("2026-09-01T02:00:00Z") });
  const first = service.dashboard("2026-09-01"); const second = service.dashboard("2026-09-01");
  assert.equal(first.total, 3);
  assert.equal(second.total, 3, "重复刷新不能重复建事项");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM management_cases").get().c, 3);
  assert.equal(first.groups.risks.length, 2);
  const overdue = service.list().find((item) => item.title === "确认排期");
  assert.equal(overdue.priority, "P0");
  assert.equal(service.detail(overdue.id).evidence[0].source_type, "todo");
  db.close();
});

test("管理事项状态和优先级仅接受受控值", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?)").run("t1", "确认排期", "", "inbox", "P1", "2026-09-01", null);
  const service = createManagementCases({ database: () => db }); service.refresh("2026-09-01");
  const item = service.list()[0];
  assert.equal(service.update(item.id, { state: "delegated", priority: "P1" }).state, "delegated");
  assert.throws(() => service.update(item.id, { state: "bad" }), /不支持/);
  db.close();
});

test("管理事项动作预览和执行结果会留下审计记录", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?)").run("t1", "确认排期", "", "inbox", "P1", "2026-09-01", null);
  const service = createManagementCases({ database: () => db }); service.refresh("2026-09-01");
  const preview = service.recordActionPreview(service.list()[0].id, { id: "preview_1", payload: { title: "确认排期" } }, "todo.assign");
  service.recordActionResult(preview.idempotencyKey, { status: "not_enabled", result: { reason: "connector" } });
  const row = db.prepare("SELECT status,preview_id,result_json FROM management_case_actions WHERE id=?").get(preview.id);
  assert.equal(row.status, "not_enabled"); assert.equal(row.preview_id, "preview_1"); assert.match(row.result_json, /connector/);
  db.close();
});
