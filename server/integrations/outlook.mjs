import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
const STORE_VERSION = 1;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES_PER_SYNC = 500;
const BODY_LIMIT = 12_000;
const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const OAUTH_SESSION_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_WINDOW_MS = 2 * 60 * 1000;
const CLASSIFIER_VERSION = 6;
const STATE_REPLACE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1_600];
const STATE_REPLACE_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export class OutlookServiceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "OutlookServiceError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new OutlookServiceError(code, message, details);
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function asIso(now) {
  return now.toISOString();
}

function safeString(value, maximum = 512) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maximum) : null;
}

function emptyState() {
  return {
    version: STORE_VERSION,
    consent: null,
    connection: null,
    sync: {
      cursorReceivedAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
    },
    messages: [],
  };
}

function normalizeConfig(config = {}) {
  const keyText = safeString(config.tokenEncryptionKey, 512);
  let tokenKey = null;
  if (keyText) {
    try {
      const decoded = Buffer.from(keyText, "base64");
      if (decoded.length === 32) tokenKey = decoded;
    } catch {
      // Report the missing/invalid key through status without exposing it.
    }
  }
  return {
    // `common` enables a registered multi-tenant application to start a user-owned
    // Microsoft sign-in. A tenant can still be supplied to deliberately restrict it.
    tenantId: safeString(config.tenantId, 256) || "common",
    clientId: safeString(config.clientId, 256),
    redirectUri: safeString(config.redirectUri, 1_024),
    tokenKey,
    modelProvider: safeString(config.modelProvider, 128) || "AI 智能路由",
  };
}

function missingConfiguration(config) {
  const missing = [];
  if (!config.clientId) missing.push("OUTLOOK_ENTRA_CLIENT_ID");
  if (!config.redirectUri) missing.push("OUTLOOK_OAUTH_REDIRECT_URI");
  if (!config.tokenKey) missing.push("OUTLOOK_TOKEN_ENCRYPTION_KEY");
  return missing;
}

function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    version: STORE_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(payload, key) {
  if (!payload || payload.version !== STORE_VERSION || !payload.iv || !payload.tag || !payload.ciphertext) {
    fail("OUTLOOK_STATE_CORRUPT", "Outlook 本地状态文件格式无效。");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const value = JSON.parse(plain);
    if (!value || value.version !== STORE_VERSION || !Array.isArray(value.messages)) {
      fail("OUTLOOK_STATE_CORRUPT", "Outlook 本地状态文件内容无效。");
    }
    return value;
  } catch (error) {
    if (error instanceof OutlookServiceError) throw error;
    fail("OUTLOOK_STATE_UNREADABLE", "Outlook 本地状态无法解密。请检查加密密钥。");
  }
}

async function ensureStateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    fail("OUTLOOK_STATE_DIRECTORY_UNSAFE", "Outlook 本地状态目录必须是普通目录，不能是符号链接。");
  }
}

export async function replaceStateFile(
  temporary,
  statePath,
  {
    renameFile = rename,
    wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(temporary, statePath);
      return;
    } catch (error) {
      const delay = STATE_REPLACE_RETRY_DELAYS_MS[attempt];
      if (!STATE_REPLACE_RETRY_CODES.has(error?.code) || delay == null) throw error;
      await wait(delay);
    }
  }
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<\/(?:p|div|tr|li|br|h[1-6])\s*>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

export function prepareMailText(value, limit = BODY_LIMIT) {
  const normalized = htmlToText(value)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const cutoff = normalized.findIndex((line) => /^(--\s*$|-----Original Message-----|From:|发件人：|On .+wrote:)$/i.test(line));
  return normalized
    .slice(0, cutoff >= 0 ? cutoff : normalized.length)
    .join("\n")
    .slice(0, limit);
}

