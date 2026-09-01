import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createSyncCoordinator, SYNC_POLICIES } from "./sync-coordinator.mjs";

function db(){const value=new Database(":memory:");value.exec("CREATE TABLE sync_state(key TEXT PRIMARY KEY,value_json TEXT)");return value}

test("同步策略覆盖邮件、团队日志、日程和个人消息",()=>{
  assert.deepEqual(Object.keys(SYNC_POLICIES),["outlook","dingtalk","calendar","dingtalk_chat"]);
  for(const policy of Object.values(SYNC_POLICIES))assert.equal(policy.intervalMinutes,15);
});

test("状态快照读取不触发连接器探测",()=>{
  const memory=db(); let calls=0;
  const coordinator=createSyncCoordinator({
    outlookService:{status:async()=>{calls+=1;return {configured:false}}}, dingtalkService:{isConfigured:()=>false,calendarReady:()=>false}, database:()=>memory,
  });
  const snapshot=coordinator.statusSnapshot();
  assert.equal(calls,0);
  assert.equal(snapshot.find((item)=>item.source==="outlook").checking,true);
  memory.close();
});

test("个人消息同步使用 DWS 状态并只将新增消息交给 AI",async()=>{
  const memory=db();let received=[];
  const coordinator=createSyncCoordinator({
    outlookService:{status:async()=>({configured:false})},dingtalkService:{isConfigured:()=>false,calendarReady:()=>false},
    dingtalkChatService:{status:async()=>({installed:true,connected:true}),sync:async()=>({count:2,firstSync:false,added:[{id:"m1"},{id:"m2"}]})},
    aiScheduler:{dashboardArtifact:()=>{},dingtalkChatMessagesArtifact:(ids)=>{received=ids}},database:()=>memory,now:()=>new Date("2026-08-27T04:00:00.000Z"),
  });
  const [result]=await coordinator.run(["dingtalk_chat"],{date:"2026-08-27",trigger:"manual"});
  assert.equal(result.status,"success");assert.equal(result.recordCount,2);assert.deepEqual(received,["m1","m2"]);memory.close();
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

test("钉钉白名单错误会暂停自动调度但允许手动恢复",async()=>{
  const memory=db();let blocked=false;
  const dingtalkService={
    isConfigured:()=>true,calendarReady:()=>false,syncMembers:async()=>[],
    syncReports:async()=>{
      if(!blocked)return [{id:"r1"}];
      const error=new Error("请更新钉钉 IP 白名单");
      Object.assign(error,{code:"DINGTALK_IP_NOT_WHITELISTED",blocked:true,retryable:false,egressIp:"203.0.113.8"});
      throw error;
    },
  };
  const coordinator=createSyncCoordinator({
    outlookService:{status:async()=>({configured:false})},dingtalkService,database:()=>memory,now:()=>new Date("2026-08-27T04:00:00.000Z"),
  });
  await coordinator.run(["dingtalk"],{date:"2026-08-27",trigger:"automatic"});
  blocked=true;
  const [failed]=await coordinator.run(["dingtalk"],{date:"2026-08-27",trigger:"automatic"});
  assert.equal(failed.blocked,true);assert.equal(failed.usingCachedData,true);
  const status=(await coordinator.status()).find((item)=>item.source==="dingtalk");
  assert.equal(status.nextRunAt,null);assert.equal(status.retryable,false);assert.equal(status.egressIp,"203.0.113.8");
  blocked=false;
  const [recovered]=await coordinator.run(["dingtalk"],{date:"2026-08-27",trigger:"manual"});
  assert.equal(recovered.status,"success");assert.equal(recovered.blocked,false);memory.close();
});
