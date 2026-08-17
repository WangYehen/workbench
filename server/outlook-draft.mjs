import { OutlookServiceError } from "./outlook.mjs";

// 回复草稿支持的语气（与前端语气选项一一对应）
export const TONES = new Set(["formal", "friendly", "action"]);

// 组装发给 AI 的上下文：正文源回退链 bodyText → preview → summary，正文裁剪 2000 字符
export function buildDraftContext(message, openTodos, tone) {
  const body = message.bodyText || message.preview || message.summary || "";
  return {
    email: {
      subject: message.subject || "",
      sender: message.sender || "",
      summary: message.summary || "",
      actionText: message.actionText || "",
      priorityReason: message.priorityReason || "",
      dueAt: message.dueAt || null,
      body: String(body).slice(0, 2000),
    },
    managerContext: { openTodos: (openTodos || []).slice(0, 8) },
    tone,
  };
}

// 查询主管未完成待办（有截止的在前），最多 8 条作为草稿上下文
export function loadOpenTodos(db) {
  return db
    .prepare(
      "SELECT title, priority, due_date FROM todos " +
        "WHERE status != 'done' ORDER BY (due_date IS NULL), due_date LIMIT 8",
    )
    .all();
}

// 判断是否需要重新生成：无缓存 / 语气变化 / 强制重生成
export function shouldRegenerate(existing, tone, force) {
  return Boolean(force) || !existing || existing.tone !== tone;
}

// 生成（或取缓存）邮件回复草稿并持久化；依赖注入便于单测
export async function generateDraft({ db, ai, message, tone, force = false, now = () => new Date() } = {}) {
  if (!TONES.has(tone)) {
    throw new OutlookServiceError("OUTLOOK_INVALID_DRAFT_REQUEST", "语气只能是 formal / friendly / action。");
  }
  const existing = db.prepare("SELECT * FROM email_drafts WHERE message_id=?").get(message.id);
  if (!shouldRegenerate(existing, tone, force)) {
    return { draft: existing.draft_text, tone, cached: true };
  }
  const ctx = buildDraftContext(message, loadOpenTodos(db), tone);
  let body;
  try {
    const result = await ai.draftReply(ctx);
    body = result?.body;
  } catch (err) {
    throw new OutlookServiceError("OUTLOOK_MODEL_REQUEST_FAILED", `回复草稿生成失败：${err?.message || err}`);
  }
  if (!body || !String(body).trim()) {
    throw new OutlookServiceError("OUTLOOK_MODEL_REQUEST_FAILED", "AI 未返回可用草稿。");
  }
  const text = String(body).trim();
  const ts = now().toISOString();
  db.prepare(
    "INSERT INTO email_drafts(message_id, draft_text, tone, created_at, updated_at) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(message_id) DO UPDATE SET draft_text=excluded.draft_text, tone=excluded.tone, updated_at=excluded.updated_at",
  ).run(message.id, text, tone, ts, ts);
  return { draft: text, tone, cached: false };
}