function normalizeClassification(value) {
  const source = value && typeof value === "object" ? value : {};
  const queue = ["action", "informational", "uncertain"].includes(source.queue)
    ? source.queue
    : source.classification === "todo"
      ? "action"
      : source.classification === "not_actionable"
        ? "informational"
        : null;
  const actionType = ["reply", "approval", "confirmation", "submission", "deadline", "other"].includes(source.actionType || source.intent)
    ? (source.actionType || source.intent)
    : queue === "informational" ? "other" : null;
  const priority = ["P0", "P1", "P2"].includes(source.priority)
    ? source.priority
    : source.urgency === "high" ? "P0" : source.urgency === "low" ? "P2" : "P1";
  const summary = safeString(source.summary, 240);
  if (!queue || !actionType || !priority || !summary) {
    fail("OUTLOOK_CLASSIFICATION_INVALID", "模型返回的邮件分类格式无效。");
  }
  const dueAt = safeString(source.dueAt, 80);
  const dueSource = ["explicit", "inferred", "none"].includes(source.dueSource)
    ? source.dueSource
    : dueAt ? "explicit" : "none";
  const confidenceValue = Number(source.confidence ?? (queue === "uncertain" ? 45 : 85));
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(100, Math.round(confidenceValue))) : 50;
  const actionText = safeString(source.actionText, 500) || summary;
  const priorityReason = safeString(source.priorityReason, 500) || (priority === "P0" ? "存在明确且紧迫的行动要求" : priority === "P1" ? "需要在近期完成处理" : "当前没有紧迫截止要求");
  const classification = queue === "action" ? "todo" : "not_actionable";
  const intent = actionType;
  const urgency = priority === "P0" ? "high" : priority === "P2" ? "low" : "medium";
  return { queue, actionType, actionText, dueAt, dueSource, priority, priorityReason, confidence, summary, classification, intent, urgency };
}

export function parseClassifierResponse(content) {
  const raw = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return normalizeClassification(JSON.parse(raw));
  } catch (error) {
    if (error instanceof OutlookServiceError) throw error;
    fail("OUTLOOK_CLASSIFICATION_INVALID", "模型没有返回可用的 JSON 分类结果。");
  }
}

function publicMessage(message) {
  const { rawBody, ...safe } = message;
  return safe;
}

function normalizeStoredMessage(message = {}) {
  const queue = message.queue || (message.classification === "todo" ? "action" : message.classification === "not_actionable" ? "informational" : "uncertain");
  const priority = message.priority || (message.urgency === "high" ? "P0" : message.urgency === "low" ? "P2" : "P1");
  const legacyStatus = message.status === "not_actionable" ? "open" : message.status;
  return {
    ...message,
    queue,
    actionType: message.actionType || message.intent || "other",
    actionText: message.actionText || message.summary || message.subject || "请确认邮件行动",
    dueSource: message.dueSource || (message.dueAt ? "explicit" : "none"),
    priority,
    priorityReason: message.priorityReason || (priority === "P0" ? "存在紧迫行动要求" : "根据邮件内容判断"),
    confidence: Number.isFinite(Number(message.confidence)) ? Number(message.confidence) : queue === "uncertain" ? 40 : 80,
    status: legacyStatus || "open",
  };
}

function publicStatus(state, config) {
  const missing = missingConfiguration(config);
  const messages = state.messages || [];
  return {
    localOnly: true,
    configured: missing.length === 0,
    missingConfiguration: missing,
    modelProvider: config.modelProvider,
    consented: Boolean(state.consent?.acceptedAt && state.consent?.provider === config.modelProvider),
    connected: Boolean(state.connection?.token?.refreshToken),
    lastSyncAt: state.sync?.lastSuccessAt || null,
    lastAttemptAt: state.sync?.lastAttemptAt || null,
    lastError: state.sync?.lastError || null,
    todoCount: messages.filter((message) => message.queue === "action" && message.status === "open").length,
    informationalCount: messages.filter((message) => message.queue === "informational").length,
    uncertainCount: messages.filter((message) => message.queue === "uncertain" && message.status === "open").length,
    archiveCount: messages.filter((message) => ["processed", "ignored"].includes(message.status)).length,
  };
}

