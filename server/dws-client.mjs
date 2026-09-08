import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { config } from "./config.mjs";

function asArray(value) { return Array.isArray(value) ? value : []; }
function valueAt(value, paths, fallback = null) {
  for (const path of paths) {
    let current = value;
    for (const part of path.split(".")) current = current?.[part];
    if (current != null && current !== "") return current;
  }
  return fallback;
}
function parseJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* 兼容 JSON 前后带 CLI 日志的输出 */ }
  // NDJSON/日志混排时，优先尝试每一行的完整 JSON，避免把最后一行
  // 元数据误当成业务响应。
  for (const line of raw.split(/\r?\n/)) { try { return JSON.parse(line); } catch { /* try next line */ } }
  const start = raw.search(/[\[{]/); const endObject = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  if (start >= 0 && endObject > start) { try { return JSON.parse(raw.slice(start, endObject + 1)); } catch { /* 返回空值，由上层给出明确错误 */ } }
  return null;
}
function ledger(payload, exitCode) {
  const failures = asArray(payload?.failures);
  const hasMore = payload?.hasMore === true;
  const partial = payload?.partial === true || hasMore || failures.length > 0 || exitCode !== 0;
  return { complete: payload?.complete === true && !partial, partial, hasMore, failures, nextCursor: payload?.nextCursor ?? null };
}
function error(message, code) { return Object.assign(new Error(message), { code }); }

export function createDwsClient({ executable = config.dws.executable, run = null, now = () => new Date() } = {}) {
  const previews = new Map();
  let statusCache = null;
  let capabilitiesCache = null;

  async function raw(args, { timeoutMs = 15_000 } = {}) {
    if (run) {
      const result = await run(args);
      if (result && typeof result === "object" && "stdout" in result) return { stdout: result.stdout, stderr: result.stderr || "", exitCode: result.exitCode ?? 0 };
      return { stdout: typeof result === "string" ? result : JSON.stringify(result ?? {}), stderr: "", exitCode: 0 };
    }
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { shell: false, windowsHide: true });
      let stdout = ""; let stderr = "";
      const timer = setTimeout(() => { child.kill(); reject(error("DWS 命令超时", "DWS_TIMEOUT")); }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", () => { clearTimeout(timer); reject(error("未检测到 DWS，请在设置中完成安装和连接。", "DWS_NOT_INSTALLED")); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? -1 }); });
    });
  }

  async function read(command, options = {}) {
    const args = Array.isArray(command) ? [...command] : String(command || "").trim().split(/\s+/).filter(Boolean);
    if (!args.length) throw error("缺少 DWS 命令", "DWS_COMMAND_REQUIRED");
    if (!args.includes("--format")) args.push("--format", "json");
    const result = await raw(args, options);
    const data = parseJson(result.stdout);
    if (!data) throw error(String(result.stderr || "DWS 未返回可读取的数据").trim().slice(0, 240), result.exitCode === 0 ? "DWS_EMPTY_RESPONSE" : "DWS_COMMAND_FAILED");
    return { data, ledger: ledger(data, result.exitCode) };
  }
  async function write(command, options = {}) {
    await currentProfile();
    return read(command, options);
  }

  async function currentProfile() {
    const { data } = await read(["profile", "list"]);
    const profiles = asArray(valueAt(data, ["profiles", "result.profiles", "items"], []));
    const profile = profiles.find((item) => item?.isOrgCurrent === true || item?.current === true || item?.active === true);
    if (profile) return {
      id: String(valueAt(profile, ["id", "profileId", "name"], "")) || null,
      org: valueAt(profile, ["corpName", "orgName", "tenant"], null),
      user: valueAt(profile, ["userName", "name", "nick"], null),
      raw: profile,
    };
    const explicit = valueAt(data, ["currentProfile", "result.currentProfile"], null);
    if (explicit) return { id: String(explicit), org: null, user: null, raw: null };
    throw error("DWS 未标记当前组织，请先在钉钉连接中心选择组织。", "DWS_PROFILE_AMBIGUOUS");
  }

  async function status({ force = false } = {}) {
    // 登录前的失败状态不能长期缓存：用户完成 `dws auth login` 后，
    // 同一进程应能在下一次同步检测中立即恢复为已连接。
    if (!force && statusCache?.connected) return statusCache;
    try {
      const [version, auth, profile] = await Promise.all([
        read(["version"]), read(["auth", "status"]), currentProfile(),
      ]);
      const authData = auth.data;
      statusCache = {
        installed: true,
        connected: Boolean(valueAt(authData, ["connected", "authenticated", "result.connected", "result.authenticated"], false)),
        version: valueAt(version.data, ["version", "result.version"], "已安装"),
        account: { org: valueAt(authData, ["corpName", "orgName", "result.corpName"], profile.org), user: valueAt(authData, ["userName", "name", "nick", "result.userName"], profile.user), profile: profile.id },
        checkedAt: now().toISOString(),
      };
    } catch (cause) {
      statusCache = { installed: cause?.code !== "DWS_NOT_INSTALLED", connected: false, account: null, error: cause.message, errorCode: cause.code || "DWS_STATUS_FAILED", checkedAt: now().toISOString() };
    }
    return statusCache;
  }

  async function probe(command) { try { return (await raw([...command, "--help"], { timeoutMs: 10_000 })).exitCode === 0; } catch { return false; } }
  async function capabilities({ force = false } = {}) {
    if (!force && capabilitiesCache) return capabilitiesCache;
    const [todo, calendar, contact, chat, minutes, approval] = await Promise.all([
      probe(["todo", "task", "list"]), probe(["calendar", "event", "list"]), probe(["contact", "user", "get-self"]),
      probe(["chat", "+search-msg"]), probe(["minutes", "list"]), probe(["oa", "list"]),
    ]);
    capabilitiesCache = { todo, calendar, contact, chat, minutes, approval, checkedAt: now().toISOString() };
    return capabilitiesCache;
  }

  function preview(command, payload = {}) {
    const id = `preview_${crypto.randomUUID()}`;
    const item = { id, command, payload, createdAt: now().toISOString(), expiresAt: Date.now() + 10 * 60 * 1000 };
    previews.set(id, item);
    return item;
  }
  async function executeConfirmed(command, payload = {}, { previewId, idempotencyKey, confirmed } = {}) {
    if (!confirmed || !previewId || !idempotencyKey) throw error("执行操作前必须完成预览并明确确认。", "DWS_CONFIRMATION_REQUIRED");
    const item = previews.get(previewId);
    if (!item || item.expiresAt < Date.now() || item.command !== command) throw error("预览已失效，请重新确认操作。", "DWS_PREVIEW_EXPIRED");
    previews.delete(previewId);
    return { preview: item, idempotencyKey, payload: item.payload, executed: false, message: "该动作尚未接入具体 DWS 连接器。" };
  }

  return { read, write, currentProfile, status, capabilities, preview, executeConfirmed };
}

export const dwsClient = createDwsClient();
