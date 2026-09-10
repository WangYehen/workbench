import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, ensureDataDir } from "../config.mjs";
import { getDb } from "../db.mjs";
import { ai as defaultAi } from "../ai/ai.mjs";

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
const STATUS_TTL_MS = 60 * 1000;

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
function mentionScope(raw, mentionedMe = false) {
  const text = messageContent(raw);
  const all = raw?.mentionedAll || raw?.atAll || raw?.atAllMembers || raw?.mentionAll
    || /@所有人|＠所有人/.test(text);
  return all ? "all" : (mentionedMe || raw?.mentionedMe || raw?.atMe ? "self" : "none");
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
    mention_scope: mentionScope(raw, mentionedMe),
    context_only: contextOnly ? 1 : 0,
    context_root_id: contextRootId,
    quoted_message_id: valueAt(raw, ["quotedMessage.messageId", "quotedMessage.openMessageId", "quotedMessageId"], null),
    attachments: extractAttachments(raw),
    raw_json: JSON.stringify(raw),
  };
}

export function createDingtalkChatService({ database = getDb, executable = config.dws.executable, dataDir = config.dataDir, run = null, now = () => new Date(), aiService = defaultAi, managerUserId = config.dingtalk.managerUserId } = {}) {
  // 命令探测缓存挂在实例上：生产单例 10 分钟内复用，测试的每个实例天然隔离。
  const capabilityCache = new Map();
  let statusCache = null;
  let statusInFlight = null;
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

  // Windows 下冷启动 DWS 偶尔会超过 8 秒。能力探测不应因一次启动变慢而把
  // 已经成功使用过的同步能力误报为“缺失”。
  async function probe(args, { timeoutMs = 15_000 } = {}) {
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
    let value = {
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
      // 没有专用 @所有人 命令时用群消息增量扫描识别，因此依赖消息读取能力。
      atAll: checks[2] || checks[7],
      probedAt: nowIso(),
    };
    // 核心读取能力：任一路径拿得到会话、@我、消息。
    value.coreReady = value.conversationsAvailable && value.mentionsAvailable && value.messagesAvailable;
    // 只要 DWS 已成功同步过，就不要用一次全失败的 --help 探测覆盖这份已验证
    // 的能力记录。下一次真实同步仍会执行命令并如实报告错误。
    const cachedGood = cached?.value?.coreReady ? cached.value : null;
    const persistedGood = lastSync()?.capabilities?.coreReady ? lastSync().capabilities : null;
    const fallback = cachedGood || persistedGood;
    if (!value.coreReady && fallback) {
      value = {
        ...value,
        conversationList: fallback.conversationList ?? value.conversationList,
        atMe: fallback.atMe ?? value.atMe,
        chatMessages: fallback.chatMessages ?? value.chatMessages,
        chatListAll: fallback.chatListAll ?? value.chatListAll,
        conversationListLegacy: fallback.conversationListLegacy ?? value.conversationListLegacy,
        resourceDownload: fallback.resourceDownload ?? value.resourceDownload,
        resourceUrl: fallback.resourceUrl ?? value.resourceUrl,
        conversationsAvailable: fallback.conversationsAvailable ?? value.conversationsAvailable,
        mentionsAvailable: fallback.mentionsAvailable ?? value.mentionsAvailable,
        messagesAvailable: fallback.messagesAvailable ?? value.messagesAvailable,
        atAll: fallback.atAll ?? value.atAll,
        coreReady: true,
        probeFallback: true,
      };
    }
    capabilityCache.set("caps", { at: Date.now(), value });
    return value;
  }

  function invalidateStatus() { statusCache = null; }
  function statusSnapshot() {
    const base = { executable, settings: settings(), lastSync: lastSync() };
    if (!statusCache) return { ...base, installed: null, connected: null, checking: true, stale: false, checkedAt: null, capabilities: null };
    return { ...base, ...statusCache.value, checking: false, stale: Date.now() - statusCache.at >= STATUS_TTL_MS, checkedAt: new Date(statusCache.at).toISOString() };
  }

  async function readStatus({ force = false } = {}) {
    if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
    if (!force && statusInFlight) return statusInFlight;
    statusInFlight = (async () => {
    try {
      const [version, authResult, profilesResult] = await Promise.all([
        execute(["version", "--format", "json"], { timeoutMs: 10_000 }),
        execute(["auth", "status", "--format", "json"], { timeoutMs: 10_000 }).catch(() => null),
        execute(["profile", "list", "--format", "json"], { timeoutMs: 10_000 }).catch(() => null),
      ]);
      const auth = authResult; const profiles = profilesResult;
      // 只回传展示所需的字段，绝不把 DWS 的原始认证对象（可能含令牌）透出到前端。
      const authPayload = auth?.payload || {};
      const profileList = asArray(valueAt(profiles?.payload, ["profiles", "result.profiles", "items"], []));
      const current = profileList.find((item) => item?.current || item?.active) || profileList[0] || null;
      return {
        installed: true,
        connected: Boolean(valueAt(authPayload, ["connected", "authenticated", "result.connected", "result.authenticated"], false)),
        version: valueAt(version.payload, ["version", "result.version"], "已安装"),
        account: {
          org: valueAt(authPayload, ["corpName", "orgName", "result.corpName", "tenant"], null),
          user: valueAt(authPayload, ["userName", "nick", "result.userName", "name"], null),
          userId: valueAt(authPayload, ["userId", "result.userId", "unionId"], null),
          profile: valueAt(profiles?.payload, ["currentProfile", "result.currentProfile"], null) || (current ? [current.corpName || current.corpId, current.userName || current.userId].filter(Boolean).join(":") : null),
        },
      };
    } catch (error) {
      return { installed: false, connected: false, error: error.message, errorCode: error.code || "DWS_NOT_INSTALLED", account: null };
    }
    })();
    try {
      const value = await statusInFlight;
      statusCache = { at: Date.now(), value };
      return value;
    } finally { statusInFlight = null; }
  }

  async function status({ probeCapabilities = true, force = false } = {}) {
    const value = await readStatus({ force });
    return {
      ...statusSnapshot(), ...value, checking: false, stale: false,
      capabilities: probeCapabilities ? await capabilities({ force }) : null,
    };
  }

  function startLogin() {
    invalidateStatus();
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
  function loginStatus(id) {
    const attempt = loginAttempts.get(id) || null;
    if (attempt?.status === "ready" && !attempt.statusCacheInvalidated) { invalidateStatus(); attempt.statusCacheInvalidated = true; }
    return attempt;
  }

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
        mentioned_me: row.mentioned_me, mention_scope: row.mention_scope, context_only: row.context_only, context_root_id: row.context_root_id,
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
    const insert = db().prepare(`INSERT INTO dingtalk_chat_messages(id,conversation_id,sender_id,sender_name,direction,sent_at,message_type,content,mentioned_me,mention_scope,context_only,context_root_id,quoted_message_id,raw_json,archive_path,processing_status,attachment_count,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const reconcile = db().prepare(`UPDATE dingtalk_chat_messages SET
      mentioned_me=MAX(mentioned_me, ?),
      mention_scope=CASE WHEN ?='all' THEN 'all' WHEN mention_scope='none' THEN ? ELSE mention_scope END,
      context_only=CASE WHEN mentioned_me=1 OR mention_scope!='none' OR ?!='none' THEN context_only ELSE MAX(context_only, ?) END,
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
          reconcile.run(row.mentioned_me, row.mention_scope, row.mention_scope, row.mention_scope, row.context_only, row.context_root_id, row.sender_id, row.sender_name, row.content, row.attachments?.length || 0, row.raw_json, stamp, row.id);
          continue;
        }
        insert.run(row.id, row.conversation_id, row.sender_id, row.sender_name, row.direction, row.sent_at, row.message_type, row.content, row.mentioned_me, row.mention_scope, row.context_only, row.context_root_id, row.quoted_message_id, row.raw_json, null, "new", row.attachments?.length || 0, stamp, stamp);
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

  async function sync({ days = 30, forceBackfill = false } = {}) {
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
    const backfillDays = forceBackfill ? Math.max(1, Number(days) || 1) : first ? days : 1;
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

    // @所有人不一定出现在 +at-me 返回中。对启用群的增量窗口补扫一次，只把明确的 @所有人
    // 消息提升为根；其他群消息仍仅保留为这些根的上下文。
    for (const conversation of stored.filter((item) => item.type === "group" && item.enabled)) {
      try {
        const since = first ? start : new Date(Math.max(start.getTime(), Date.parse(conversation.last_message_at || "") - 15 * 60000 || 0));
        const { items, ledger } = await fetchMessages(conversation.id, since, started);
        if (ledger?.partial) problems.push({ scope: `all-mention:${conversation.title || conversation.id}`, ...ledger });
        const normalized = items.map((item) => normalizeMessage(item, conversation.id, "group"));
        const allRoots = normalized.filter((item) => item.mention_scope === "all");
        for (const root of allRoots) {
          root.context_only = 0;
          const inserted = await insertMessages([root]);
          db().prepare("UPDATE dingtalk_chat_messages SET context_only=0,context_root_id=NULL,mention_scope='all',updated_at=? WHERE id=?").run(nowIso(), root.id);
          mentionIds.add(root.id);
          added.push(...inserted);
          const index = normalized.findIndex((item) => item.id === root.id);
          const context = index >= 0 ? normalized.slice(Math.max(0, index - 10), index + 11)
            .filter((item) => item.id !== root.id).map((item) => ({ ...item, context_only: 1, context_root_id: root.id })) : [];
          added.push(...await insertMessages(context));
        }
      } catch (error) {
        problems.push({ scope: `all-mention:${conversation.title || conversation.id}`, error: error.message, code: error.code || null });
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
    invalidateStatus();
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

  function listConversations({ q = "", scope = "all", limit = 100, offset = 0 } = {}) {
    const filters = []; const values = [];
    if (scope === "groups_or_permanent") filters.push("(c.type='group' OR c.retention_mode='permanent')");
    if (q) { filters.push("c.title LIKE ?"); values.push(`%${q}%`); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 100));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const total = db().prepare(`SELECT COUNT(*) AS total FROM dingtalk_chat_conversations c ${where}`).get(...values).total;
    const items = db().prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM dingtalk_chat_messages m WHERE m.conversation_id=c.id AND m.context_only=0 AND m.processing_status IN ('new','needs_confirmation')) AS open_count,
      (SELECT COUNT(*) FROM dingtalk_chat_messages m WHERE m.conversation_id=c.id AND m.context_only=0 AND m.processing_status IN ('new','needs_confirmation')) AS pending_count,
      (SELECT COUNT(*) FROM dingtalk_chat_messages m WHERE m.conversation_id=c.id) AS message_count,
      (SELECT MAX(m.sent_at) FROM dingtalk_chat_messages m WHERE m.conversation_id=c.id) AS last_message_at
      FROM dingtalk_chat_conversations c ${where} ORDER BY c.is_bot, c.type, c.title COLLATE NOCASE LIMIT ? OFFSET ?`).all(...values, boundedLimit, boundedOffset);
    return { items, total };
  }
  function setConversation(id, patch) {
    const item = db().prepare("SELECT * FROM dingtalk_chat_conversations WHERE id=?").get(id);
    if (!item) throw Object.assign(new Error("未找到会话"), { code: "NOT_FOUND" });
    db().prepare("UPDATE dingtalk_chat_conversations SET enabled=COALESCE(?,enabled), retention_mode=COALESCE(?,retention_mode), is_bot=COALESCE(?,is_bot), updated_at=? WHERE id=?")
      .run(patch.enabled == null ? null : patch.enabled ? 1 : 0, patch.retention_mode || null, patch.isBot == null ? null : patch.isBot ? 1 : 0, nowIso(), id);
    return db().prepare("SELECT * FROM dingtalk_chat_conversations WHERE id=?").get(id);
  }

  // 仅用于用户在配置 AI 后主动重试：找出曾因 AI 来源不可用而落成 0% 的消息。
  function retryableAnalysisMessageIds(limit = 100) {
    return db().prepare(`SELECT m.id FROM dingtalk_chat_messages m
      LEFT JOIN dingtalk_message_analysis a ON a.message_id=m.id
      JOIN dingtalk_chat_conversations c ON c.id=m.conversation_id
      WHERE m.direction='inbound' AND m.context_only=0 AND COALESCE(c.is_bot,0)=0
        AND m.processing_status NOT IN ('ignored','task_created','processed','waiting')
        AND (a.message_id IS NULL OR a.confidence=0)
      ORDER BY m.sent_at DESC LIMIT ?`).all(Math.min(300, Math.max(1, Number(limit) || 100))).map((item) => item.id);
  }

  // 只清理本功能主动注入的固定 ID；真实钉钉归档、真实信号与用户待办绝不受影响。
  function clearTestScenario() {
    const remove = (sql, ...params) => db().prepare(sql).run(...params).changes;
    const removed = {
      links: remove("DELETE FROM work_links WHERE (source_type='dingtalk_message' AND source_id LIKE 'demo_signal_%') OR (source_type='dingtalk_signal' AND source_id LIKE 'demo_work_signal_%')"),
      evidence: remove("DELETE FROM work_signal_evidence WHERE signal_id LIKE 'demo_work_signal_%'"),
      signals: remove("DELETE FROM work_signals WHERE id LIKE 'demo_work_signal_%'"),
      analyses: remove("DELETE FROM dingtalk_message_analysis WHERE message_id LIKE 'demo_signal_%'"),
      attachments: remove("DELETE FROM dingtalk_chat_attachments WHERE message_id LIKE 'demo_signal_%' OR conversation_id LIKE 'demo_signal_%'"),
      messages: remove("DELETE FROM dingtalk_chat_messages WHERE id LIKE 'demo_signal_%'"),
      conversations: remove("DELETE FROM dingtalk_chat_conversations WHERE id LIKE 'demo_signal_%'"),
      todos: remove("DELETE FROM todos WHERE source_type='dingtalk_signal' AND source_id LIKE 'demo_work_signal_%'"),
    };
    return { removed, note: "已清理本地测试场景，不影响真实钉钉数据" };
  }

  // 本机验收用的独立样例：不调用 DWS，不清理真实数据，重复点击只刷新同一批 demo_signal_ 记录。
  function injectTestScenario() {
    const stamp = nowIso();
    clearTestScenario();
    // 仅替换本功能生成的 demo_signal_ 记录，真实钉钉归档绝不在这里被删除。
    const projectGroupId = "demo_signal_project_group";
    const productGroupId = "demo_signal_product_group";
    const approvalGroupId = "demo_signal_approval_group";
    const noticeGroupId = "demo_signal_notice_group";
    const rootId = "demo_signal_project_root";
    const rootIds = [rootId, "demo_signal_product_root", "demo_signal_approval_root", "demo_signal_notice_root"];
    const noiseId = "demo_signal_noise";
    const upsertConversation = db().prepare(`INSERT INTO dingtalk_chat_conversations(id,type,title,peer_user_id,peer_name,enabled,retention_mode,last_message_at,sync_cursor_json,created_at,updated_at,chat_mode,is_bot,type_known,last_sync_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,enabled=1,last_message_at=excluded.last_message_at,updated_at=excluded.updated_at`);
    upsertConversation.run(projectGroupId, "group", "项目管理群", null, null, 1, "inherit", stamp, null, stamp, stamp, "group", 0, 1, null);
    upsertConversation.run(productGroupId, "group", "产品讨论群", null, null, 1, "inherit", stamp, null, stamp, stamp, "group", 0, 1, null);
    upsertConversation.run(approvalGroupId, "group", "审批协同群", null, null, 1, "inherit", stamp, null, stamp, stamp, "group", 0, 1, null);
    upsertConversation.run(noticeGroupId, "group", "版本发布群", null, null, 1, "inherit", stamp, null, stamp, stamp, "group", 0, 1, null);
    const upsertMessage = db().prepare(`INSERT INTO dingtalk_chat_messages(id,conversation_id,sender_id,sender_name,direction,sent_at,message_type,content,mentioned_me,context_only,context_root_id,quoted_message_id,raw_json,archive_path,processing_status,attachment_count,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,processing_status=excluded.processing_status,updated_at=excluded.updated_at`);
    const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    upsertMessage.run("demo_signal_project_context_1", projectGroupId, "demo-pm", "项目经理", "inbound", at(46), "text", "第三方服务上线延迟到 9-08，联调预计推迟 3 天，M2 需要顺延一周，辛苦确认影响。", 0, 1, rootId, null, JSON.stringify({ demo: true }), null, "informational", 0, stamp, stamp);
    upsertMessage.run("demo_signal_project_context_2", projectGroupId, "demo-fe", "前端负责人", "inbound", at(41), "text", "如果顺延一周，前端资源 9-05 后可释放，需要看是否有其他项目优先级更高。", 0, 1, rootId, null, JSON.stringify({ demo: true }), null, "informational", 0, stamp, stamp);
    upsertMessage.run("demo_signal_project_context_3", projectGroupId, "demo-self", "我", "outbound", at(37), "text", "了解，稍后评估对交付与资源的影响后回复。", 0, 1, rootId, null, JSON.stringify({ demo: true }), null, "informational", 0, stamp, stamp);
    upsertMessage.run(rootId, projectGroupId, "demo-pm", "项目经理", "inbound", at(28), "text", "@你 请确认第三方服务延期后的资源调整与交付影响。", 1, 0, null, null, JSON.stringify({ demo: true }), null, "needs_confirmation", 0, stamp, stamp);
    upsertMessage.run(rootIds[1], productGroupId, "demo-product", "产品负责人", "inbound", at(21), "text", "@你 请确认经营报表数据口径与影响范围，今天同步给业务方。", 1, 0, null, null, JSON.stringify({ demo: true }), null, "needs_confirmation", 0, stamp, stamp);
    upsertMessage.run(rootIds[2], approvalGroupId, "demo-finance", "采购负责人", "inbound", at(16), "text", "@你 本周是否提交采购预算追加审批？请确认金额和审批路径。", 1, 0, null, null, JSON.stringify({ demo: true }), null, "needs_confirmation", 0, stamp, stamp);
    upsertMessage.run(rootIds[3], noticeGroupId, "demo-release", "发布负责人", "inbound", at(11), "text", "@所有人 版本 2.3 将于明晚发布，上线计划已更新。", 0, 0, null, null, JSON.stringify({ demo: true }), null, "informational", 0, stamp, stamp);
    upsertMessage.run(noiseId, productGroupId, "demo-product", "产品负责人", "inbound", at(4), "text", "收到", 0, 0, null, null, JSON.stringify({ demo: true }), null, "ignored", 0, stamp, stamp);
    db().prepare("UPDATE dingtalk_chat_messages SET mention_scope='self' WHERE id IN (?,?,?)").run(rootId, rootIds[1], rootIds[2]);
    db().prepare("UPDATE dingtalk_chat_messages SET mention_scope='all' WHERE id=?").run(rootIds[3]);
    const upsertAnalysis = db().prepare(`INSERT INTO dingtalk_message_analysis(message_id,classification,summary,action_text,due_date,priority,confidence,assignee_self,ai_meta_json,todo_id,draft_title,draft_note,draft_priority,draft_due_date,draft_rationale,draft_generated_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET classification=excluded.classification,summary=excluded.summary,action_text=excluded.action_text,priority=excluded.priority,confidence=excluded.confidence,assignee_self=excluded.assignee_self,ai_meta_json=excluded.ai_meta_json,draft_title=excluded.draft_title,draft_note=excluded.draft_note,draft_priority=excluded.draft_priority,draft_rationale=excluded.draft_rationale,updated_at=excluded.updated_at`);
    const demoMeta = (facts, steps) => JSON.stringify({ provider: "demo", providerLabel: "本地测试场景", generatedAt: stamp, demo: true, facts, steps });
    upsertAnalysis.run(rootId, "action", "此事需要你今天确认", "排期调整：确认资源与交付影响", null, "P1", 94, 1, demoMeta([
      "第三方服务上线延迟，联调预计推迟 3 天。",
      "M2 里程碑可能顺延一周，涉及客户交付承诺。",
      "群内明确 @你 确认资源与交付影响。",
    ], ["确认项目排期是否调整，并明确新的关键节点。", "核对前端资源释放时间及其余项目的优先级冲突。", "同步项目经理与相关干系人，形成对外沟通口径。"]), null, "排期调整：确认资源与交付影响", "第三方服务延期可能影响 M2 交付，群内正在等待你确认资源安排与对外承诺。", "P1", null, "群内 @我，且上下文同时出现延期、资源冲突与客户交付风险。", stamp, stamp, stamp);
    upsertAnalysis.run(rootIds[1], "action", "需要你确认数据口径与影响范围", "需求澄清：数据口径与范围", null, "P2", 88, 1, demoMeta(["经营报表的数据口径尚未统一。", "产品负责人要求今天同步给业务方。"], ["确认采用的新口径和受影响指标。", "明确业务方同步范围与负责人。", "采纳后创建一条需求澄清待办。"]), null, "需求澄清：数据口径与范围", "数据口径存在分歧，需要由你确认边界后再对业务方同步。", "P2", null, "群内 @我 并要求当日确认。", stamp, stamp, stamp);
    upsertAnalysis.run(rootIds[2], "action", "采购预算需要你确认审批安排", "审批协同：采购预算追加", null, "P2", 91, 1, demoMeta(["采购预算出现追加需求。", "待确认金额与审批路径。"], ["核对预算追加金额和资金来源。", "确认审批人及截止时间。", "决定是否本周提交审批。"]), null, "审批协同：采购预算追加", "预算追加需尽快确认审批路径，避免影响采购排期。", "P2", null, "群内 @我 且有明确决策请求。", stamp, stamp, stamp);
    upsertAnalysis.run(rootIds[3], "informational", "版本发布计划已更新", "发布通知：版本 2.3 上线计划", null, "P2", 92, 0, demoMeta(["版本 2.3 上线时间已确定。", "当前没有要求你执行额外操作。"], ["查看上线计划是否影响当前项目。"]), null, "发布通知：版本 2.3 上线计划", "这是一条发布同步，建议知晓即可；若涉及你的项目，再展开查看。", "P2", null, "属于发布通知，没有明确行动要求。", stamp, stamp, stamp);
    db().prepare(`INSERT INTO work_links(id,source_type,source_id,target_type,target_id,confidence,reason,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_type,source_id,target_type,target_id) DO UPDATE SET confidence=excluded.confidence,status=excluded.status,updated_at=excluded.updated_at`)
      .run("demo_signal_project_link", "dingtalk_message", rootId, "project", "星云平台升级项目", 94, "本地测试场景关联", "confirmed", stamp, stamp);
    const upsertLink = db().prepare(`INSERT INTO work_links(id,source_type,source_id,target_type,target_id,confidence,reason,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_type,source_id,target_type,target_id) DO UPDATE SET confidence=excluded.confidence,status=excluded.status,updated_at=excluded.updated_at`);
    upsertLink.run("demo_signal_mail_link", "dingtalk_message", rootId, "outlook", "M2 调整沟通与影响说明", 91, "本地测试场景关联", "confirmed", stamp, stamp);
    upsertLink.run("demo_signal_calendar_link", "dingtalk_message", rootId, "calendar", "M2 评审会（可能调整）", 89, "本地测试场景关联", "confirmed", stamp, stamp);
    const upsertSignal = db().prepare(`INSERT INTO work_signals(id,title,classification,state,priority,confidence,conclusion,facts_json,steps_json,draft_title,draft_note,draft_priority,draft_due_date,draft_rationale,todo_id,ai_meta_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,classification=excluded.classification,state=excluded.state,priority=excluded.priority,confidence=excluded.confidence,conclusion=excluded.conclusion,facts_json=excluded.facts_json,steps_json=excluded.steps_json,updated_at=excluded.updated_at`);
    const signalRows = [
      ["demo_work_signal_schedule", "排期调整：确认资源与交付影响", "action", "open", "P1", 94, "此事需要你今天确认", ["第三方服务上线延迟，联调预计推迟 3 天。", "M2 里程碑可能顺延一周，涉及客户交付承诺。"], ["确认项目排期是否调整，并明确新的关键节点。", "核对前端资源释放时间及其余项目的优先级冲突。", "同步项目经理与相关干系人。"], rootId],
      ["demo_work_signal_metric", "需求澄清：数据口径与范围", "action", "open", "P2", 88, "需要你确认数据口径与影响范围", ["经营报表的数据口径尚未统一。"], ["确认采用的新口径和受影响指标。", "明确业务方同步范围与负责人。"], rootIds[1]],
      ["demo_work_signal_budget", "审批协同：采购预算追加", "action", "open", "P2", 91, "采购预算需要你确认审批安排", ["采购预算出现追加需求。"], ["核对预算追加金额和资金来源。", "确认审批人及截止时间。"], rootIds[2]],
      ["demo_work_signal_release", "发布通知：版本 2.3 上线计划", "informational", "open", "P2", 92, "版本发布计划已更新", ["当前没有要求你执行额外操作。"], ["查看上线计划是否影响当前项目。"], rootIds[3]],
    ];
    const addEvidence = db().prepare("INSERT INTO work_signal_evidence(id,signal_id,message_id,conversation_id,conversation_title,sender_name,sent_at,mention_scope,excerpt,is_root,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(signal_id,message_id) DO NOTHING");
    for (const [signalId, title, classification, state, priority, confidence, conclusion, facts, steps, messageId] of signalRows) {
      upsertSignal.run(signalId, title, classification, state, priority, confidence, conclusion, JSON.stringify(facts), JSON.stringify(steps), title, conclusion, priority, null, "本地测试场景", null, JSON.stringify({ provider: "demo" }), stamp, stamp);
      const row = db().prepare("SELECT m.*,c.title conversation_title FROM dingtalk_chat_messages m JOIN dingtalk_chat_conversations c ON c.id=m.conversation_id WHERE m.id=?").get(messageId);
      addEvidence.run(crypto.randomUUID(), signalId, messageId, row.conversation_id, row.conversation_title, row.sender_name, row.sent_at, row.mention_scope || "self", row.content, 1, stamp);
    }
    db().prepare("UPDATE work_links SET source_type='dingtalk_signal',source_id='demo_work_signal_schedule' WHERE id IN ('demo_signal_project_link','demo_signal_mail_link','demo_signal_calendar_link')").run();
    return { inserted: 8, messageIds: [...rootIds, noiseId], note: "已注入本地测试场景，不影响真实钉钉消息" };
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
      a.classification,a.summary,a.action_text,a.due_date,a.priority,a.confidence,a.assignee_self,a.todo_id,
      CASE WHEN c.type='private' AND m.direction='inbound' AND NOT EXISTS (
        SELECT 1 FROM dingtalk_chat_messages reply
        WHERE reply.conversation_id=m.conversation_id AND reply.direction='outbound' AND reply.sent_at>m.sent_at
      ) THEN 'reply_pending' WHEN c.type='private' AND m.direction='inbound' THEN 'replied' ELSE NULL END AS reply_state
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

  function signalSection(row) {
    if (row.classification === "informational") return "know";
    return ["P0", "P1"].includes(row.priority) ? "priority" : "confirm";
  }
  function listSignals({ state = "open", limit = 100, offset = 0 } = {}) {
    const filters = []; const values = [];
    if (state) { filters.push("s.state=?"); values.push(state); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const items = db().prepare(`SELECT s.*, e.conversation_title,e.mention_scope,e.sent_at AS latest_evidence_at,
      CASE WHEN c.type='private' AND m.direction='inbound' AND NOT EXISTS (
        SELECT 1 FROM dingtalk_chat_messages reply
        WHERE reply.conversation_id=m.conversation_id AND reply.direction='outbound' AND reply.sent_at>m.sent_at
      ) THEN 'reply_pending' WHEN c.type='private' AND m.direction='inbound' THEN 'replied' ELSE NULL END AS reply_state
      FROM work_signals s LEFT JOIN work_signal_evidence e ON e.id=(SELECT e2.id FROM work_signal_evidence e2 WHERE e2.signal_id=s.id ORDER BY e2.sent_at DESC LIMIT 1)
      LEFT JOIN dingtalk_chat_messages m ON m.id=e.message_id LEFT JOIN dingtalk_chat_conversations c ON c.id=m.conversation_id
      ${where} ORDER BY CASE s.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, s.updated_at DESC LIMIT ? OFFSET ?`)
      .all(...values, Math.min(200, Math.max(1, Number(limit) || 100)), Math.max(0, Number(offset) || 0)).map((item) => ({ ...item, section: signalSection(item), facts: parseJson(item.facts_json) || [], steps: parseJson(item.steps_json) || [] }));
    const countRows = db().prepare("SELECT classification,priority,COUNT(*) count FROM work_signals WHERE state='open' GROUP BY classification,priority").all();
    const counts = { priority: 0, confirm: 0, know: 0 };
    for (const row of countRows) counts[signalSection(row)] += row.count;
    return { items, counts };
  }

  async function inbox() {
    const managerId = String(managerUserId || "").trim();
    if (!managerId) return { ready: false, error: "未配置 DINGTALK_MANAGER_USER_ID，无法识别主管待办。", counts: { replyPending: 0, actionRequired: 0, projectUpdates: 0 }, replyPending: [], actionRequired: [], projectUpdates: [] };
    const connection = await status({ probeCapabilities: false });
    if (connection.connected && connection.account?.userId && String(connection.account.userId) !== managerId) {
      return { ready: false, error: "当前 DWS 登录账号与 DINGTALK_MANAGER_USER_ID 不一致，请修正配置或重新连接。", counts: { replyPending: 0, actionRequired: 0, projectUpdates: 0 }, replyPending: [], actionRequired: [], projectUpdates: [] };
    }
    const replyPending = db().prepare(`SELECT m.id,m.content,m.sender_name,m.sent_at,m.conversation_id,c.title AS conversation_title,
      a.summary,a.priority,a.confidence
      FROM dingtalk_chat_messages m JOIN dingtalk_chat_conversations c ON c.id=m.conversation_id
      LEFT JOIN dingtalk_message_analysis a ON a.message_id=m.id
      WHERE c.type='private' AND m.direction='inbound' AND m.sender_id!=? AND m.context_only=0
        AND m.processing_status NOT IN ('ignored','processed','task_created')
        AND NOT EXISTS (SELECT 1 FROM dingtalk_chat_messages reply WHERE reply.conversation_id=m.conversation_id
          AND reply.sender_id=? AND reply.sent_at>m.sent_at)
      ORDER BY CASE a.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, m.sent_at DESC LIMIT 100`).all(managerId, managerId)
      .map((item) => ({ ...item, source: 'message', kind: 'reply_pending', title: item.summary || item.content?.slice(0, 80) || '待回复消息', priority: item.priority || 'P2' }));
    const actionRequired = db().prepare(`SELECT s.*,e.message_id,e.conversation_title,e.sender_name,e.sent_at,e.mention_scope
      FROM work_signals s JOIN work_signal_evidence e ON e.id=(SELECT id FROM work_signal_evidence WHERE signal_id=s.id ORDER BY sent_at DESC LIMIT 1)
      WHERE s.state='open' AND s.classification='action' AND s.todo_id IS NULL
      ORDER BY CASE s.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,s.updated_at DESC LIMIT 100`).all()
      .map((item) => ({ ...item, source: 'signal', kind: 'action_required' }));
    const projectUpdates = db().prepare(`SELECT s.id,s.title,s.classification,s.priority,s.confidence,s.conclusion,s.updated_at,
      e.message_id,e.conversation_title,e.sender_name,e.sent_at,e.mention_scope,p.id AS project_id,p.name AS project_name,p.progress AS project_progress
      FROM work_signals s JOIN work_signal_evidence e ON e.id=(SELECT id FROM work_signal_evidence WHERE signal_id=s.id ORDER BY sent_at DESC LIMIT 1)
      JOIN dingtalk_chat_conversations c ON c.id=e.conversation_id
      JOIN work_links w ON w.source_type='dingtalk_signal' AND w.source_id=s.id AND w.target_type='project' AND w.status!='rejected' AND w.confidence>=80
      JOIN projects p ON p.id=w.target_id
      WHERE s.state='open' AND c.type='group' AND e.mention_scope IN ('self','all')
      ORDER BY p.name,CASE s.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,e.sent_at DESC LIMIT 100`).all()
      .map((item) => ({ ...item, source: 'signal', kind: 'project_update' }));
    return { ready: true, managerUserId: managerId, counts: { replyPending: replyPending.length, actionRequired: actionRequired.length, projectUpdates: projectUpdates.length }, replyPending, actionRequired, projectUpdates };
  }
  function signal(id) {
    const item = db().prepare("SELECT * FROM work_signals WHERE id=?").get(id);
    if (!item) return null;
    const evidence = db().prepare(`SELECT e.*,m.content AS raw_content,m.id IS NOT NULL AS message_available
      FROM work_signal_evidence e LEFT JOIN dingtalk_chat_messages m ON m.id=e.message_id WHERE e.signal_id=? ORDER BY e.sent_at`).all(id);
    const links = db().prepare("SELECT * FROM work_links WHERE source_type='dingtalk_signal' AND source_id=? AND status!='rejected' ORDER BY confidence DESC").all(id);
    const todo = item.todo_id ? db().prepare("SELECT * FROM todos WHERE id=?").get(item.todo_id) : null;
    return { ...item, facts: parseJson(item.facts_json) || [], steps: parseJson(item.steps_json) || [], evidence, links, todo };
  }
  function setSignalState(id, state) {
    if (!["open", "waiting", "ignored", "todo_created"].includes(state)) throw Object.assign(new Error(`不支持的信号状态：${state}`), { code: "INVALID_STATUS" });
    db().prepare("UPDATE work_signals SET state=?,updated_at=? WHERE id=?").run(state, nowIso(), id);
    const item = signal(id);
    if (!item) throw Object.assign(new Error("未找到工作信号"), { code: "NOT_FOUND" });
    return item;
  }
  function confirmSignalDraft(id, patch = {}) {
    const item = signal(id);
    if (!item) throw Object.assign(new Error("未找到工作信号"), { code: "NOT_FOUND" });
    const title = String(patch.title || item.draft_title || item.title).trim();
    if (!title) throw Object.assign(new Error("待办草稿缺少标题"), { code: "DRAFT_INCOMPLETE" });
    const stamp = nowIso();
    let todo = item.todo_id ? db().prepare("SELECT * FROM todos WHERE id=?").get(item.todo_id) : null;
    if (!todo) {
      const todoId = `t${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const note = String(patch.note ?? item.draft_note ?? "").trim();
      db().prepare("INSERT INTO todos(id,title,note,status,priority,due_date,created_at,completed_at,source_type,source_id,project_id,assignee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(todoId, title, note, "inbox", patch.priority || item.draft_priority || item.priority, patch.dueDate || item.draft_due_date || null, stamp, null, "dingtalk_signal", id, null, null);
      db().prepare("UPDATE work_signals SET todo_id=?,state='todo_created',updated_at=? WHERE id=?").run(todoId, stamp, id);
      todo = db().prepare("SELECT * FROM todos WHERE id=?").get(todoId);
      return { item: signal(id), todo, created: true };
    }
    db().prepare("UPDATE work_signals SET state='todo_created',updated_at=? WHERE id=?").run(stamp, id);
    return { item: signal(id), todo, created: false };
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
    const allowed = ["new", "needs_confirmation", "task_created", "informational", "waiting", "processed", "ignored"];
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
    status, statusSnapshot, invalidateStatus, startLogin, loginStatus, settings, updateSettings, sync, cleanup, capabilities,
    listConversations, setConversation, listMessages, countByStatus, message, setMessageStatus,
    listSignals, inbox, signal, setSignalState, confirmSignalDraft,
    createTodo, setLink, downloadAttachment, lastSync, generateTodoDraft, confirmTodoDraft, retryableAnalysisMessageIds, injectTestScenario, clearTestScenario,
  };
}

export const dingtalkChat = createDingtalkChatService();
