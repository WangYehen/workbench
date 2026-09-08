import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { localDateString, localTimeString, resolveDateKey, teamMetricDate } from "./local-date.mjs";
import { buildAttentionItems, buildDashboard, buildTeamPulse } from "./workbench-domain.mjs";

function memoryDb(){const db=new Database(":memory:");db.exec(`
CREATE TABLE dingtalk_members(user_id TEXT PRIMARY KEY,name TEXT,dept_name TEXT,is_manager INTEGER DEFAULT 0,active INTEGER DEFAULT 1);
CREATE TABLE dingtalk_reports(id TEXT PRIMARY KEY,user_id TEXT,user_name TEXT,dept_name TEXT,report_date TEXT,blockers TEXT,needs_review TEXT);
CREATE TABLE todos(id TEXT PRIMARY KEY,title TEXT,note TEXT,status TEXT,priority TEXT,due_date TEXT,source_type TEXT,source_id TEXT,project_id TEXT);
CREATE TABLE emails(id TEXT PRIMARY KEY,subject TEXT,sender TEXT,action TEXT,priority TEXT,importance TEXT,due_at TEXT,priority_reason TEXT,needs_action INTEGER,source TEXT,received_at TEXT);
CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,owner TEXT,progress INTEGER);
CREATE TABLE project_phases(id TEXT PRIMARY KEY,project_id TEXT,phase TEXT,start_date TEXT,end_date TEXT);
CREATE TABLE calendars(id TEXT PRIMARY KEY,source TEXT,title TEXT,start_at TEXT,end_at TEXT,location TEXT,organizer TEXT,day TEXT,attendee_count INTEGER,accepted_count INTEGER);
`);return db}

test("上海时区凌晨不会被 UTC 日期偏移",()=>{assert.equal(localDateString(new Date("2026-08-26T16:30:00.000Z")),"2026-08-27");assert.throws(()=>resolveDateKey("2026/08/27"))});
test("团队提交率按上海时间在 17:40 切换统计日期",()=>{const today="2026-08-28";assert.equal(teamMetricDate(today,new Date("2026-08-28T09:39:00.000Z")).date,"2026-08-27");assert.equal(teamMetricDate(today,new Date("2026-08-28T09:40:00.000Z")).date,today);assert.equal(teamMetricDate("2026-08-20",new Date("2026-08-28T12:00:00.000Z")).date,"2026-08-20")});

test("UTC 日程时间按上海时区展示",()=>{assert.equal(localTimeString("2026-08-27T07:00:00.000Z"),"15:00");const db=memoryDb();db.prepare("INSERT INTO calendars VALUES(?,?,?,?,?,?,?,?,?,?)").run("m1","dingtalk","测试","2026-08-27T07:00:00.000Z","2026-08-27T08:00:00.000Z","会议室 A","Charles","2026-08-27",28,27);const dashboard=buildDashboard(db,"2026-08-27");assert.equal(dashboard.meetings[0].start,"15:00");assert.equal(dashboard.meetings[0].end,"16:00");assert.equal(dashboard.meetings[0].attendee_count,28);assert.equal(dashboard.meetings[0].accepted_count,27);db.close()});

test("团队态势按名册和唯一提交人统计",()=>{const db=memoryDb();for(let i=1;i<=5;i++)db.prepare("INSERT INTO dingtalk_members VALUES(?,?,?,0,1)").run(`u${i}`,`成员${i}`,"研发");db.prepare("INSERT INTO dingtalk_reports VALUES(?,?,?,?,?,?,?)").run("r1","u1","成员1","研发","2026-08-27","[]","[]");db.prepare("INSERT INTO dingtalk_reports VALUES(?,?,?,?,?,?,?)").run("r2","u1","成员1","研发","2026-08-27","[]","[]");for(let i=2;i<=4;i++)db.prepare("INSERT INTO dingtalk_reports VALUES(?,?,?,?,?,?,?)").run(`r${i+1}`,`u${i}`,`成员${i}`,"研发","2026-08-27","[]","[]");const pulse=buildTeamPulse(db,"2026-08-27");assert.equal(pulse.rosterTotal,5);assert.equal(pulse.submittedUnique,4);assert.equal(pulse.submissionRate,80);assert.equal(pulse.missing.length,1);assert.equal(pulse.members.find((m)=>m.user_id==="u1").reportCount,2);db.close()});

test("当天截止时间前，未提交成员显示为待提交且不纳入关注",()=>{const db=memoryDb();db.prepare("INSERT INTO dingtalk_members VALUES(?,?,?,0,1)").run("u1","成员1","研发");const pulse=buildTeamPulse(db,"2026-08-27",new Date("2026-08-27T09:00:00+08:00"));assert.equal(pulse.missingStatus,"pending");assert.equal(pulse.analysisStatus,"no_reports");assert.equal(pulse.members[0].submissionState,"pending");assert.equal(pulse.members[0].signalScore,0);db.close()});

test("逾期 P1 待办进入注意事项时升级为 P0",()=>{const db=memoryDb();db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?)").run("t1","逾期事项","","inbox","P1","2026-08-26","manual",null,null);const item=buildAttentionItems(db,"2026-08-27").find((x)=>x.id==="todo:t1");assert.equal(item.priority,"P0");assert.match(item.recommendedAction,/逾期/);db.close()});
test("指挥台注意事项不带入未来待办，但 KPI 保留所有未完成待办",()=>{const db=memoryDb();db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?)").run("old","历史待办","","inbox","P1","2026-08-20","manual",null,null);db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?)").run("future","未来待办","","inbox","P0","2026-08-30","manual",null,null);const dashboard=buildDashboard(db,"2026-08-27",new Date("2026-08-27T12:00:00+08:00"));assert.deepEqual(dashboard.attention.filter((x)=>x.kind==="todo").map((x)=>x.title),["历史待办"]);assert.equal(dashboard.metrics.todos.total,2);db.close()});

test("待办 KPI 排除今日之前已完成的待办",()=>{const db=memoryDb();db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?)").run("open-overdue","逾期未完成","","inbox","P1","2026-08-26","manual",null,null);db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?)").run("open-future","未来未完成","","inbox","P1","2026-08-28","manual",null,null);db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?)").run("done-past","昨日已完成","","done","P1","2026-08-26","manual",null,null);db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?)").run("done-today","今日已完成","","done","P1","2026-08-27","manual",null,null);db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?)").run("done-future","未来已完成","","done","P1","2026-08-28","manual",null,null);const dashboard=buildDashboard(db,"2026-08-27",new Date("2026-08-27T09:00:00+08:00"));assert.deepEqual(dashboard.metrics.todos,{total:4,open:2,done:2,rate:50});db.close()});