export function createOutlookService({
  config: suppliedConfig = {},
  stateDirectory = path.resolve(".local/outlook"),
  fetchImpl = fetch,
  aiService = null,
  taskScheduler = null,
  now = () => new Date(),
  syncIntervalMs = SYNC_INTERVAL_MS,
} = {}) {
  const config = normalizeConfig(suppliedConfig);
  const statePath = path.join(stateDirectory, "state.enc.json");
  const sessions = new Map();
  let stateQueue = Promise.resolve();
  let scheduler = null;
  let activeSync = null;

  async function externalRequest(label, url, options) {
    try {
      return await fetchImpl(url, options);
    } catch (error) {
      const host = (() => {
        try { return new URL(url).host; } catch { return "unknown-host"; }
      })();
      fail("OUTLOOK_EXTERNAL_REQUEST_FAILED", `${label} request failed (${host}): ${error?.message || "unknown network error"}`);
    }
  }

  async function readState() {
    if (!config.tokenKey) return emptyState();
    try {
      const details = await lstat(statePath);
      if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_STORE_BYTES) {
        fail("OUTLOOK_STATE_UNSAFE", "Outlook 本地状态文件无效或过大。");
      }
      const state = decrypt(JSON.parse(await readFile(statePath, "utf8")), config.tokenKey);
      state.messages = state.messages.map(normalizeStoredMessage);
      return state;
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      throw error;
    }
  }

  function writeState(nextState) {
    const operation = stateQueue.then(async () => {
      if (!config.tokenKey) fail("OUTLOOK_NOT_CONFIGURED", "请先配置 Outlook 本地环境变量。");
      await ensureStateDirectory(stateDirectory);
      const encrypted = `${JSON.stringify(encrypt(nextState, config.tokenKey), null, 2)}\n`;
      if (Buffer.byteLength(encrypted, "utf8") > MAX_STORE_BYTES) {
        fail("OUTLOOK_STATE_TOO_LARGE", "Outlook 本地状态超过安全上限。");
      }
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, encrypted, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await replaceStateFile(temporary, statePath);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return nextState;
    });
    stateQueue = operation.catch(() => {});
    return operation;
  }

  function requireConfigured() {
    if (missingConfiguration(config).length) {
      fail("OUTLOOK_NOT_CONFIGURED", "请先完成 Outlook 的本地环境变量配置。");
    }
  }

  async function requestToken(params) {
    const response = await externalRequest("Microsoft token",
      `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, ...params }),
      },
    );
    if (!response.ok) fail("OUTLOOK_TOKEN_EXCHANGE_FAILED", "Microsoft 身份验证令牌交换失败。");
    const value = await response.json();
    if (!value?.access_token || !value?.refresh_token) {
      fail("OUTLOOK_TOKEN_EXCHANGE_FAILED", "Microsoft 没有返回可用的长期访问令牌。");
    }
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresAt: new Date(now().getTime() + Number(value.expires_in || 3600) * 1000).toISOString(),
      scope: safeString(value.scope, 512),
    };
  }

  async function accessToken(state) {
    const token = state.connection?.token;
    if (!token?.accessToken || !token?.refreshToken) fail("OUTLOOK_NOT_CONNECTED", "Outlook 尚未连接。");
    const expiresAt = Date.parse(token.expiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt - now().getTime() > TOKEN_REFRESH_WINDOW_MS) return token.accessToken;
    const refreshed = await requestToken({ grant_type: "refresh_token", refresh_token: token.refreshToken });
    state.connection.token = refreshed;
    await writeState(state);
    return refreshed.accessToken;
  }

  async function graphJson(url, token) {
    const response = await externalRequest("Microsoft Graph", url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!response.ok) fail("OUTLOOK_GRAPH_REQUEST_FAILED", "无法读取 Microsoft Graph 邮箱数据。");
    return response.json();
  }

  async function classify(message) {
    const text = prepareMailText(message.body?.content);
    if (!aiService?.classifyOutlookEmail) {
      return normalizeClassification({
        queue: "uncertain", actionType: "other", actionText: "请人工确认邮件分类",
        dueAt: null, dueSource: "none", priority: "P2", priorityReason: "AI 来源不可用，需人工确认",
        confidence: 0, summary: message.subject || "邮件等待人工确认",
      });
    }
    const request = {
      subject: message.subject,
      sender: message.from?.emailAddress?.name || message.from?.emailAddress?.address,
      text,
    };
    const result = taskScheduler?.classifyEmail ? await taskScheduler.classifyEmail({ id: message.id, internetMessageId: message.internetMessageId, subject: request.subject, from: message.from, receivedDateTime: message.receivedDateTime, body: { content: text } }) : await aiService.classifyOutlookEmail(request);
    return normalizeClassification(result);
  }

  function retainedMessage(message, result, currentTime) {
    return {
      id: safeString(message.id, 512),
      internetMessageId: safeString(message.internetMessageId, 1_024),
      sender: safeString(message.from?.emailAddress?.name || message.from?.emailAddress?.address, 256) || "未知发件人",
      subject: safeString(message.subject, 512) || "（无主题）",
      receivedAt: safeString(message.receivedDateTime, 80),
      webLink: safeString(message.webLink, 2_048),
      bodyText: prepareMailText(message.body?.content, 8_000),
      queue: result.queue,
      actionType: result.actionType,
      actionText: result.actionText,
      dueSource: result.dueSource,
      priority: result.priority,
      priorityReason: result.priorityReason,
      confidence: result.confidence,
      classification: result.classification,
      classifierVersion: CLASSIFIER_VERSION,
      intent: result.intent,
      urgency: result.urgency,
      summary: result.summary,
      dueAt: result.dueAt,
      status: "open",
      classifiedAt: currentTime,
      updatedAt: currentTime,
    };
  }

  async function runSync({ allowAi = true } = {}) {
    requireConfigured();
    const state = await readState();
    if (!state.consent?.acceptedAt || state.consent?.provider !== config.modelProvider) {
      fail("OUTLOOK_CONSENT_REQUIRED", `请先确认邮件正文将发送至 ${config.modelProvider} 的隐私告知。`);
    }
    state.sync.lastAttemptAt = asIso(now());
    const token = await accessToken(state);
    // 自愈：之前 sync 可能因为网络/AI 错误留下一批"status=open 但 classifierVersion 没被设置"的失败邮件，
    // 由于 cursorReceivedAt 已经推进，这些邮件永远不会被重新尝试。
    // 这里把 cursor 临时回退到这些遗留邮件最早的时间，强制重试一次；本次 sync 结束后再写回新 cursor。
    const pendingRetries = state.messages
      .filter((m) => m.status === "open" && (
        (m.classifierVersion !== CLASSIFIER_VERSION && m.processingError)
        || m.priorityReason === "AI 来源不可用，需人工确认"
      ))
      .map((m) => Date.parse(m.receivedAt || ""))
      .filter(Number.isFinite);
    const baseCutoff = state.sync.classifierVersion === CLASSIFIER_VERSION && state.sync.cursorReceivedAt
      ? new Date(Date.parse(state.sync.cursorReceivedAt) - 2 * 60 * 1000)
      : new Date(now().getTime() - 7 * 24 * 60 * 60 * 1000);
    const cutoff = pendingRetries.length
      ? new Date(Math.min(baseCutoff.getTime(), ...pendingRetries) - 1000)
      : baseCutoff;
    let nextUrl = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$select=id,internetMessageId,subject,from,receivedDateTime,webLink,body&$orderby=receivedDateTime%20desc&$top=50";
    const existing = new Map(state.messages.map((message) => [message.id, message]));
    const knownInternetIds = new Set(state.messages.map((message) => message.internetMessageId).filter(Boolean));
    let newest = state.sync.cursorReceivedAt;
    let inspected = 0;
    let classified = 0;
    let reachedCutoff = false;
    try {
      while (nextUrl && inspected < MAX_MESSAGES_PER_SYNC && !reachedCutoff) {
        const page = await graphJson(nextUrl, token);
        for (const message of page.value || []) {
          inspected += 1;
          const received = Date.parse(message.receivedDateTime || "");
          if (Number.isFinite(received) && received < cutoff.getTime()) {
            reachedCutoff = true;
            break;
          }
          if (!newest || String(message.receivedDateTime) > newest) newest = message.receivedDateTime;
          const prior = existing.get(message.id);
          if (
            (prior && prior.status !== "retry" && prior.classifierVersion === CLASSIFIER_VERSION && prior.priorityReason !== "AI 来源不可用，需人工确认") ||
            (!prior && message.internetMessageId && knownInternetIds.has(message.internetMessageId))
          ) continue;
          try {
            const result = allowAi ? await classify(message) : {
              queue: "uncertain", actionType: "other", actionText: "请人工确认邮件分类", dueAt: null, dueSource: "none",
              priority: "P2", priorityReason: "后台同步未启用 AI，需人工确认", confidence: 0, summary: message.subject || "邮件等待人工确认",
              classification: "not_actionable", intent: "unknown", urgency: "unknown",
            };
            const saved = retainedMessage(message, result, asIso(now()));
            if (prior?.userCorrectedAt) {
              for (const key of ["queue", "actionType", "actionText", "dueAt", "dueSource", "priority", "priorityReason", "confidence", "classification", "intent", "urgency"]) saved[key] = prior[key];
              saved.userCorrectedAt = prior.userCorrectedAt;
            }
            if (["processed", "ignored", "converted"].includes(prior?.status)) saved.status = prior.status;
            existing.set(saved.id, saved);
            if (saved.internetMessageId) knownInternetIds.add(saved.internetMessageId);
            classified += 1;
          } catch (error) {
            const failed = {
              id: safeString(message.id, 512),
              internetMessageId: safeString(message.internetMessageId, 1_024),
              sender: safeString(message.from?.emailAddress?.name || message.from?.emailAddress?.address, 256) || "未知发件人",
              subject: safeString(message.subject, 512) || "（无主题）",
              receivedAt: safeString(message.receivedDateTime, 80),
              webLink: safeString(message.webLink, 2_048),
              queue: "uncertain",
              actionType: "other",
              actionText: "请确认这封邮件是否需要采取行动",
              dueAt: null,
              dueSource: "none",
              priority: "P1",
              priorityReason: "AI 分类失败，需要人工确认",
              confidence: 0,
              summary: "AI 暂时无法判断此邮件，请人工确认。",
              classification: "not_actionable",
              intent: "other",
              urgency: "medium",
              status: prior?.status && prior.status !== "retry" ? prior.status : "open",
              processingError: error?.code || "OUTLOOK_CLASSIFICATION_FAILED",
              updatedAt: asIso(now()),
            };
            existing.set(failed.id, failed);
          }
          if (inspected >= MAX_MESSAGES_PER_SYNC) break;
        }
        nextUrl = page["@odata.nextLink"] || null;
      }
      state.messages = [...existing.values()].sort((left, right) => String(right.receivedAt || "").localeCompare(String(left.receivedAt || ""))).slice(0, MAX_MESSAGES_PER_SYNC);
      state.sync = {
        cursorReceivedAt: newest || state.sync.cursorReceivedAt,
        classifierVersion: CLASSIFIER_VERSION,
        lastAttemptAt: state.sync.lastAttemptAt,
        lastSuccessAt: asIso(now()),
        lastError: null,
      };
      await writeState(state);
      return { ...publicStatus(state, config), inspected, classified };
    } catch (error) {
      state.sync.lastError = error?.message || "同步失败。";
      await writeState(state).catch(() => {});
      throw error;
    }
  }

  return {
    async status() {
      const state = await readState();
      return publicStatus(state, config);
    },
    async acceptConsent() {
      requireConfigured();
      const state = await readState();
      state.consent = { acceptedAt: asIso(now()), provider: config.modelProvider, version: 2 };
      await writeState(state);
      return publicStatus(state, config);
    },
    async startOAuth() {
      requireConfigured();
      const state = await readState();
      if (!state.consent?.acceptedAt || state.consent?.provider !== config.modelProvider) {
        fail("OUTLOOK_CONSENT_REQUIRED", "AI 来源已变化，请重新确认隐私告知。");
      }
      const stateValue = base64Url(randomBytes(32));
      const verifier = base64Url(randomBytes(48));
      sessions.set(stateValue, { verifier, expiresAt: now().getTime() + OAUTH_SESSION_MS });
      const challenge = base64Url(createHash("sha256").update(verifier).digest());
      const query = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: config.redirectUri,
        response_mode: "query",
        scope: "openid profile offline_access Mail.Read",
        state: stateValue,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      return { authorizationUrl: `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/authorize?${query}` };
    },
    async completeOAuth({ code, state: stateValue, error }) {
      if (error) fail("OUTLOOK_OAUTH_DENIED", "Microsoft 授权未完成。", { error: safeString(error, 120) });
      if (!code || typeof code !== "string") fail("OUTLOOK_OAUTH_STATE_INVALID", "Outlook 授权响应缺少授权码，请重新连接。");
      const session = sessions.get(stateValue);
      sessions.delete(stateValue);
      if (!session || session.expiresAt < now().getTime()) fail("OUTLOOK_OAUTH_STATE_INVALID", "Outlook 授权会话已过期，请重新连接。");
      const token = await requestToken({ grant_type: "authorization_code", code: safeString(code, 8_192), code_verifier: session.verifier });
      const saved = await readState();
      saved.connection = { connectedAt: asIso(now()), token };
      saved.sync = { ...saved.sync, cursorReceivedAt: null, lastError: null };
      await writeState(saved);
      try {
        await runSync();
      } catch {
        // The connection succeeds even when the first sync must be retried.
      }
      return publicStatus(await readState(), config);
    },
    // ---------------------------------------------------------------------
    // 设备码授权（RFC 8628）：不依赖浏览器回跳到 127.0.0.1，也不要求本机浏览器
    // 能直连 Microsoft 登录页。用户可在任意设备（含手机）打开验证地址输入用户码，
    // 后端轮询换取令牌。用于授权码流因浏览器/网络受限而无法完成时的可靠通道。
    // ---------------------------------------------------------------------
    async startDeviceCode() {
      requireConfigured();
      const state = await readState();
      if (!state.consent?.acceptedAt || state.consent?.provider !== config.modelProvider) {
        fail("OUTLOOK_CONSENT_REQUIRED", "AI 来源已变化，请重新确认隐私告知。");
      }
      const response = await externalRequest("Microsoft device code",
        `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/devicecode`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: config.clientId, scope: "openid profile offline_access Mail.Read" }),
        },
      );
      const value = await response.json().catch(() => null);
      if (!response.ok || !value?.device_code) {
        fail("OUTLOOK_DEVICE_CODE_FAILED", `无法获取 Microsoft 设备码：${safeString(value?.error_description || value?.error, 240) || `HTTP ${response.status}`}`);
      }
      const handle = base64Url(randomBytes(24));
      const interval = Math.max(Number(value.interval) || 5, 1);
      sessions.set(`device:${handle}`, {
        deviceCode: value.device_code,
        interval,
        expiresAt: now().getTime() + Number(value.expires_in || 900) * 1000,
      });
      return {
        handle,
        userCode: safeString(value.user_code, 64),
        verificationUri: safeString(value.verification_uri || "https://microsoft.com/devicelogin", 512),
        expiresIn: Number(value.expires_in || 900),
        interval,
      };
    },
    async pollDeviceCode(handle) {
      requireConfigured();
      const key = `device:${safeString(handle, 128)}`;
      const session = sessions.get(key);
      if (!session) fail("OUTLOOK_DEVICE_SESSION_INVALID", "设备码会话不存在，请重新获取设备码。");
      if (session.expiresAt < now().getTime()) {
        sessions.delete(key);
        fail("OUTLOOK_DEVICE_CODE_EXPIRED", "设备码已过期，请重新获取。");
      }
      const response = await externalRequest("Microsoft token",
        `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: config.clientId,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: session.deviceCode,
          }),
        },
      );
      const value = await response.json().catch(() => null);
      if (value?.error) {
        // authorization_pending / slow_down 是协议规定的正常中间态，不是失败。
        if (value.error === "authorization_pending") return { pending: true, reason: "authorization_pending", interval: session.interval };
        if (value.error === "slow_down") {
          session.interval += 5;
          return { pending: true, reason: "slow_down", interval: session.interval };
        }
        sessions.delete(key);
        if (value.error === "expired_token") fail("OUTLOOK_DEVICE_CODE_EXPIRED", "设备码已过期，请重新获取。");
        if (value.error === "authorization_declined") fail("OUTLOOK_OAUTH_DENIED", "Microsoft 授权被拒绝。");
        fail("OUTLOOK_TOKEN_EXCHANGE_FAILED", `Microsoft 授权失败：${safeString(value.error_description || value.error, 240)}`);
      }
      if (!value?.access_token || !value?.refresh_token) {
        fail("OUTLOOK_TOKEN_EXCHANGE_FAILED", "Microsoft 没有返回可用的长期访问令牌。");
      }
      sessions.delete(key);
      const saved = await readState();
      saved.connection = {
        connectedAt: asIso(now()),
        token: {
          accessToken: value.access_token,
          refreshToken: value.refresh_token,
          expiresAt: new Date(now().getTime() + Number(value.expires_in || 3600) * 1000).toISOString(),
          scope: safeString(value.scope, 512),
        },
      };
      saved.sync = { ...saved.sync, cursorReceivedAt: null, lastError: null };
      await writeState(saved);
      try {
        await runSync();
      } catch {
        // 连接已建立，首轮同步失败可稍后重试。
      }
      return { pending: false, ...publicStatus(await readState(), config) };
    },
    async sync(options = {}) {
      // 如果上一次同步正在进行，等待它完成后再执行新的同步
      if (activeSync) {
        console.log("[outlook] 上一次同步正在进行，等待完成...");
        await activeSync;
      }
      activeSync = runSync(options).finally(() => { activeSync = null; });
      return activeSync;
    },
    async list(kind = "todos", { q = "", limit = 10, offset = 0 } = {}) {
      const state = await readState();
      const keyword = String(q || "").trim().toLowerCase();
      const filtered = state.messages.filter((message) => {
        if (kind === "all") return true;
        if (kind === "archive") return ["processed", "ignored", "converted"].includes(message.status);
        if (kind === "informational") return message.queue === "informational" && message.status === "open";
        if (kind === "uncertain") return message.queue === "uncertain" && message.status === "open";
        return message.queue === "action" && message.status === "open";
      }).filter((message) => !keyword || [message.sender, message.subject, message.summary, message.actionText]
        .some((value) => String(value || "").toLowerCase().includes(keyword)))
        .sort((a, b) => {
          const dueRank = (message) => {
            if (!message.dueAt) return 3;
            const due = String(message.dueAt).slice(0, 10);
            const today = new Date().toISOString().slice(0, 10);
            return due < today ? 0 : due === today ? 1 : 2;
          };
          return dueRank(a) - dueRank(b)
            || ({ P0: 0, P1: 1, P2: 2 }[a.priority] ?? 3) - ({ P0: 0, P1: 1, P2: 2 }[b.priority] ?? 3);
        });
      const pageSize = 10;
      const pageOffset = Number.isFinite(Number(offset)) ? Math.max(0, Number(offset)) : 0;
      const items = filtered.slice(pageOffset, pageOffset + pageSize).map(publicMessage);
      const today = new Date().toISOString().slice(0, 10);
      const summary = {
        p0: filtered.filter((message) => message.priority === "P0").length,
        today: filtered.filter((message) => String(message.dueAt || "").slice(0, 10) === today).length,
        overdue: filtered.filter((message) => message.dueAt && String(message.dueAt).slice(0, 10) < today).length,
      };
      return { items, total: filtered.length, summary, ...publicStatus(state, config) };
    },
    async setMessageStatus(id, status) {
      if (!["processed", "ignored", "converted", "open"].includes(status)) fail("OUTLOOK_INVALID_STATUS", "不支持的邮件处理状态。");
      const state = await readState();
      const message = state.messages.find((item) => item.id === id);
      if (!message) fail("OUTLOOK_MESSAGE_NOT_FOUND", "邮件不存在。");
      message.status = status;
      message.updatedAt = asIso(now());
      await writeState(state);
      return publicMessage(message);
    },
    async correctMessage(id, patch = {}) {
      const state = await readState();
      const message = state.messages.find((item) => item.id === id);
      if (!message) fail("OUTLOOK_MESSAGE_NOT_FOUND", "邮件不存在。");
      const normalized = normalizeClassification({ ...message, ...patch, summary: patch.summary || message.summary || message.subject });
      Object.assign(message, normalized, { userCorrectedAt: asIso(now()), status: "open", updatedAt: asIso(now()) });
      await writeState(state);
      return publicMessage(message);
    },
    async disconnect() {
      const state = await readState();
      state.connection = null;
      state.sync = { cursorReceivedAt: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null };
      await writeState(state);
      return publicStatus(state, config);
    },
    startScheduler() {
      if (scheduler) return;
      console.log(`[outlook] 自动同步已启动，间隔 ${syncIntervalMs / 60000} 分钟`);
      scheduler = setInterval(() => {
        console.log("[outlook] 定时同步触发");
        void this.sync({ allowAi: false })
          .then((result) => {
            if (result) {
              console.log(`[outlook] 同步完成，检查了 ${result.inspected || 0} 封，分类了 ${result.classified || 0} 封`);
            }
          })
          .catch((err) => {
            console.error("[outlook] 定时同步失败:", err?.message || err);
          });
      }, syncIntervalMs);
    },
    async close() {
      if (scheduler) clearInterval(scheduler);
      scheduler = null;
    },
  };
}
