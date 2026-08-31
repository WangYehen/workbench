import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, ensureDataDir } from "./config.mjs";
import { getDb } from "./db.mjs";
import { ai as defaultAi } from "./ai.mjs";

const DEFAULT_SETTINGS = {
  retentionDays: 180,
  permanent: false,
  initialSyncComplete: false,
  autoTodoThreshold: 90,
  syncIntervalMinutes: 15,
  autoDownloadAttachments: false,
  demoteBotConversations: true,
};
const loginAttempts = new Map();
const CAPABILITY_TTL_MS = 10 * 60 * 1000;

// 机器人 / 通知类会话：这些会话消息量极大（监控告警、构建通知），
// 与「需要 Charles 亲自行动」无关。默认降级，不进待处理视图、不排队进 AI，但照常归档。
const BOT_PATTERNS = [
  /机器人$/, /bot$/i, /预警/, /告警/, /监控/, /通知/, /提醒/, /助手/,
  /^dws/i, /webhook/i, /流水/, /日报$/, /播报/, /巡检/, /运维/,
];

function nowIso() { return new Date().toISOString(); }
function parseJson(text) {
  const lines = String(text || "").trim().split(/\r?\n/).reverse();
  for (const line of lines) { try { return JSON.parse(line); } catch { /* try previous line */ } }
  try { return JSON.parse(text); } catch { return null; }
}
function asArray(value) { return Array.isArray(value) ? value : []; }
function valueAt(data, paths, fallback = null) {
  for (const pathValue of paths) {
    let current = data;
    for (const key of pathValue.split(".")) current = current?.[key];
    if (current != null && current !== "") return current;
  }
  return fallback;
}
function pickList(payload, keys) {
  for (const key of keys) {
    const value = valueAt(payload, [key]);
    if (Array.isArray(value)) return value;
  }
  return [];
}
function safeSegment(value) {
  const label = String(value || "未知").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 48) || "未知";
  const digest = crypto.createHash("sha256").update(String(value || "unknown")).digest("hex").slice(0, 12);
  return `${label}__${digest}`;
}
function day(value) { return new Date(value).toISOString().slice(0, 10); }
// DWS 接受 "YYYY-MM-DD HH:mm:ss"（本地时区），不接受带 T 的 ISO8601 尾缀 Z。
function dwsTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function looksLikeBot(...names) {
  return names.some((name) => {
    const text = String(name || "").trim();
    if (!text) return false;
    return BOT_PATTERNS.some((pattern) => pattern.test(text));
  });
}
function getState(db, key, fallback = null) {
  const row = db.prepare("SELECT value_json FROM sync_state WHERE key=?").get(key);
  try { return row ? JSON.parse(row.value_json) : fallback; } catch { return fallback; }
}
function setState(db, key, value) {
  db.prepare("INSERT INTO sync_state(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json")
    .run(key, JSON.stringify(value));
}

// DWS 的「完整性 ledger」：命令可能因分页失败返回退出码非 0，但 stdout 里仍带着已取得的数据。
// 任何不完整都必须保留数据并把结果标记为 partial，绝不能把部分结果当成完整，也不能整批丢弃。
function readLedger(payload, exitCode = 0) {
  const failures = asArray(payload?.failures);
  const hasMore = payload?.hasMore === true;
  const partialFlag = payload?.partial === true;
  const completeFlag = payload?.complete === true;
  const failedCount = typeof payload?.failedCount === "number" ? payload.failedCount : failures.length;
  const hasLedger = completeFlag || partialFlag || hasMore || failedCount > 0
    || payload?.stopReason != null || payload?.pagesFetched != null || payload?.paginationKnown != null;
  const partial = partialFlag || hasMore || failedCount > 0 || exitCode !== 0 || (hasLedger && !completeFlag);
  return {
    known: hasLedger,
    complete: hasLedger ? completeFlag && !hasMore && failedCount === 0 && exitCode === 0 : null,
    partial,
    hasMore,
    failedCount,
    failures: failures.slice(0, 20),
    nextCursor: payload?.nextCursor ?? null,
    stopReason: payload?.stopReason ?? null,
    count: typeof payload?.count === "number" ? payload.count : null,
    exitCode,
  };
}

// DWS 在 resourceRefs[].download.arguments 里直接给出就绪的下载参数（resource-id / type /
// message-id / open-conversation-id），这里原样保留，下载时不必自己猜 CLI 契约。
function extractAttachments(raw) {
  const refs = asArray(raw?.resourceRefs).length ? raw.resourceRefs
    : asArray(raw?.resources).length ? raw.resources
      : asArray(raw?.attachments).length ? raw.attachments : [];
  return refs.map((ref) => {
    if (typeof ref === "string") return { kind: "unknown", ref, name: null, args: null, ready: false };
    return {
      kind: String(valueAt(ref, ["type", "kind", "resourceType"], "unknown")),
      name: valueAt(ref, ["name", "fileName", "title"], null),
      mimeType: valueAt(ref, ["mimeType", "contentType"], null),
      sizeBytes: valueAt(ref, ["size", "fileSize", "sizeBytes"], null),
      ref: valueAt(ref, ["resourceId", "mediaId", "fileId", "downloadCode", "downloadUrl", "url", "id"], null) || ref,
      args: ref?.download?.arguments || null,
      ready: ref?.download?.ready !== false,
      missing: asArray(ref?.download?.missing),
    };
  }).filter((item) => item.ref != null);
}

function messageContent(raw) {
  const content = valueAt(raw, ["content", "text", "msgContent", "messageContent", "body.content"], "");
  return typeof content === "string" ? content : JSON.stringify(content || "");
}
function normalizeMessage(raw, conversationId, fallbackType, { mentionedMe = false, contextOnly = false, contextRootId = null } = {}) {
  const id = String(valueAt(raw, ["messageId", "openMessageId", "id", "msgId"], ""));
  const sent = valueAt(raw, ["createTime", "time", "sentAt", "createAt", "timestamp"], Date.now());
  const date = typeof sent === "number" ? new Date(sent < 1e12 ? sent * 1000 : sent) : new Date(String(sent).replace(" ", "T"));
  const senderName = String(valueAt(raw, ["sender", "senderName", "sender.nick", "sender.name"], ""));
  return {
    id,
    conversation_id: conversationId,
    sender_id: String(valueAt(raw, ["senderId", "senderUserId", "senderOpenDingTalkId", "sender.userId", "sender.id"], "")),
    sender_name: senderName,
    direction: raw?.isSelf || raw?.fromSelf || raw?.senderIsSelf ? "outbound" : "inbound",
    sent_at: Number.isNaN(date.getTime()) ? nowIso() : date.toISOString(),
    message_type: String(valueAt(raw, ["msgType", "messageType", "type"], "text")),
    content: messageContent(raw),
    mentioned_me: mentionedMe || raw?.mentionedMe || raw?.atMe ? 1 : 0,
    context_only: contextOnly ? 1 : 0,
    context_root_id: contextRootId,
    quoted_message_id: valueAt(raw, ["quotedMessage.messageId", "quotedMessage.openMessageId", "quotedMessageId"], null),
    attachments: extractAttachments(raw),
    raw_json: JSON.stringify(raw),
  };
}

