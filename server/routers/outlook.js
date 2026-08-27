import express from "express";
import { getDb, upsert } from "../db.mjs";
import { OutlookServiceError } from "../outlook.mjs";
import { ai } from "../ai.mjs";
import { generateDraft } from "../outlook-draft.mjs";

// 优先级（P0/P1/P2）映射到旧 emails 表的 importance / priority 字段，供概览、日历、系统页读取
const PRIORITY_TO_IMPORTANCE = { P0: "high", P1: "medium", P2: "low" };
const PRIORITY_TO_TODO = { P0: "P0", P1: "P1", P2: "P2" };

function assertAllowedObjectKeys(body, allowed, code) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OutlookServiceError(code, "请求体格式无效。");
  }
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new OutlookServiceError(code, `不支持的字段：${key}`);
  }
}

function json(res, status, value) {
  res.status(status).json(value);
}

// 把已分类的邮件镜像到本地 emails 表（不含正文），让概览 / 日历 / 系统页继续可用。
export async function mirrorToEmails(service) {
  const db = getDb();
  const { items } = await service.list("all");
  if (!items || !items.length) return;
  upsert(
    "emails",
    items.map((m) => ({
      id: m.id,
      subject: m.subject,
      sender: m.sender,
      sender_email: "",
      received_at: m.receivedAt,
      importance: PRIORITY_TO_IMPORTANCE[m.priority] || "normal",
      has_flag: 0,
      due_at: m.dueAt || null,
      preview: m.summary || "",
      needs_action: m.queue === "action" && m.status === "open" ? 1 : 0,
      reason: m.priorityReason || "",
      confidence: m.confidence || 0,
      summary: m.summary || "",
      action: m.actionText || "",
      priority: PRIORITY_TO_IMPORTANCE[m.priority] || "medium",
      priority_reason: m.priorityReason || "",
      due_source: m.dueSource || "",
      source: "outlook",
      created_at: new Date().toISOString(),
    })),
    ["id"],
  );
}

