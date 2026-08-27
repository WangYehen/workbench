import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { localDateString, resolveDateKey } from "./local-date.mjs";
import { buildAttentionItems, buildTeamPulse } from "./workbench-domain.mjs";

function memoryDb(){const db=new Database(":memory:");db.exec(`
CREATE TABLE dingtalk_members(user_id TEXT PRIMARY KEY,name TEXT,dept_name TEXT,is_manager INTEGER DEFAULT 0,active INTEGER DEFAULT 1);
CREATE TABLE dingtalk_reports(id TEXT PRIMARY KEY,user_id TEXT,user_name TEXT,dept_name TEXT,report_date TEXT,blockers TEXT,needs_review TEXT);
CREATE TABLE todos(id TEXT PRIMARY KEY,title TEXT,note TEXT,status TEXT,priority TEXT,due_date TEXT,source_type TEXT,source_id TEXT,project_id TEXT);
CREATE TABLE emails(id TEXT PRIMARY KEY,subject TEXT,sender TEXT,action TEXT,priority TEXT,importance TEXT,due_at TEXT,priority_reason TEXT,needs_action INTEGER,source TEXT,received_at TEXT);
CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,owner TEXT,progress INTEGER);
CREATE TABLE project_phases(id TEXT PRIMARY KEY,project_id TEXT,phase TEXT,start_date TEXT,end_date TEXT);
`);return db}

test("上海时区凌晨不会被 UTC 日期偏移",()=>{assert.equal(localDateString(new Date("2026-08-26T16:30:00.000Z")),"2026-08-27");assert.throws(()=>resolveDateKey("2026/08/27"))});

test("团队态势按名册和唯一提交人统计",()=>{const db=memoryDb();for(let i=1;i<=5;i++)db.prepare("INSERT INTO dingtalk_members VALUES(?,?,?,0,1)").run(`u${i}`,`成员${i}`,"研发");db.prepare("INSERT INTO dingtalk_reports VALUES(?,?,?,?,?,?,?)").run("r1","u1","成员1","研发","2026-08-27","[]","[]");db.prepare("INSERT INTO dingtalk_reports VALUES(?,?,?,?,?,?,?)").run("r2","u1","成员1","研发","2026-08-27","[]","[]");for(let i=2;i<=4;i++)db.prepare("INSERT INTO dingtalk_reports VALUES(?,?,?,?,?,?,?)").run(`r${i+1}`,`u${i}`,`成员${i}`,"研发","2026-08-27","[]","[]");const pulse=buildTeamPulse(db,"2026-08-27");assert.equal(pulse.rosterTotal,5);assert.equal(pulse.submittedUnique,4);assert.equal(pulse.submissionRate,80);assert.equal(pulse.missing.length,1);assert.equal(pulse.members.find((m)=>m.user_id==="u1").reportCount,2);db.close()});

test("逾期 P1 待办进入注意事项时升级为 P0",()=>{const db=memoryDb();db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?)").run("t1","逾期事项","","inbox","P1","2026-08-26","manual",null,null);const item=buildAttentionItems(db,"2026-08-27").find((x)=>x.id==="todo:t1");assert.equal(item.priority,"P0");assert.match(item.recommendedAction,/逾期/);db.close()});