export function createDingtalkChatService({ database = getDb, executable = config.dws.executable, dataDir = config.dataDir, run = null, now = () => new Date(), aiService = defaultAi } = {}) {
  // 命令探测缓存挂在实例上：生产单例 10 分钟内复用，测试的每个实例天然隔离。
  const capabilityCache = new Map();
  function db() { return database(); }
  function settings() { return { ...DEFAULT_SETTINGS, ...(getState(db(), "dingtalk_chat_settings", {}) || {}) }; }
  function updateSettings(patch) {
    const next = { ...settings(), ...patch };
    next.retentionDays = next.permanent ? null : Math.max(1, Number(next.retentionDays || 180));
    setState(db(), "dingtalk_chat_settings", next);
    return next;
  }
  function lastSync() { return getState(db(), "dingtalk_chat_last_sync", null); }
  function writeLastSync(value) { setState(db(), "dingtalk_chat_last_sync", value); return value; }

  async function executeRaw(args, { timeoutMs = 45_000 } = {}) {
    if (run) {
      const result = await run(args);
      // 直通模式：测试用它模拟「退出码非 0 但 stdout 仍带数据」的部分成功场景。
      if (result && typeof result === "object" && "exitCode" in result && "stdout" in result) {
        return { stdout: result.stdout, stderr: result.stderr || "", exitCode: result.exitCode };
      }
      return { stdout: typeof result === "string" ? result : JSON.stringify(result ?? ""), exitCode: 0 };
    }
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { shell: false, windowsHide: true });
      let out = ""; let err = "";
      const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error("DWS 命令超时"), { code: "DWS_TIMEOUT" })); }, timeoutMs);
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { err += chunk; });
      child.on("error", (error) => { clearTimeout(timer); reject(Object.assign(new Error(`无法启动 DWS：${error.message}`), { code: "DWS_NOT_INSTALLED" })); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ stdout: out, stderr: err, exitCode: code ?? -1 }); });
    });
  }

  // 退出码非 0 但 stdout 仍带数据（DWS 分页部分失败时的典型行为）时保留数据并标记 partial。
  async function execute(args, { timeoutMs = 45_000 } = {}) {
    const { stdout, stderr, exitCode } = await executeRaw(args, { timeoutMs });
    const payload = parseJson(stdout);
    if (payload == null) {
      const detail = String(stderr || "").trim();
      const message = detail ? detail.split(/\r?\n/)[0].slice(0, 200) : `DWS 退出码 ${exitCode}`;
      throw Object.assign(new Error(message), { code: exitCode === 0 ? "DWS_EMPTY_RESPONSE" : "DWS_COMMAND_FAILED", exitCode });
    }
    return { payload, ledger: readLedger(payload, exitCode) };
  }

  async function probe(args, { timeoutMs = 8000 } = {}) {
    try {
      const { exitCode } = await executeRaw([...args, "--help"], { timeoutMs });
      return exitCode === 0;
    } catch { return false; }
  }

  async function capabilities({ force = false } = {}) {
    const cached = capabilityCache.get("caps");
    if (!force && cached && Date.now() - cached.at < CAPABILITY_TTL_MS) return cached.value;
    const checks = await Promise.all([
      probe(["chat", "+chat-list"]),
      probe(["chat", "+at-me"]),
      probe(["chat", "+chat-messages"]),
      probe(["chat", "+chat-list-all"]),
      probe(["chat", "+conversation-list"]),
      probe(["chat", "+messages-resource-download"]),
      probe(["chat", "+messages-resource-url"]),
      probe(["chat", "message", "list"]),
      probe(["chat", "message", "list-mentions"]),
    ]);
    const value = {
      conversationList: checks[0],
      atMe: checks[1],
      chatMessages: checks[2],
      chatListAll: checks[3],
      conversationListLegacy: checks[4],
      resourceDownload: checks[5],
      resourceUrl: checks[6],
      // 快捷命令不可用时退回原子命令；两条路都断才视为能力缺失。
      conversationsAvailable: checks[0] || checks[3] || checks[4],
      mentionsAvailable: checks[1] || checks[8],
      messagesAvailable: checks[2] || checks[7],
      probedAt: nowIso(),
    };
    // 核心读取能力：任一路径拿得到会话、@我、消息。
    value.coreReady = value.conversationsAvailable && value.mentionsAvailable && value.messagesAvailable;
    capabilityCache.set("caps", { at: Date.now(), value });
    return value;
  }

  async function status({ probeCapabilities = true } = {}) {
    const base = { executable, settings: settings(), lastSync: lastSync() };
    try {
      const version = await execute(["version", "--format", "json"], { timeoutMs: 10_000 });
      let auth = null; let profiles = null;
      try { auth = await execute(["auth", "status", "--format", "json"], { timeoutMs: 10_000 }); } catch { /* 未登录 */ }
      try { profiles = await execute(["profile", "list", "--format", "json"], { timeoutMs: 10_000 }); } catch { /* 可选 */ }
      // 只回传展示所需的字段，绝不把 DWS 的原始认证对象（可能含令牌）透出到前端。
      const authPayload = auth?.payload || {};
      const profileList = asArray(valueAt(profiles?.payload, ["profiles", "result.profiles", "items"], []));
      const current = profileList.find((item) => item?.current || item?.active) || profileList[0] || null;
      return {
        ...base,
        installed: true,
        connected: Boolean(valueAt(authPayload, ["connected", "authenticated", "result.connected", "result.authenticated"], false)),
        version: valueAt(version.payload, ["version", "result.version"], "已安装"),
        account: {
          org: valueAt(authPayload, ["corpName", "orgName", "result.corpName", "tenant"], null),
          user: valueAt(authPayload, ["userName", "nick", "result.userName", "name"], null),
          userId: valueAt(authPayload, ["userId", "result.userId", "unionId"], null),
          profile: valueAt(profiles?.payload, ["currentProfile", "result.currentProfile"], null) || (current ? [current.corpName || current.corpId, current.userName || current.userId].filter(Boolean).join(":") : null),
        },
        capabilities: probeCapabilities ? await capabilities() : null,
      };
    } catch (error) {
      return { ...base, installed: false, connected: false, error: error.message, errorCode: error.code || "DWS_NOT_INSTALLED" };
    }
  }

  function startLogin() {
    const id = crypto.randomUUID();
    const attempt = { id, status: "running", startedAt: nowIso(), error: null, output: "" };
    loginAttempts.set(id, attempt);
    const child = spawn(executable, ["auth", "login"], { shell: false, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; attempt.output = output.slice(-4000); });
    child.stderr.on("data", (chunk) => { output += chunk; attempt.output = output.slice(-4000); });
    child.on("error", (error) => { attempt.status = "failed"; attempt.error = error.message; });
    child.on("close", (code) => {
      attempt.status = code === 0 ? "ready" : "failed";
      attempt.finishedAt = nowIso();
      if (code !== 0) attempt.error = attempt.output || `DWS 退出码 ${code}`;
    });
    return attempt;
  }
  function loginStatus(id) { return loginAttempts.get(id) || null; }

  // 优先 +chat-list（返回 conversationType/chatMode/name）；
  // 不可用时用 +chat-list-all（只返回群）∪ +conversation-list（全部）拼出类型；
  // 两者都不可用才接受无类型的 +conversation-list（此时群聊 @我 无法入库，sync 会提示降级）。
  async function conversations() {
    const caps = await capabilities();
    if (caps.conversationList) {
      const { payload, ledger } = await execute(["chat", "+chat-list", "--types", "group,p2p", "--page-all", "--page-size", "100", "--format", "json"]);
      const items = pickList(payload, ["chats", "conversations", "result.chats", "items"]);
      if (items.length) {
        return {
          items: items.map((raw) => {
            const id = String(valueAt(raw, ["openConversationId", "conversationId", "id"], ""));
            const type = String(valueAt(raw, ["conversationType", "chatMode", "type"], "")).toLowerCase();
            const isGroup = type === "group" || type === "multi";
            const title = String(valueAt(raw, ["name", "conversationName", "title", "nick"], "未命名会话"));
            return {
              id,
              type: isGroup ? "group" : "private",
              chat_mode: valueAt(raw, ["chatMode"], null),
              title,
              peer_user_id: valueAt(raw, ["peerUserId", "userId", "peer.userId"], null),
              peer_name: isGroup ? null : title,
              type_known: 1,
              is_bot: looksLikeBot(title) ? 1 : 0,
            };
          }).filter((item) => item.id && item.id !== "undefined"),
          ledger,
        };
      }
    }
    const list = await execute(["chat", "+conversation-list", "--page-all", "--format", "json"]);
    const items = pickList(list.payload, ["conversations", "result.conversations", "result.items", "items"]);
    let groupIds = new Set();
    let degradedLedger = list.ledger;
    try {
      const groups = await execute(["chat", "+chat-list-all", "--limit", "200", "--page-all", "--format", "json"]);
      const groupItems = pickList(groups.payload, ["chats", "conversations", "groups", "items", "result"]);
      groupIds = new Set(groupItems.map((raw) => String(valueAt(raw, ["openConversationId", "conversationId", "id"], ""))).filter(Boolean));
      if (groups.ledger?.partial) degradedLedger = { ...degradedLedger, partial: true };
    } catch { /* +chat-list-all 不可用：类型只能靠启发式 */ }
    return {
      items: items.map((raw) => {
        const title = String(valueAt(raw, ["conversationName", "title", "name"], "未命名会话"));
        const id = String(valueAt(raw, ["openConversationId", "conversationId", "id"], ""));
        const isGroup = groupIds.has(id) || /群|组/.test(title);
        return {
          id,
          type: isGroup ? "group" : "private",
          chat_mode: null,
          title,
          peer_user_id: null,
          peer_name: isGroup ? null : title,
          type_known: groupIds.has(id) ? 1 : 0,
          is_bot: looksLikeBot(title) ? 1 : 0,
        };
      }).filter((item) => item.id && item.id !== "undefined"),
      ledger: { ...degradedLedger, degraded: true },
    };
  }

  // @我：优先 +at-me（扁平 items，含 conversation/quotedMessage/resourceRefs）；
  // 降级到原子命令时，其结构是 {conversationId, messages:[...]} 的分组嵌套，必须展平。
  async function listMentions({ days = 30 } = {}) {
    const caps = await capabilities();
    if (caps.atMe) {
      const { payload, ledger } = await execute(["chat", "+at-me", "--days", String(Math.max(1, Math.min(3650, days))), "--page-all", "--limit", "100", "--format", "json"]);
      const items = pickList(payload, ["items", "messages", "result.items"]);
      return {
        items: items.map((raw) => ({
          raw,
          conversationId: String(valueAt(raw, ["conversationId", "conversation.openConversationId", "openConversationId"], "")),
          conversationTitle: valueAt(raw, ["conversation.name", "conversationName"], null),
        })).filter((item) => item.conversationId && item.conversationId !== "undefined"),
        ledger,
      };
    }
    const end = now(); const start = new Date(end.getTime() - days * 86400000);
    const { payload, ledger } = await execute(["chat", "message", "list-mentions", "--start", dwsTime(start), "--end", dwsTime(end), "--page-all", "--format", "json"]);
    const groups = pickList(payload, ["result.conversationMessagesList", "conversationMessagesList", "result.items", "items"]);
    const items = [];
    for (const group of groups) {
      const conversationId = String(valueAt(group, ["openConversationId", "conversationId"], ""));
      for (const raw of asArray(group?.messages)) {
        items.push({ raw: { ...raw, conversationId }, conversationId, conversationTitle: valueAt(group, ["conversationName", "title"], null) });
      }
    }
    return { items: items.filter((item) => item.conversationId && item.conversationId !== "undefined"), ledger: { ...ledger, degraded: true } };
  }

  async function fetchMessages(conversationId, start, end) {
    const caps = await capabilities();
    if (caps.chatMessages) {
      const args = ["chat", "+chat-messages", "--group", conversationId, "--order", "asc", "--page-all", "--format", "json"];
      const from = dwsTime(start); const to = dwsTime(end);
      if (from) args.push("--start", from);
      if (to) args.push("--end", to);
      const { payload, ledger } = await execute(args);
      return { items: pickList(payload, ["messages", "items", "result.messages"]), ledger };
    }
    const time = dwsTime(start) || dwsTime(new Date(now().getTime() - 86400000));
    const { payload, ledger } = await execute(["chat", "message", "list", "--group", conversationId, "--time", time, "--direction", "newer", "--limit", "100", "--format", "json"]);
    return { items: pickList(payload, ["messages", "result.messages", "result.items"]), ledger: { ...ledger, degraded: true } };
  }

  function upsertConversation(item) {
    const stamp = nowIso();
    const existing = db().prepare("SELECT * FROM dingtalk_chat_conversations WHERE id=?").get(item.id);
    db().prepare(`INSERT INTO dingtalk_chat_conversations(id,type,title,peer_user_id,peer_name,enabled,retention_mode,last_message_at,sync_cursor_json,created_at,updated_at,chat_mode,is_bot,type_known,last_sync_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        type=CASE WHEN excluded.type_known=1 THEN excluded.type ELSE dingtalk_chat_conversations.type END,
        title=excluded.title,peer_user_id=COALESCE(excluded.peer_user_id,dingtalk_chat_conversations.peer_user_id),
        peer_name=COALESCE(excluded.peer_name,dingtalk_chat_conversations.peer_name),
        chat_mode=COALESCE(excluded.chat_mode,dingtalk_chat_conversations.chat_mode),
        is_bot=excluded.is_bot,type_known=MAX(excluded.type_known,dingtalk_chat_conversations.type_known),
        updated_at=excluded.updated_at`)
      .run(
        item.id, item.type, item.title, item.peer_user_id, item.peer_name,
        existing?.enabled ?? 1, existing?.retention_mode || "inherit", existing?.last_message_at || null,
        existing?.sync_cursor_json || null, existing?.created_at || stamp, stamp,
        item.chat_mode ?? existing?.chat_mode ?? null, item.is_bot ?? existing?.is_bot ?? 0,
        item.type_known ?? 0, existing?.last_sync_json ?? null,
      );
  }

  // 每日 JSONL 由数据库全量重建后经临时文件原子替换：
  // 既保证重试不产生重复行，也能在消息被保留期清理后自动从归档中消失。
  async function archive(days) {
    if (!days.length) return;
    ensureDataDir();
    const root = path.join(dataDir, "dingtalk-messages");
    const rows = db().prepare(
      `SELECT m.*, c.type AS conversation_type, c.title AS conversation_title, c.peer_name
       FROM dingtalk_chat_messages m JOIN dingtalk_chat_conversations c ON c.id=m.conversation_id
       WHERE m.sent_at >= ? AND m.sent_at < ?`,
    ).all(`${days[0]}T00:00:00.000Z`, `${days[days.length - 1]}T23:59:59.999Z`);
    const buckets = new Map();
    for (const row of rows) {
      if (!days.includes(day(row.sent_at))) continue;
      const isGroup = row.conversation_type === "group";
      const label = isGroup ? row.conversation_title : (row.peer_name || row.sender_name || row.conversation_title);
      const directory = path.join(root, isGroup ? "mentions" : "private", safeSegment(`${label}:${row.conversation_id}`));
      const key = `${directory}|${day(row.sent_at)}`;
      if (!buckets.has(key)) buckets.set(key, { directory, file: path.join(directory, `${day(row.sent_at)}.jsonl`), conversationId: row.conversation_id, title: row.conversation_title, peerName: label, rows: [] });
      buckets.get(key).rows.push(row);
    }
    for (const item of buckets.values()) {
      await fs.mkdir(item.directory, { recursive: true });
      item.rows.sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));
      const body = item.rows.map((row) => JSON.stringify({
        id: row.id, conversation_id: row.conversation_id, conversation_title: row.conversation_title,
        sender_id: row.sender_id, sender_name: row.sender_name, direction: row.direction,
        sent_at: row.sent_at, message_type: row.message_type, content: row.content,
        mentioned_me: row.mentioned_me, context_only: row.context_only, context_root_id: row.context_root_id,
        quoted_message_id: row.quoted_message_id, processing_status: row.processing_status,
      })).join("\n");
      const temp = `${item.file}.${process.pid}.tmp`;
      await fs.writeFile(temp, body ? `${body}\n` : "", "utf8");
      await fs.rename(temp, item.file);
      await fs.writeFile(path.join(item.directory, "manifest.json"), JSON.stringify({
        conversationId: item.conversationId, title: item.title, peerName: item.peerName, updatedAt: nowIso(),
      }, null, 2), "utf8");
    }
  }

  // 会话类型在 2026-08-31 之前识别错误（DWS +conversation-list 不返回类型），
  // 历史消息可能以「普通消息」身份入库。重新插入时按 upsert 修正语义：
  // @我 标记取或（命中即置 1）、上下文标记取与（根消息优先）、空字段补齐。
  async function insertMessages(rows) {
    const stamp = nowIso();
    const added = [];
    if (!rows.length) return added;
    const valid = rows.filter((row) => row.id && row.id !== "undefined" && row.id !== "null");
    const ids = valid.map((row) => row.id);
    const existing = new Set();
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const found = db().prepare(`SELECT id FROM dingtalk_chat_messages WHERE id IN (${part.map(() => "?").join(",")})`).all(...part);
      for (const row of found) existing.add(row.id);
    }
    const insert = db().prepare(`INSERT INTO dingtalk_chat_messages(id,conversation_id,sender_id,sender_name,direction,sent_at,message_type,content,mentioned_me,context_only,context_root_id,quoted_message_id,raw_json,archive_path,processing_status,attachment_count,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const reconcile = db().prepare(`UPDATE dingtalk_chat_messages SET
      mentioned_me=MAX(mentioned_me, ?),
      context_only=CASE WHEN mentioned_me=1 THEN context_only ELSE MAX(context_only, ?) END,
      context_root_id=COALESCE(context_root_id, ?),
      sender_id=COALESCE(NULLIF(sender_id,''), ?),
      sender_name=COALESCE(NULLIF(sender_name,''), ?),
      content=COALESCE(NULLIF(content,''), ?),
      attachment_count=MAX(attachment_count, ?),
      raw_json=COALESCE(raw_json, ?),
      updated_at=? WHERE id=?`);
    const attach = db().prepare(`INSERT INTO dingtalk_chat_attachments(id,message_id,conversation_id,kind,name,mime_type,size_bytes,ref_json,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM dingtalk_chat_attachments WHERE message_id=? AND ref_json=?)`);
    const tx = db().transaction((items) => {
      for (const row of items) {
        if (existing.has(row.id)) {
          reconcile.run(row.mentioned_me, row.context_only, row.context_root_id, row.sender_id, row.sender_name, row.content, row.attachments?.length || 0, row.raw_json, stamp, row.id);
          continue;
        }
        insert.run(row.id, row.conversation_id, row.sender_id, row.sender_name, row.direction, row.sent_at, row.message_type, row.content, row.mentioned_me, row.context_only, row.context_root_id, row.quoted_message_id, row.raw_json, null, "new", row.attachments?.length || 0, stamp, stamp);
        added.push(row);
      }
      for (const row of items) {
        for (const item of row.attachments || []) {
          const refJson = JSON.stringify({ ref: item.ref, args: item.args || null, ready: item.ready !== false });
          attach.run(crypto.randomUUID(), row.id, row.conversation_id, item.kind, item.name, item.mimeType, item.sizeBytes == null ? null : Number(item.sizeBytes) || null, refJson, stamp, row.id, refJson);
        }
      }
    });
    tx(valid);
    return added;
  }

  function updateConversationWatermark(id, messages) {
    if (!messages.length) return;
    const last = messages.map((item) => item.sent_at).sort().at(-1);
    db().prepare("UPDATE dingtalk_chat_conversations SET last_message_at=COALESCE(MAX(COALESCE(last_message_at,''), ?), ?), sync_cursor_json=?, updated_at=? WHERE id=?")
      .run(last, last, JSON.stringify({ lastMessageAt: last, updatedAt: nowIso() }), nowIso(), id);
  }

  function setConversationSyncResult(id, result) {
    db().prepare("UPDATE dingtalk_chat_conversations SET last_sync_json=?, updated_at=? WHERE id=?").run(JSON.stringify(result), nowIso(), id);
  }

  async function sync({ days = 30 } = {}) {
    const current = await status();
    if (!current.installed) throw Object.assign(new Error("未检测到 DWS，请先在设置页按指引安装。"), { code: "DWS_NOT_INSTALLED", retryable: false });
    if (!current.connected) throw Object.assign(new Error("DWS 尚未登录，请先连接个人钉钉账号。"), { code: "DWS_NOT_AUTHENTICATED", retryable: false });
    const caps = await capabilities();
    if (!caps.coreReady) {
      throw Object.assign(new Error("当前 DWS 缺少会话列表、@我 或消息读取能力，请升级 DWS 后重试。"), { code: "DWS_CAPABILITY_MISSING", retryable: false, capabilities: caps });
    }

    const cfg = settings();
    const first = !cfg.initialSyncComplete;
    const started = now();
    const backfillDays = first ? days : 1;
    const start = new Date(started.getTime() - backfillDays * 86400000);
    const problems = [];
    const added = [];

    const list = await conversations();
    if (list.ledger?.partial) problems.push({ scope: "conversations", ...list.ledger });
    for (const item of list.items) upsertConversation(item);

    // 私聊：完整双向。增量时用「上次水位 - 15 分钟」重叠窗口，避免边界丢消息。
    const stored = db().prepare("SELECT * FROM dingtalk_chat_conversations").all();
    for (const conversation of stored.filter((item) => item.type === "private")) {
      const since = first ? start : new Date(Math.max(start.getTime(), Date.parse(conversation.last_message_at || "") - 15 * 60000 || 0));
      try {
        const { items, ledger } = await fetchMessages(conversation.id, since, started);
        if (ledger?.partial) problems.push({ scope: `private:${conversation.title || conversation.id}`, ...ledger });
        const rows = items.map((item) => normalizeMessage(item, conversation.id, "private"));
        added.push(...await insertMessages(rows));
        updateConversationWatermark(conversation.id, rows);
        setConversationSyncResult(conversation.id, { at: nowIso(), count: rows.length, partial: Boolean(ledger?.partial) });
      } catch (error) {
        problems.push({ scope: `private:${conversation.title || conversation.id}`, error: error.message, code: error.code || null });
      }
    }

    // 群聊：只取 @我 的根消息，再补前后各 10 条上下文（上下文不单独触发 AI）。
    const mentions = await listMentions({ days: backfillDays });
    if (mentions.ledger?.partial) problems.push({ scope: "mentions", ...mentions.ledger });
    const mentionIds = new Set();
    for (const entry of mentions.items) {
      const conversation = db().prepare("SELECT * FROM dingtalk_chat_conversations WHERE id=? AND type='group' AND enabled=1").get(entry.conversationId);
      if (!conversation) continue;
      const root = normalizeMessage(entry.raw, entry.conversationId, "group", { mentionedMe: true });
      if (!root.id || root.id === "null") continue;
      const inserted = await insertMessages([root]);
      mentionIds.add(root.id);
      added.push(...inserted);
      try {
        const windowStart = new Date(Date.parse(root.sent_at) - 60 * 60000);
        const windowEnd = new Date(Date.parse(root.sent_at) + 60 * 60000);
        const { items, ledger } = await fetchMessages(entry.conversationId, windowStart, windowEnd);
        if (ledger?.partial) problems.push({ scope: `mention-context:${conversation.title || entry.conversationId}`, ...ledger });
        const normalized = items.map((item) => normalizeMessage(item, entry.conversationId, "group", { contextOnly: true, contextRootId: root.id }));
        const index = normalized.findIndex((item) => item.id === root.id);
        const context = index >= 0
          ? normalized.slice(Math.max(0, index - 10), index + 11).filter((item) => item.id !== root.id)
          : normalized.slice(-20);
        added.push(...await insertMessages(context));
        updateConversationWatermark(entry.conversationId, [root, ...context]);
        setConversationSyncResult(entry.conversationId, { at: nowIso(), rootId: root.id, context: context.length, partial: Boolean(ledger?.partial) });
      } catch (error) {
        problems.push({ scope: `mention-context:${conversation.title || entry.conversationId}`, error: error.message, code: error.code || null });
      }
    }

    if (first) updateSettings({ initialSyncComplete: true });
    const purged = await cleanup();
    const touchedDays = [...new Set(added.map((row) => day(row.sent_at)))].sort();
    if (touchedDays.length) await archive(touchedDays);

    const result = {
      added, count: added.length, firstSync: first, conversations: stored.length,
      mentions: mentionIds.size, purged,
      complete: problems.length === 0,
      partial: problems.length > 0,
      problems: problems.slice(0, 20),
      capabilities: caps,
      finishedAt: nowIso(),
    };
    writeLastSync({ ...result, added: undefined });
    return result;
  }

  async function cleanup() {
    const cfg = settings();
    if (cfg.permanent || !cfg.retentionDays) return 0;
    const cutoff = new Date(now().getTime() - cfg.retentionDays * 86400000).toISOString();
    const rows = db().prepare("SELECT id, sent_at FROM dingtalk_chat_messages WHERE sent_at<? AND conversation_id IN (SELECT id FROM dingtalk_chat_conversations WHERE retention_mode!='permanent')").all(cutoff);
    if (!rows.length) return 0;
    const days = [...new Set(rows.map((row) => day(row.sent_at)))];
    const changed = db().prepare("DELETE FROM dingtalk_chat_messages WHERE sent_at<? AND conversation_id IN (SELECT id FROM dingtalk_chat_conversations WHERE retention_mode!='permanent')").run(cutoff).changes;
    // 归档跟着数据库一起收缩，避免归档里留下已过保留期的原文。
    if (days.length) await archive(days).catch(() => {});
    return changed;
  }

  function listConversations() {
    return db().prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM dingtalk_chat_messages m WHERE m.conversation_id=c.id AND m.context_only=0 AND m.processing_status IN ('new','needs_confirmation')) AS open_count,
      (SELECT COUNT(*) FROM dingtalk_chat_messages m WHERE m.conversation_id=c.id AND m.context_only=0 AND m.processing_status IN ('new','needs_confirmation')) AS pending_count,
      (SELECT COUNT(*) FROM dingtalk_chat_messages m WHERE m.conversation_id=c.id) AS message_count,
      (SELECT MAX(m.sent_at) FROM dingtalk_chat_messages m WHERE m.conversation_id=c.id) AS last_message_at
      FROM dingtalk_chat_conversations c ORDER BY c.is_bot, c.type, c.title COLLATE NOCASE`).all();
  }
  function setConversation(id, patch) {
    const item = db().prepare("SELECT * FROM dingtalk_chat_conversations WHERE id=?").get(id);
    if (!item) throw Object.assign(new Error("未找到会话"), { code: "NOT_FOUND" });
    db().prepare("UPDATE dingtalk_chat_conversations SET enabled=COALESCE(?,enabled), retention_mode=COALESCE(?,retention_mode), is_bot=COALESCE(?,is_bot), updated_at=? WHERE id=?")
      .run(patch.enabled == null ? null : patch.enabled ? 1 : 0, patch.retention_mode || null, patch.isBot == null ? null : patch.isBot ? 1 : 0, nowIso(), id);
    return db().prepare("SELECT * FROM dingtalk_chat_conversations WHERE id=?").get(id);
  }

  // 行动箱消息列表。上下文消息（context_only=1）永不进入行动列表；
  // 「全部」表示符合行动箱展示规则的消息（待处理/AI待确认/已建待办/已关联），不含仅供知晓与已过滤。
  function listMessages({ conversationId, status = null, limit = 100, offset = 0, includeBots = true, q = null } = {}) {
    const filters = []; const values = [];
    filters.push("m.context_only=0");
    if (conversationId) { filters.push("m.conversation_id=?"); values.push(conversationId); }
    if (status === "linked") {
      filters.push("EXISTS (SELECT 1 FROM work_links w WHERE w.source_type='dingtalk_message' AND w.source_id=m.id AND w.status IN ('auto','confirmed'))");
    } else if (status) { filters.push("m.processing_status=?"); values.push(status); }
    else {
      filters.push(`(m.processing_status IN ('new','needs_confirmation','task_created','processed')
        OR EXISTS (SELECT 1 FROM work_links w WHERE w.source_type='dingtalk_message' AND w.source_id=m.id AND w.status IN ('auto','confirmed')))`);
    }
    if (!includeBots) filters.push("COALESCE(c.is_bot,0)=0");
    if (q) { filters.push("(m.content LIKE ? OR m.sender_name LIKE ?)"); values.push(`%${q}%`, `%${q}%`); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return db().prepare(`SELECT m.*, c.title AS conversation_title, c.type AS conversation_type, c.is_bot AS conversation_is_bot,
      a.classification,a.summary,a.action_text,a.due_date,a.priority,a.confidence,a.assignee_self,a.todo_id
      FROM dingtalk_chat_messages m JOIN dingtalk_chat_conversations c ON c.id=m.conversation_id
      LEFT JOIN dingtalk_message_analysis a ON a.message_id=m.id ${where}
      ORDER BY m.sent_at DESC LIMIT ? OFFSET ?`).all(...values, Math.min(300, Math.max(1, Number(limit) || 100)), Math.max(0, Number(offset) || 0));
  }

  function countByStatus({ conversationId = null, includeBots = true } = {}) {
    const filters = []; const values = [];
    filters.push("m.context_only=0");
    if (conversationId) { filters.push("m.conversation_id=?"); values.push(conversationId); }
    if (!includeBots) filters.push("COALESCE(c.is_bot,0)=0");
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db().prepare(`SELECT m.processing_status AS status, COUNT(*) AS count
      FROM dingtalk_chat_messages m JOIN dingtalk_chat_conversations c ON c.id=m.conversation_id
      ${where} GROUP BY m.processing_status`).all(...values);
    const linkFilters = ["w.source_type='dingtalk_message'", "w.status IN ('auto','confirmed')", "m.context_only=0"];
    const linkValues = [];
    if (conversationId) { linkFilters.push("m.conversation_id=?"); linkValues.push(conversationId); }
    if (!includeBots) linkFilters.push("COALESCE(c.is_bot,0)=0");
    const linked = db().prepare(`SELECT COUNT(DISTINCT w.source_id) AS count FROM work_links w
      JOIN dingtalk_chat_messages m ON m.id=w.source_id JOIN dingtalk_chat_conversations c ON c.id=m.conversation_id
      WHERE ${linkFilters.join(" AND ")}`).get(...linkValues);
    const actionable = db().prepare(`SELECT COUNT(*) AS count FROM dingtalk_chat_messages m
      JOIN dingtalk_chat_conversations c ON c.id=m.conversation_id ${where}
      AND (m.processing_status IN ('new','needs_confirmation','task_created','processed')
        OR EXISTS (SELECT 1 FROM work_links w WHERE w.source_type='dingtalk_message' AND w.source_id=m.id AND w.status IN ('auto','confirmed')))`).get(...values);
    return {
      total: actionable?.count || 0,
      new: rows.find((row) => row.status === "new")?.count || 0,
      needs_confirmation: rows.find((row) => row.status === "needs_confirmation")?.count || 0,
      task_created: rows.find((row) => row.status === "task_created")?.count || 0,
      informational: rows.find((row) => row.status === "informational")?.count || 0,
      processed: rows.find((row) => row.status === "processed")?.count || 0,
      ignored: rows.find((row) => row.status === "ignored")?.count || 0,
      linked: linked?.count || 0,
    };
  }

  function message(id) {
    const item = db().prepare(`SELECT m.*, c.title AS conversation_title, c.type AS conversation_type, c.is_bot AS conversation_is_bot,
      a.classification,a.summary,a.action_text,a.due_date,a.priority,a.confidence,a.assignee_self,a.todo_id, a.ai_meta_json,
      a.draft_title,a.draft_note,a.draft_priority,a.draft_due_date,a.draft_rationale,a.draft_generated_at
      FROM dingtalk_chat_messages m JOIN dingtalk_chat_conversations c ON c.id=m.conversation_id
      LEFT JOIN dingtalk_message_analysis a ON a.message_id=m.id WHERE m.id=?`).get(id);
    if (!item) return null;
    // 上下文取「同一根消息」的窗口；根消息自身用其前后各 10 条，不带根的（私聊）取时间邻近。
    const context = item.context_root_id
      ? db().prepare("SELECT * FROM dingtalk_chat_messages WHERE context_root_id=? AND id!=? ORDER BY sent_at").all(item.context_root_id, item.id)
      : db().prepare("SELECT * FROM dingtalk_chat_messages WHERE context_root_id=? AND id!=? ORDER BY sent_at").all(item.id, item.id);
    const fallback = context.length || item.conversation_type === "group" ? [] : db().prepare(
      `SELECT * FROM (SELECT * FROM dingtalk_chat_messages WHERE conversation_id=? AND sent_at<=? AND id!=? ORDER BY sent_at DESC LIMIT 10)
       UNION ALL SELECT * FROM (SELECT * FROM dingtalk_chat_messages WHERE conversation_id=? AND sent_at>=? AND id!=? ORDER BY sent_at LIMIT 10)
       ORDER BY sent_at`,
    ).all(item.conversation_id, item.sent_at, item.id, item.conversation_id, item.sent_at, item.id);
    const links = db().prepare("SELECT * FROM work_links WHERE source_type='dingtalk_message' AND source_id=? ORDER BY confidence DESC").all(id);
    const attachments = db().prepare("SELECT * FROM dingtalk_chat_attachments WHERE message_id=? ORDER BY created_at").all(id);
    return { ...item, context: context.length ? context : fallback, links, attachments };
  }

  function setMessageStatus(id, processingStatus) {
    const allowed = ["new", "needs_confirmation", "task_created", "informational", "processed", "ignored"];
    if (!allowed.includes(processingStatus)) throw Object.assign(new Error(`不支持的消息状态：${processingStatus}`), { code: "INVALID_STATUS" });
    db().prepare("UPDATE dingtalk_chat_messages SET processing_status=?, updated_at=? WHERE id=?").run(processingStatus, nowIso(), id);
    return message(id);
  }

  // AI 生成待办草稿：已生成过（draft_generated_at 有值）则直接返回缓存，避免反复调用 AI；
  // 用于老消息（此功能上线前已分析、无草稿）或用户主动重新生成。
  async function generateTodoDraft(id) {
    const item = message(id);
    if (!item) throw Object.assign(new Error("未找到消息"), { code: "NOT_FOUND" });
    const current = db().prepare("SELECT * FROM dingtalk_message_analysis WHERE message_id=?").get(id);
    if (current?.draft_generated_at && current.draft_title) {
      return { item: message(id), cached: true };
    }
    const context = (item.context || []).map((ctx) => ({ sender_name: ctx.sender_name, content: ctx.content, sent_at: ctx.sent_at }));
    const result = await aiService.analyzeDingtalkMessage({ ...item, context });
    const stamp = nowIso();
    db().prepare(`INSERT INTO dingtalk_message_analysis(message_id,classification,summary,action_text,due_date,priority,confidence,assignee_self,ai_meta_json,todo_id,draft_title,draft_note,draft_priority,draft_due_date,draft_rationale,draft_generated_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(message_id) DO UPDATE SET classification=excluded.classification,summary=excluded.summary,action_text=excluded.action_text,due_date=excluded.due_date,priority=excluded.priority,confidence=excluded.confidence,assignee_self=excluded.assignee_self,ai_meta_json=excluded.ai_meta_json,draft_title=excluded.draft_title,draft_note=excluded.draft_note,draft_priority=excluded.draft_priority,draft_due_date=excluded.draft_due_date,draft_rationale=excluded.draft_rationale,draft_generated_at=excluded.draft_generated_at,updated_at=excluded.updated_at`)
      .run(id, result.classification, result.summary, result.actionText, result.dueDate, result.priority, result.confidence, result.assigneeSelf ? 1 : 0, JSON.stringify(result.aiMeta || null), null,
        result.draftTitle || result.actionText || (item.content || "").slice(0, 40), result.draftNote || null, result.draftPriority || result.priority || "P2", result.draftDueDate || null, result.draftRationale || null, stamp, stamp, stamp);
    return { item: message(id), cached: false };
  }

  // 用户确认创建待办：先写入消息关联的 AI 判断/草稿字段（含用户编辑后的草稿），再创建待办。
  // 以消息 ID + source_type 幂等：同一消息只创建一个待办，重复确认返回同一待办。
  function confirmTodoDraft(id, draftPatch = {}) {
    const item = message(id);
    if (!item) throw Object.assign(new Error("未找到消息"), { code: "NOT_FOUND" });
    const existing = db().prepare("SELECT * FROM todos WHERE source_type='dingtalk_message' AND source_id=?").get(id);
    const analysis = db().prepare("SELECT * FROM dingtalk_message_analysis WHERE message_id=?").get(id);
    const stamp = nowIso();
    const priority = draftPatch.priority || analysis?.draft_priority || analysis?.priority || "P2";
    const dueDate = draftPatch.dueDate || analysis?.draft_due_date || analysis?.due_date || null;
    const title = String(draftPatch.title || analysis?.draft_title || analysis?.action_text || analysis?.summary || "").trim();
    const note = String(draftPatch.note || analysis?.draft_note || "").trim();
    const rationale = String(draftPatch.rationale ?? analysis?.draft_rationale ?? "").trim();
    if (!title) throw Object.assign(new Error("待办草稿缺少标题，无法创建"), { code: "DRAFT_INCOMPLETE" });
    if (!existing) {
      const todo = { id: `t${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}` };
      const fullNote = [note, rationale ? `【生成依据】${rationale}` : "", `来源：${item.conversation_title || "钉钉消息"} · ${item.sender_name || "成员"} · ${item.content || ""}`]
        .filter(Boolean).join("\n").slice(0, 2000);
      db().prepare("INSERT INTO todos(id,title,note,status,priority,due_date,created_at,completed_at,source_type,source_id,project_id,assignee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(todo.id, title, fullNote, "inbox", priority, dueDate, stamp, null, "dingtalk_message", id, null, null);
      db().prepare("UPDATE dingtalk_message_analysis SET draft_title=?,draft_note=?,draft_priority=?,draft_due_date=?,draft_rationale=?,draft_generated_at=?,todo_id=?,updated_at=? WHERE message_id=?")
        .run(title, note, priority, dueDate, rationale, analysis?.draft_generated_at || stamp, todo.id, stamp, id);
      db().prepare("UPDATE dingtalk_chat_messages SET processing_status='task_created',updated_at=? WHERE id=?").run(stamp, id);
      return { item: message(id), todo: db().prepare("SELECT * FROM todos WHERE id=?").get(todo.id), created: true };
    }
    // 存在待办：仅同步草稿内容，不重复创建。
    if (analysis) db().prepare("UPDATE dingtalk_message_analysis SET draft_title=?,draft_note=?,draft_priority=?,draft_due_date=?,draft_rationale=?,draft_generated_at=?,updated_at=? WHERE message_id=?")
      .run(title, note, priority, dueDate, rationale, analysis?.draft_generated_at || stamp, stamp, id);
    return { item: message(id), todo: existing, created: false };
  }

  function createTodo(id) {
    const item = message(id);
    if (!item) throw Object.assign(new Error("未找到消息"), { code: "NOT_FOUND" });
    const existing = db().prepare("SELECT * FROM todos WHERE source_type='dingtalk_message' AND source_id=?").get(id);
    if (existing) return existing;
    const analysis = db().prepare("SELECT * FROM dingtalk_message_analysis WHERE message_id=?").get(id);
    const todo = {
      id: `t${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      title: analysis?.action_text || analysis?.summary || item.content?.slice(0, 80) || "处理钉钉消息",
      priority: analysis?.priority || "P2",
      dueDate: analysis?.due_date || null,
    };
    db().prepare("INSERT INTO todos(id,title,note,status,priority,due_date,created_at,completed_at,source_type,source_id,project_id,assignee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(todo.id, todo.title, `来自钉钉：${item.sender_name || "成员"} · ${item.content || ""}`.slice(0, 2000), "inbox", todo.priority, todo.dueDate, nowIso(), null, "dingtalk_message", id, null, null);
    db().prepare("UPDATE dingtalk_message_analysis SET todo_id=?,updated_at=? WHERE message_id=?").run(todo.id, nowIso(), id);
    db().prepare("UPDATE dingtalk_chat_messages SET processing_status='task_created',updated_at=? WHERE id=?").run(nowIso(), id);
    return db().prepare("SELECT * FROM todos WHERE id=?").get(todo.id);
  }

  function setLink(id, status) {
    const result = db().prepare("UPDATE work_links SET status=?,updated_at=? WHERE id=? AND status!=?").run(status, nowIso(), id, status);
    if (!result.changes) {
      const existing = db().prepare("SELECT * FROM work_links WHERE id=?").get(id);
      if (!existing) throw Object.assign(new Error("未找到关联"), { code: "NOT_FOUND" });
    }
    return db().prepare("SELECT * FROM work_links WHERE id=?").get(id);
  }

  async function downloadAttachment(messageId, attachmentId) {
    const item = db().prepare("SELECT * FROM dingtalk_chat_attachments WHERE id=? AND message_id=?").get(attachmentId, messageId);
    if (!item) throw Object.assign(new Error("未找到附件"), { code: "NOT_FOUND" });
    if (item.local_path && !item.download_error) return item;
    const caps = await capabilities();
    if (!caps.resourceDownload) throw Object.assign(new Error("当前 DWS 不支持附件下载，请升级后重试。"), { code: "DWS_CAPABILITY_MISSING" });
    const message = db().prepare("SELECT * FROM dingtalk_chat_messages WHERE id=?").get(messageId);
    const conversation = db().prepare("SELECT * FROM dingtalk_chat_conversations WHERE id=?").get(item.conversation_id);
    const directory = path.join(dataDir, "dingtalk-messages", conversation?.type === "group" ? "mentions" : "private", safeSegment(`${conversation?.title || "会话"}:${item.conversation_id}`), "attachments");
    await fs.mkdir(directory, { recursive: true });

    const stored = (() => { try { return JSON.parse(item.ref_json) || {}; } catch { return {}; } })();
    // DWS 给了就绪的下载参数就原样复用；否则用存储的引用兜底。
    const provided = stored.args || {};
    const resourceType = ["mediaId", "fileId"].includes(provided.type) ? provided.type : "mediaId";
    const resourceId = provided["resource-id"] || String(stored.ref || "");
    if (!resourceId) throw Object.assign(new Error("附件缺少可下载的资源标识"), { code: "ATTACHMENT_REF_MISSING" });
    const args = ["chat", "+messages-resource-download", "--resource-id", resourceId, "--type", resourceType];
    if (resourceType === "mediaId") {
      args.push("--message-id", provided["message-id"] || message?.id || messageId);
      args.push("--open-conversation-id", provided["open-conversation-id"] || item.conversation_id);
    }
    // --output 只接受工作目录内的相对路径：先落到 cwd 下的暂存目录，下载完成后再移动到数据目录。
    const staging = path.join(process.cwd(), ".local", "dws-downloads", item.id);
    await fs.mkdir(staging, { recursive: true });
    args.push("--output", path.relative(process.cwd(), staging));
    let target = path.join(directory, safeSegment(item.name || item.id).slice(0, 60));
    if (await fs.stat(target).then(() => true, () => false)) {
      target = path.join(directory, `${Date.now()}_${safeSegment(item.name || item.id).slice(0, 50)}`);
    }
    try {
      const { stdout, stderr, exitCode } = await executeRaw(args, { timeoutMs: 120_000 });
      if (exitCode !== 0) throw new Error(String(stderr || stdout || "").trim().split(/\r?\n/)[0].slice(0, 200) || `DWS 退出码 ${exitCode}`);
      // DWS 可能把文件直接放进 --output 目录，也可能返回路径；两种都支持。
      const candidates = [path.join(staging, item.name || ""), path.join(staging, resourceId.slice(-20)), ...await fs.readdir(staging).catch(() => []).map((name) => path.join(staging, name))];
      const produced = [];
      for (const candidate of candidates) {
        if (await fs.stat(candidate).then((stat) => stat.isFile(), () => false)) produced.push(candidate);
      }
      if (!produced.length) throw new Error(`DWS 未产生下载文件，输出：${String(stdout).slice(0, 200)}`);
      const source = produced[0];
      if (produced.length > 1) {
        const merged = path.join(directory, `${safeSegment(item.name || item.id).slice(0, 50)}.parts`);
        await fs.mkdir(merged, { recursive: true });
        for (const file of produced) await fs.copyFile(file, path.join(merged, path.basename(file)));
        target = merged;
      } else {
        await fs.copyFile(source, target);
      }
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      db().prepare("UPDATE dingtalk_chat_attachments SET local_path=?, downloaded_at=?, download_error=NULL WHERE id=?").run(target, nowIso(), item.id);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      db().prepare("UPDATE dingtalk_chat_attachments SET download_error=? WHERE id=?").run(error.message, item.id);
      throw Object.assign(new Error(`附件下载失败：${error.message}`), { code: error.code || "ATTACHMENT_DOWNLOAD_FAILED" });
    }
    return db().prepare("SELECT * FROM dingtalk_chat_attachments WHERE id=?").get(item.id);
  }

  return {
    status, startLogin, loginStatus, settings, updateSettings, sync, cleanup, capabilities,
    listConversations, setConversation, listMessages, countByStatus, message, setMessageStatus,
    createTodo, setLink, downloadAttachment, lastSync, generateTodoDraft, confirmTodoDraft,
  };
}

export const dingtalkChat = createDingtalkChatService();
