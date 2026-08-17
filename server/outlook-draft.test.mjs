import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import express from "express";
import { buildDraftContext, shouldRegenerate, generateDraft, TONES } from "./outlook-draft.mjs";

// 内存数据库：仅建草稿功能依赖的表
function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE todos (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT,
      status TEXT DEFAULT 'inbox', priority TEXT DEFAULT 'P1',
      due_date TEXT, created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE email_drafts (
      message_id TEXT PRIMARY KEY, draft_text TEXT NOT NULL,
      tone TEXT DEFAULT 'formal', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  return db;
}

const sampleMessage = {
  id: "m1",
  subject: "Q3 预算调整说明",
  sender: "王磊",
  summary: "财务部 Q3 预算调整说明待确认",
  actionText: "回复财务部确认预算口径",
  priorityReason: "财务需在月结前确认口径",
  dueAt: "2026-08-20T18:00:00.000Z",
  bodyText: "附件为 Q3 预算调整说明初稿，请确认预算口径与原计划差异。",
};

test("buildDraftContext：正文源回退链 bodyText → preview → summary", () => {
  const ctx = buildDraftContext(
    { ...sampleMessage, bodyText: "正文内容" },
    [],
    "formal",
  );
  assert.equal(ctx.email.body, "正文内容");
  assert.equal(ctx.email.actionText, "回复财务部确认预算口径");
  assert.equal(ctx.tone, "formal");

  const ctxPreview = buildDraftContext({ ...sampleMessage, bodyText: "", preview: "预览片段" }, [], "formal");
  assert.equal(ctxPreview.email.body, "预览片段");

  const ctxSummary = buildDraftContext({ ...sampleMessage, bodyText: "", preview: "", summary: "只有摘要" }, [], "formal");
  assert.equal(ctxSummary.email.body, "只有摘要");
});

test("buildDraftContext：正文裁剪 2000 字符，待办最多 8 条", () => {
  const longBody = "x".repeat(3000);
  const ctx = buildDraftContext({ ...sampleMessage, bodyText: longBody }, Array.from({ length: 12 }, (_, i) => ({ title: `待办${i}` })), "formal");
  assert.equal(ctx.email.body.length, 2000);
  assert.equal(ctx.managerContext.openTodos.length, 8);
});

test("shouldRegenerate：无缓存/语气变化/强制重生成判定", () => {
  assert.equal(shouldRegenerate(null, "formal", false), true);
  assert.equal(shouldRegenerate({ tone: "formal" }, "formal", false), false);
  assert.equal(shouldRegenerate({ tone: "formal" }, "formal", true), true);
  assert.equal(shouldRegenerate({ tone: "formal" }, "friendly", false), true);
});

test("generateDraft：生成并缓存，二次调用命中缓存不调 AI", async () => {
  const db = makeDb();
  const calls = [];
  const ai = { draftReply: async (ctx) => { calls.push(ctx); return { body: "已确认，明早答复。" }; } };
  const first = await generateDraft({ db, ai, message: sampleMessage, tone: "formal" });
  assert.equal(first.cached, false);
  assert.equal(first.draft, "已确认，明早答复。");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].email.body.includes("Q3"));
  assert.ok(calls[0].managerContext.openTodos);

  const second = await generateDraft({ db, ai, message: sampleMessage, tone: "formal" });
  assert.equal(second.cached, true);
  assert.equal(second.draft, "已确认，明早答复。");
  assert.equal(calls.length, 1);
});

test("generateDraft：force 强制重生成，换语气覆盖缓存", async () => {
  const db = makeDb();
  let body = "第一版草稿";
  const ai = { draftReply: async () => ({ body }) };
  await generateDraft({ db, ai, message: sampleMessage, tone: "formal" });

  body = "第二版草稿";
  const forced = await generateDraft({ db, ai, message: sampleMessage, tone: "formal", force: true });
  assert.equal(forced.cached, false);
  assert.equal(forced.draft, "第二版草稿");

  body = "友好版草稿";
  const friendly = await generateDraft({ db, ai, message: sampleMessage, tone: "friendly" });
  assert.equal(friendly.cached, false);
  assert.equal(friendly.draft, "友好版草稿");
});

test("generateDraft：非法语气与 AI 失败抛 OutlookServiceError", async () => {
  const db = makeDb();
  await assert.rejects(
    generateDraft({ db, ai: {}, message: sampleMessage, tone: "angry" }),
    (err) => err.code === "OUTLOOK_INVALID_DRAFT_REQUEST",
  );
  await assert.rejects(
    generateDraft({ db, ai: { draftReply: async () => { throw new Error("boom"); } }, message: sampleMessage, tone: "formal" }),
    (err) => err.code === "OUTLOOK_MODEL_REQUEST_FAILED",
  );
  await assert.rejects(
    generateDraft({ db, ai: { draftReply: async () => ({ body: "" }) }, message: sampleMessage, tone: "formal" }),
    (err) => err.code === "OUTLOOK_MODEL_REQUEST_FAILED",
  );
});

test("路由级：POST 草稿接口错误路径（mock service + 真实 HTTP）", async () => {
  const { default: outlookRouter } = await import("./routers/outlook.js");
  const service = { list: async () => ({ items: [sampleMessage] }) };
  const app = express();
  app.use(express.json());
  app.use("/api/outlook", outlookRouter(service));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/outlook`;

  try {
    // 非法语气 → 400
    const badTone = await fetch(`${base}/messages/m1/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tone: "angry" }),
    });
    assert.equal(badTone.status, 400);

    // 邮件不存在 → 400（不触发 AI 与数据库写入）
    const missing = await fetch(`${base}/messages/nope/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    // 不支持的字段 → 400
    const extra = await fetch(`${base}/messages/m1/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tone: "formal", hack: true }),
    });
    assert.equal(extra.status, 400);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("TONES 常量与前端语气选项一致", () => {
  assert.deepEqual([...TONES], ["formal", "friendly", "action"]);
});