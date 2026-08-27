import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createSyncCoordinator, SYNC_POLICIES } from "./sync-coordinator.mjs";

function db(){const value=new Database(":memory:");value.exec("CREATE TABLE sync_state(key TEXT PRIMARY KEY,value_json TEXT)");return value}

test("同步策略覆盖邮件、团队日志和钉钉日程",()=>{
  assert.deepEqual(Object.keys(SYNC_POLICIES),["outlook","dingtalk","calendar"]);
  for(const policy of Object.values(SYNC_POLICIES))assert.equal(policy.intervalMinutes,15);
});

test("自动邮件同步会写统一状态并镜像到邮件读取表",async()=>{
  const memory=db();let syncCount=0;let mirrorCount=0;
  const coordinator=createSyncCoordinator({
    outlookService:{status:async()=>({configured:true,consented:true,connected:true}),sync:async()=>{syncCount+=1;return {classified:3}}},
    dingtalkService:{isConfigured:()=>false,calendarReady:()=>false},
    mirrorEmails:async()=>{mirrorCount+=1},database:()=>memory,now:()=>new Date("2026-08-27T04:00:00.000Z"),
  });
  const [result]=await coordinator.run(["outlook"],{date:"2026-08-27",trigger:"automatic"});
  assert.equal(result.status,"success");assert.equal(result.trigger,"automatic");assert.equal(result.recordCount,3);assert.equal(syncCount,1);assert.equal(mirrorCount,1);
  const [status]=await coordinator.status();assert.equal(status.lastSuccessAt,"2026-08-27T04:00:00.000Z");assert.equal(status.nextRunAt,"2026-08-27T04:15:00.000Z");memory.close();
});

test("团队名册接口失败不会阻断钉钉日志同步",async()=>{
  const memory=db();let reportsSynced=0;
  const coordinator=createSyncCoordinator({
    outlookService:{status:async()=>({configured:false})},
    dingtalkService:{isConfigured:()=>true,calendarReady:()=>false,syncMembers:async()=>{throw new Error("通讯录不可用")},syncReports:async()=>{reportsSynced+=1;return [{id:"r1"}]}},
    database:()=>memory,now:()=>new Date("2026-08-27T04:00:00.000Z"),
  });
  const [result]=await coordinator.run(["dingtalk"],{date:"2026-08-27",trigger:"automatic"});
  assert.equal(result.status,"success");assert.equal(result.recordCount,1);assert.match(result.warning,/保留本地名册/);assert.equal(reportsSynced,1);memory.close();
});