export default function outlookRouter(service) {
  const router = express.Router();

  // 统一错误包装：OutlookServiceError 区分可重试(502)与其他(400)
  const wrap = (fn) => (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => {
        if (err instanceof OutlookServiceError) {
          const retryable = [
            "OUTLOOK_GRAPH_REQUEST_FAILED",
            "OUTLOOK_MODEL_REQUEST_FAILED",
            "OUTLOOK_TOKEN_EXCHANGE_FAILED",
          ].includes(err.code);
          return json(res, retryable ? 502 : 400, { error: err.message });
        }
        return json(res, 500, { error: err?.message || "内部错误" });
      });
  };

  router.get("/status", wrap(async (req, res) => json(res, 200, await service.status())));

  router.post("/consent", wrap(async (req, res) => {
    const body = req.body || {};
    assertAllowedObjectKeys(body, new Set(["accepted"]), "OUTLOOK_INVALID_CONSENT");
    if (!body.accepted) {
      throw new OutlookServiceError("OUTLOOK_CONSENT_REQUIRED", "需要明确同意后才能发送邮件正文至 DeepSeek。");
    }
    json(res, 200, await service.acceptConsent());
  }));

  router.post("/oauth/start", wrap(async (req, res) => {
    assertAllowedObjectKeys(req.body || {}, new Set(), "OUTLOOK_INVALID_OAUTH_REQUEST");
    json(res, 200, await service.startOAuth());
  }));

  // 设备码授权：浏览器无法回跳 127.0.0.1 或无法直连 Microsoft 登录页时使用。
  // 前端拿到 userCode + verificationUri 后展示给用户，再按 interval 轮询 /oauth/device/poll。
  router.post("/oauth/device/start", wrap(async (req, res) => {
    assertAllowedObjectKeys(req.body || {}, new Set(), "OUTLOOK_INVALID_OAUTH_REQUEST");
    json(res, 200, await service.startDeviceCode());
  }));

  router.post("/oauth/device/poll", wrap(async (req, res) => {
    assertAllowedObjectKeys(req.body || {}, new Set(["handle"]), "OUTLOOK_INVALID_OAUTH_REQUEST");
    const result = await service.pollDeviceCode(req.body?.handle);
    if (!result.pending) await mirrorToEmails(service);
    json(res, 200, result);
  }));

  router.post("/sync", wrap(async (req, res) => {
    assertAllowedObjectKeys(req.body || {}, new Set(), "OUTLOOK_INVALID_SYNC_REQUEST");
    const result = await service.sync();
    await mirrorToEmails(service);
    json(res, 200, result);
  }));

  router.get("/todos", wrap(async (req, res) => json(res, 200, await service.list("todos"))));
  router.get("/archive", wrap(async (req, res) => json(res, 200, await service.list("archive"))));
  router.get("/all", wrap(async (req, res) => json(res, 200, await service.list("all"))));
  router.get("/informational", wrap(async (req, res) => json(res, 200, await service.list("informational"))));
  router.get("/uncertain", wrap(async (req, res) => json(res, 200, await service.list("uncertain"))));

  router.post("/disconnect", wrap(async (req, res) => {
    assertAllowedObjectKeys(req.body || {}, new Set(), "OUTLOOK_INVALID_DISCONNECT_REQUEST");
    const result = await service.disconnect();
    await mirrorToEmails(service);
    json(res, 200, result);
  }));

  router.post("/todos/:id/status", wrap(async (req, res) => {
    assertAllowedObjectKeys(req.body || {}, new Set(["status"]), "OUTLOOK_INVALID_STATUS_REQUEST");
    const result = await service.setMessageStatus(decodeURIComponent(req.params.id), req.body.status);
    await mirrorToEmails(service);
    json(res, 200, result);
  }));

  router.patch("/messages/:id/correction", wrap(async (req, res) => {
    assertAllowedObjectKeys(
      req.body || {},
      new Set(["queue", "actionType", "actionText", "dueAt", "dueSource", "priority", "priorityReason", "confidence", "summary"]),
      "OUTLOOK_INVALID_CORRECTION_REQUEST",
    );
    const result = await service.correctMessage(decodeURIComponent(req.params.id), req.body || {});
    await mirrorToEmails(service);
    json(res, 200, result);
  }));

  // 一键转为待办（写入本地 todos 表，并标记邮件为 converted）
  router.post("/messages/:id/task", wrap(async (req, res) => {
    const id = decodeURIComponent(req.params.id);
    const { items } = await service.list("all");
    const message = items.find((m) => m.id === id);
    if (!message) throw new OutlookServiceError("OUTLOOK_MESSAGE_NOT_FOUND", "邮件不存在。");
    const db = getDb();
    const existing = db.prepare("SELECT * FROM todos WHERE source_type='outlook' AND source_id=?").get(id);
    if (existing) {
      return json(res, 200, { ok: true, duplicate: true, id: existing.id, title: existing.title, priority: existing.priority, due_date: existing.due_date });
    }
    const todoId = "t" + Math.random().toString(36).slice(2, 10);
    const title = message.actionText ? `${message.actionText}（来自 ${message.sender || "邮件"}）` : message.subject;
    const priority = PRIORITY_TO_TODO[message.priority] || "P1";
    const dueDate = message.dueAt ? String(message.dueAt).slice(0, 10) : null;
    const noteParts = [
      message.summary ? `AI 摘要：${message.summary}` : "",
      message.priorityReason ? `优先级原因：${message.priorityReason}` : "",
      message.dueSource ? `截止来源：${message.dueSource}` : "",
      message.webLink ? `Outlook：${message.webLink}` : "",
    ].filter(Boolean).join("\n");
    upsert(
      "todos",
      [{ id: todoId, title, note: noteParts, status: "inbox", priority, due_date: dueDate, created_at: new Date().toISOString(), completed_at: null, source_type: "outlook", source_id: id, project_id: req.body?.projectId || null, assignee_id: req.body?.assigneeId || null }],
      ["id"],
    );
    await service.setMessageStatus(id, "converted");
    await mirrorToEmails(service);
    json(res, 200, { ok: true, id: todoId, title, priority, due_date: dueDate });
  }));

  // 获取已缓存的回复草稿（无则 draft 为 null）
  router.get("/messages/:id/draft", wrap(async (req, res) => {
    const row = getDb().prepare("SELECT draft_text, tone, updated_at FROM email_drafts WHERE message_id=?").get(decodeURIComponent(req.params.id));
    json(res, 200, row ? { draft: row.draft_text, tone: row.tone, updatedAt: row.updated_at } : { draft: null });
  }));

  // 生成（或重新生成）回复草稿：本地生成 + 缓存，不写回 Outlook 邮箱
  router.post("/messages/:id/draft", wrap(async (req, res) => {
    assertAllowedObjectKeys(req.body || {}, new Set(["tone", "force"]), "OUTLOOK_INVALID_DRAFT_REQUEST");
    const id = decodeURIComponent(req.params.id);
    const { items } = await service.list("all");
    const message = items.find((m) => m.id === id);
    if (!message) throw new OutlookServiceError("OUTLOOK_MESSAGE_NOT_FOUND", "邮件不存在。");
    const result = await generateDraft({
      db: getDb(),
      ai,
      message,
      tone: req.body?.tone || "formal",
      force: Boolean(req.body?.force),
    });
    json(res, 200, { ...result, id });
  }));

  return router;
}
