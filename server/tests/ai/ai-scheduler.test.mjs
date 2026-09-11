import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createAiScheduler } from "../../ai/ai-scheduler.mjs";

function db() {
  const value = new Database(":memory:");
  value.exec(`
    CREATE TABLE ai_artifacts(kind TEXT NOT NULL, scope TEXT NOT NULL, input_hash TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT, source_refs_json TEXT, ai_meta_json TEXT, prompt_version TEXT, generated_at TEXT, last_attempt_at TEXT, last_error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(kind,scope));
    CREATE TABLE ai_tasks(id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, input_hash TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL, trigger TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, last_error TEXT, next_attempt_at TEXT, max_attempts INTEGER NOT NULL DEFAULT 3, payload_json TEXT, input_tokens INTEGER, output_tokens INTEGER, prompt_version TEXT);
  `);
  return value;
}

test("邮件分类通过 AI Task Queue 执行并写入 artifact", async () => {
  const memory = db(); let calls = 0;
  const scheduler = createAiScheduler({ database: () => memory, maxConcurrency: 1, aiService: {
    async classifyOutlookEmail(message) { calls += 1; return { queue: "action", actionType: "reply", actionText: message.subject, priority: "P1", confidence: 90, summary: message.subject, aiMeta: { provider: "test" } }; },
  } });
  const result = await scheduler.classifyEmail({ id: "mail-1", subject: "确认合同", from: { emailAddress: { name: "测试" } }, receivedDateTime: "2026-09-11T00:00:00Z", body: { content: "请确认" } });
  assert.equal(calls, 1);
  assert.equal(result.queue, "action");
  assert.equal(memory.prepare("SELECT kind,status,attempts,prompt_version FROM ai_tasks").get().kind, "email.classify");
  assert.equal(memory.prepare("SELECT prompt_version FROM ai_tasks").get().prompt_version, "EMAIL_CLASSIFY_V1");
  assert.equal(memory.prepare("SELECT status FROM ai_tasks").get().status, "ready");
  assert.equal(scheduler.stats().ready, 1);
  assert.equal(scheduler.stats().totalTokens, 0);
  memory.close();
});

test("相同邮件输入不会重复创建或执行 AI Task", async () => {
  const memory = db(); let calls = 0;
  const scheduler = createAiScheduler({ database: () => memory, aiService: { async classifyOutlookEmail() { calls += 1; return { queue: "informational", actionType: "other", actionText: "无需处理", priority: "P2", confidence: 80, summary: "摘要" }; } } });
  const message = { id: "mail-2", subject: "通知", receivedDateTime: "2026-09-11T00:00:00Z", body: { content: "内容" } };
  await scheduler.classifyEmail(message);
  await scheduler.classifyEmail(message);
  assert.equal(calls, 1);
  assert.equal(memory.prepare("SELECT COUNT(*) count FROM ai_tasks").get().count, 1);
  assert.equal(scheduler.stats().dedupHits, 1);
  memory.close();
});
