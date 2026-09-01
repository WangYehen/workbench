import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { buildCodexPrompt, buildOpenCodeSystemPrompt } from "./prompts/index.mjs";

const OUTPUT_LIMIT = 128 * 1024;
const STATUS_TIMEOUT_MS = 12_000;
const MODEL_COOLDOWN_MS = 10 * 60 * 1000;

export class AiProviderError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
    this.details = details;
  }
}

function appendLimited(current, chunk) {
  const next = current + String(chunk || "");
  return next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next;
}

function usesShell(command) {
  return process.platform === "win32" && (!path.extname(command) || /\.(cmd|bat)$/i.test(command));
}

function spawnCli(command, args, options = {}) {
  const shell = usesShell(command);
  const executable = shell ? (process.env.ComSpec || "cmd.exe") : command;
  const executableArgs = shell
    ? ["/d", "/s", "/c", `"${command}" ${args.map((arg) => `"${String(arg).replace(/"/g, '""')}"`).join(" ")}`]
    : args;
  return spawn(executable, executableArgs, {
    cwd: options.cwd,
    env: options.env || process.env,
    windowsHide: true,
    shell: false,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  });
}

function nativeExecutableFromShim(shimPath, name = "") {
  if (!/\.cmd$/i.test(shimPath)) return "";
  try {
    const content = fs.readFileSync(shimPath, "utf8");
    const matches = [...content.matchAll(/"%dp0%\\([^"\r\n]+\.exe)"/gi)];
    for (const match of matches) {
      const candidate = path.resolve(path.dirname(shimPath), match[1]);
      if (path.basename(candidate).toLowerCase() !== "node.exe" && fs.existsSync(candidate)) return candidate;
    }
    if (name === "codex") {
      const architecture = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
      const packageArchitecture = process.arch === "arm64" ? "arm64" : "x64";
      const candidate = path.join(
        path.dirname(shimPath),
        "node_modules", "@openai", "codex", "node_modules", "@openai", `codex-win32-${packageArchitecture}`,
        "vendor", architecture, "bin", "codex.exe",
      );
      if (fs.existsSync(candidate)) return candidate;
    }
    return "";
  } catch {
    return "";
  }
}

export function runCommand(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs || STATUS_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try {
      child = spawnCli(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new AiProviderError("not_installed", error.message));
      return;
    }
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new AiProviderError("timeout", `${path.basename(command)} 命令超时`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout = appendLimited(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendLimited(stderr, chunk); });
    child.on("error", (error) => finish(new AiProviderError("not_installed", error.message)));
    child.on("close", (code) => {
      if (code === 0) finish(null, { stdout: stdout.trim(), stderr: stderr.trim(), code });
      else finish(new AiProviderError(
        code === 127 || code === 9009 ? "not_installed" : "process_exit",
        (stderr || stdout || `${path.basename(command)} 退出码 ${code}`).trim(),
        { code },
      ));
    });
  });
}

export async function resolveCli(name, explicitPath = "") {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) throw new AiProviderError("not_installed", `找不到 ${explicitPath}`);
    return nativeExecutableFromShim(explicitPath, name) || explicitPath;
  }
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const result = await runCommand(locator, [name], { timeoutMs: 5_000 });
    const candidates = result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (process.platform === "win32") {
      const native = candidates.find((item) => /\.exe$/i.test(item));
      const shim = candidates.find((item) => /\.cmd$/i.test(item));
      return native
        || nativeExecutableFromShim(shim || "", name)
        || candidates.find((item) => /\.(cmd|bat)$/i.test(item))
        || candidates[0]
        || name;
    }
    return candidates[0] || name;
  } catch {
    return name;
  }
}

async function openCodeEnvironment(runtimeConfig, extra = {}) {
  const runtimeRoot = path.resolve(runtimeConfig.dataDir, "ai-runtime", "opencode");
  const configRoot = path.join(runtimeRoot, "config");
  const cacheRoot = path.join(runtimeRoot, "cache");
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(cacheRoot, { recursive: true }),
  ]);
  return {
    ...process.env,
    XDG_CONFIG_HOME: configRoot,
    // OpenCode 的登录凭据位于默认 XDG_DATA_HOME（Windows 下为 ~/.local/share）。
    // 不能改到临时目录，否则“模型可见”但实际请求会因凭据不可见而失败。
    XDG_CACHE_HOME: cacheRoot,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "deny" }),
    ...extra,
  };
}

function cleanError(error) {
  return String(error?.message || error || "未知错误").replace(/\s+/g, " ").trim().slice(0, 360);
}

export function parseJsonContent(value) {
  if (value && typeof value === "object") return value;
  const raw = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(raw); } catch { /* 尝试提取外层 JSON。 */ }
  const start = Math.min(...[raw.indexOf("{"), raw.indexOf("[")].filter((index) => index >= 0));
  if (!Number.isFinite(start)) throw new AiProviderError("invalid_output", "模型没有返回 JSON");
  const open = raw[start];
  const end = raw.lastIndexOf(open === "{" ? "}" : "]");
  if (end <= start) throw new AiProviderError("invalid_output", "模型返回的 JSON 不完整");
  try { return JSON.parse(raw.slice(start, end + 1)); }
  catch { throw new AiProviderError("invalid_output", "模型返回的 JSON 无法解析"); }
}

function modelCostIsZero(model) {
  const cost = model?.cost;
  if (!cost || Number(cost.input) !== 0 || Number(cost.output) !== 0) return false;
  const cache = cost.cache || {};
  return (cache.read == null || Number(cache.read) === 0)
    && (cache.write == null || Number(cache.write) === 0);
}

export function parseOpenCodeFreeModels(output, preferredOrder = []) {
  const parsed = [];
  for (const chunk of String(output || "").split(/^opencode\//m).slice(1)) {
    const newline = chunk.indexOf("\n");
    const fullId = `opencode/${(newline >= 0 ? chunk.slice(0, newline) : chunk).trim()}`;
    const metadataText = newline >= 0 ? chunk.slice(newline + 1).trim() : "";
    let metadata = null;
    try { metadata = metadataText ? JSON.parse(metadataText) : null; } catch { /* 忽略损坏条目。 */ }
    if (metadata?.status === "active" && modelCostIsZero(metadata)) {
      parsed.push({ id: metadata.id || fullId.slice("opencode/".length), fullId, name: metadata.name || fullId });
    }
  }
  const priority = preferredOrder.map((id) => String(id).replace(/^opencode\//, ""));
  return parsed.toSorted((a, b) => {
    const left = priority.indexOf(a.id);
    const right = priority.indexOf(b.id);
    if (left === -1 && right === -1) return 0;
    if (left === -1) return 1;
    if (right === -1) return -1;
    return left - right;
  });
}

async function createIsolatedDirectory(dataDir, prefix) {
  const base = path.resolve(dataDir, "ai-runtime");
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, `${prefix}-`));
}

async function cleanupIsolatedDirectory(dataDir, directory) {
  const base = path.resolve(dataDir, "ai-runtime") + path.sep;
  const target = path.resolve(directory);
  if (!target.startsWith(base)) return;
  try {
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    // Windows 下 OpenCode 子进程退出存在短暂文件句柄延迟。清理失败不能
    // 把已经成功的模型响应改判为 provider 失败；后台再尝试一次即可。
    if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
    setTimeout(() => rm(target, { recursive: true, force: true }).catch(() => {}), 500).unref?.();
  }
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function authHeaders(username, password) {
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    "Content-Type": "application/json",
  };
}

async function fetchJson(url, options = {}, timeoutMs = STATUS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new AiProviderError(
      response.status === 401 ? "not_authenticated" : response.status === 429 ? "quota" : "provider_http",
      `HTTP ${response.status}${text ? `：${text.slice(0, 240)}` : ""}`,
    );
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (error?.name === "AbortError") throw new AiProviderError("timeout", "AI 来源响应超时");
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError("provider_http", error?.message || String(error));
  } finally {
    clearTimeout(timer);
  }
}

async function waitForOpenCode(baseUrl, headers, child, stderrRef) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new AiProviderError("process_exit", stderrRef() || "OpenCode 服务启动失败");
    try {
      const health = await fetchJson(`${baseUrl}/global/health`, { headers }, 1_000);
      if (health?.healthy) return health;
    } catch { /* 服务仍在启动。 */ }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new AiProviderError("timeout", "OpenCode 服务启动超时");
}

async function startOpenCodeServer(runtimeConfig, command, directory) {
  const port = await reservePort();
  const username = "workbench";
  const password = randomBytes(24).toString("base64url");
  const baseUrl = `http://127.0.0.1:${port}`;
  let stderr = "";
  const env = await openCodeEnvironment(runtimeConfig, {
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    NO_COLOR: "1",
  });
  const child = spawnCli(command, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--pure", "--log-level", "ERROR"], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => { stderr = appendLimited(stderr, chunk); });
  child.stdout?.on("data", () => {});
  const headers = authHeaders(username, password);
  try {
    const health = await waitForOpenCode(baseUrl, headers, child, () => stderr.trim());
    return { child, baseUrl, headers, version: health.version || "" };
  } catch (error) {
    child.kill();
    throw error;
  }
}

function extractOpenCodeText(result) {
  const structuredError = result?.info?.error?.name === "StructuredOutputError";
  if (result?.info?.error && !structuredError) throw new AiProviderError("provider_error", JSON.stringify(result.info.error).slice(0, 360));
  const text = (result?.parts || [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!text) {
    if (structuredError) throw new AiProviderError("provider_error", JSON.stringify(result.info.error).slice(0, 360));
    throw new AiProviderError("invalid_output", "OpenCode 没有返回文本");
  }
  return text;
}

async function callOpenCodeModel(server, directory, model, request, timeoutMs) {
  const query = `?directory=${encodeURIComponent(directory)}`;
  const session = await fetchJson(`${server.baseUrl}/session${query}`, {
    method: "POST",
    headers: server.headers,
    body: JSON.stringify({
      title: "个人 AI 工作台 · 临时生成",
      permission: [{ permission: "*", pattern: "*", action: "deny" }],
    }),
  }, 10_000);
  try {
    const result = await fetchJson(`${server.baseUrl}/session/${encodeURIComponent(session.id)}/message${query}`, {
      method: "POST",
      headers: server.headers,
      body: JSON.stringify({
        model: { providerID: "opencode", modelID: model.id },
        system: buildOpenCodeSystemPrompt(request.system),
        tools: {
          bash: false, read: false, edit: false, write: false, glob: false, grep: false,
          task: false, skill: false, webfetch: false, websearch: false,
        },
        parts: [{ type: "text", text: request.user }],
      }),
    }, timeoutMs);
    const text = extractOpenCodeText(result);
    try {
      return parseJsonContent(text);
    } catch (error) {
      // 部分 OpenCode 免费模型不支持 StructuredOutput，但仍能稳定产出一段总结文本。
      // 上层仅对 dashboard.suggestion 将其作为文本建议接收；结构化领域继续失败回退。
      return { __text: text };
    }
  } finally {
    await fetchJson(`${server.baseUrl}/session/${encodeURIComponent(session.id)}${query}`, {
      method: "DELETE",
      headers: server.headers,
    }, 5_000).catch(() => {});
  }
}

class JsonRpcLineClient {
  constructor(child) {
    this.child = child;
    this.sequence = 0;
    this.pending = new Map();
    this.waiters = new Set();
    this.buffer = "";
    this.stderr = "";
    child.stderr?.on("data", (chunk) => { this.stderr = appendLimited(this.stderr, chunk); });
    child.stdout?.on("data", (chunk) => this.consume(chunk));
    child.on("error", (error) => this.failAll(new AiProviderError("process_exit", error.message)));
    child.on("close", (code) => this.failAll(new AiProviderError("process_exit", this.stderr.trim() || `Codex App Server 退出码 ${code}`)));
  }

  consume(chunk) {
    this.buffer += String(chunk);
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id != null && (message.result !== undefined || message.error)) {
        const pending = this.pending.get(String(message.id));
        if (pending) {
          this.pending.delete(String(message.id));
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new AiProviderError("provider_error", message.error.message || JSON.stringify(message.error)));
          else pending.resolve(message.result);
        }
        continue;
      }
      if (message.method) {
        for (const waiter of [...this.waiters]) {
          if (waiter.method === message.method && (!waiter.predicate || waiter.predicate(message.params))) {
            this.waiters.delete(waiter);
            clearTimeout(waiter.timer);
            waiter.resolve(message.params);
          }
        }
        if (message.id != null) {
          this.send({ id: message.id, error: { code: -32601, message: "Workbench does not expose interactive tools" } });
        }
      }
    }
  }

  send(message) {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = STATUS_TIMEOUT_MS) {
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AiProviderError("timeout", `Codex ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  waitNotification(method, predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new AiProviderError("timeout", `Codex ${method} 超时`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  close() {
    this.failAll(new AiProviderError("process_exit", "Codex App Server 已关闭"));
    this.child.kill();
  }
}

async function initializeCodexClient(runtimeConfig, command, directory) {
  const child = spawnCli(command, ["app-server"], {
    cwd: directory,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new JsonRpcLineClient(child);
  await client.request("initialize", {
    clientInfo: { name: "personal-ai-workbench", title: "个人 AI 工作台", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  }, 15_000);
  client.notify("initialized");
  return client;
}

function extractCodexText(completion) {
  if (completion?.turn?.status === "failed") {
    const detail = completion.turn.error?.message || "Codex 生成失败";
    const info = completion.turn.error?.codexErrorInfo;
    const code = info === "usageLimitExceeded" ? "quota" : info === "unauthorized" ? "not_authenticated" : "provider_error";
    throw new AiProviderError(code, detail);
  }
  const text = (completion?.turn?.items || [])
    .filter((item) => item?.type === "agentMessage" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (!text) throw new AiProviderError("invalid_output", "Codex 没有返回最终内容");
  return text;
}

async function callCodex(runtimeConfig, command, request) {
  const directory = await createIsolatedDirectory(runtimeConfig.dataDir, "codex");
  try {
    const schemaPath = path.join(directory, "output-schema.json");
    const outputPath = path.join(directory, "output.json");
    const prompt = buildCodexPrompt(request.system, request.user);
    await writeFile(schemaPath, JSON.stringify(request.schema), "utf8");
    const args = [
      "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-rules",
      "--output-schema", schemaPath, "--output-last-message", outputPath,
    ];
    if (runtimeConfig.ai.codex.model) args.push("--model", runtimeConfig.ai.codex.model);
    if (runtimeConfig.ai.codex.reasoningEffort) args.push("-c", `model_reasoning_effort=${runtimeConfig.ai.codex.reasoningEffort}`);
    args.push(prompt);
    await runCommand(command, args, { cwd: directory, timeoutMs: runtimeConfig.ai.codex.timeoutMs });
    return parseJsonContent(await readFile(outputPath, "utf8"));
  } finally {
    await cleanupIsolatedDirectory(runtimeConfig.dataDir, directory);
  }
}

function configuredApi(runtimeConfig, provider) {
  if (provider === "ollama") return Boolean(runtimeConfig.ai.ollama.enabled);
  return Boolean(runtimeConfig.ai[provider]?.apiKey);
}

async function callApi(runtimeConfig, provider, request) {
  const c = runtimeConfig.ai[provider];
  const controller = new AbortController();
  const timeoutMs = Math.min(request.timeoutMs || 60_000, 120_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (provider === "deepseek" || provider === "openai") {
      const response = await fetch(`${c.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify({
          model: c.model,
          temperature: request.temperature ?? 0.2,
          messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
          response_format: { type: "json_object" },
        }),
      });
      const text = await response.text();
      if (!response.ok) throw new AiProviderError(response.status === 429 ? "quota" : "provider_http", `${provider} HTTP ${response.status}：${text.slice(0, 240)}`);
      const payload = JSON.parse(text);
      return parseJsonContent(payload?.choices?.[0]?.message?.content);
    }
    if (provider === "claude") {
      const response = await fetch(`${c.baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: c.model,
          max_tokens: 2_000,
          temperature: request.temperature ?? 0.2,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
        }),
      });
      const text = await response.text();
      if (!response.ok) throw new AiProviderError(response.status === 429 ? "quota" : "provider_http", `claude HTTP ${response.status}：${text.slice(0, 240)}`);
      const payload = JSON.parse(text);
      return parseJsonContent(payload?.content?.[0]?.text);
    }
    if (provider === "ollama") {
      const response = await fetch(`${c.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: c.model,
          format: request.schema,
          stream: false,
          messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
        }),
      });
      const text = await response.text();
      if (!response.ok) throw new AiProviderError("provider_http", `ollama HTTP ${response.status}：${text.slice(0, 240)}`);
      const payload = JSON.parse(text);
      return parseJsonContent(payload?.message?.content);
    }
    throw new AiProviderError("not_configured", `未知 AI 来源 ${provider}`);
  } catch (error) {
    if (error?.name === "AbortError") throw new AiProviderError("timeout", `${provider} 响应超时`);
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError("provider_error", error?.message || String(error));
  } finally {
    clearTimeout(timer);
  }
}

function createSerialQueue() {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  };
}

export function apiProviderOrder(runtimeConfig) {
  const preferred = runtimeConfig.ai.apiFallbackOrder.length
    ? runtimeConfig.ai.apiFallbackOrder
    : ["ollama", "deepseek", "openai", "claude"];
  return [runtimeConfig.ai.provider, ...preferred]
    .filter((provider, index, list) => ["ollama", "deepseek", "openai", "claude"].includes(provider) && list.indexOf(provider) === index)
    .filter((provider) => configuredApi(runtimeConfig, provider));
}

export function createDefaultAiAdapters(runtimeConfig) {
  const queue = createSerialQueue();
  const cooldown = new Map();
  const cliCache = { codex: null, opencode: null };

  async function detectCodex(refresh = false) {
    if (!refresh && cliCache.codex && Date.now() - cliCache.codex.at < 30_000) return cliCache.codex.value;
    let value;
    try {
      const command = await resolveCli("codex", runtimeConfig.ai.codex.path);
      const [version, login] = await Promise.all([
        runCommand(command, ["--version"], { timeoutMs: 5_000 }),
        runCommand(command, ["login", "status"], { timeoutMs: 8_000 }),
      ]);
      value = { id: "codex", installed: true, ready: true, authenticated: true, version: version.stdout, detail: login.stdout || login.stderr, models: runtimeConfig.ai.codex.model ? [runtimeConfig.ai.codex.model] : [] };
    } catch (error) {
      value = { id: "codex", installed: error?.code !== "not_installed", ready: false, authenticated: false, version: "", detail: cleanError(error), models: [] };
    }
    cliCache.codex = { at: Date.now(), value };
    return value;
  }

  async function detectOpenCode(refresh = false) {
    if (!refresh && cliCache.opencode && Date.now() - cliCache.opencode.at < 30_000) return cliCache.opencode.value;
    let value;
    try {
      const command = await resolveCli("opencode", runtimeConfig.ai.opencode.path);
      const env = await openCodeEnvironment(runtimeConfig, { NO_COLOR: "1" });
      const [version, modelsResult] = await Promise.all([
        runCommand(command, ["--version"], { timeoutMs: 5_000, env }),
        runCommand(command, ["models", "opencode", "--verbose"], { timeoutMs: STATUS_TIMEOUT_MS, env }),
      ]);
      const models = parseOpenCodeFreeModels(modelsResult.stdout, runtimeConfig.ai.opencode.freeModelOrder);
      value = { id: "opencode", installed: true, ready: models.length > 0, authenticated: models.length > 0, version: version.stdout, detail: models.length ? `${models.length} 个零成本模型可用` : "没有检测到零成本模型", models: models.map((item) => item.fullId), modelEntries: models, command };
    } catch (error) {
      value = { id: "opencode", installed: error?.code !== "not_installed", ready: false, authenticated: false, version: "", detail: cleanError(error), models: [], modelEntries: [] };
    }
    cliCache.opencode = { at: Date.now(), value };
    return value;
  }

  const adapters = {
    opencode: {
      status: detectOpenCode,
      async generate(request) {
        return queue(async () => {
          const status = await detectOpenCode();
          if (!status.ready) throw new AiProviderError(status.installed ? "no_models" : "not_installed", status.detail);
          const directory = await createIsolatedDirectory(runtimeConfig.dataDir, "opencode");
          let server;
          const attempts = [];
          try {
            const command = status.command || await resolveCli("opencode", runtimeConfig.ai.opencode.path);
            server = await startOpenCodeServer(runtimeConfig, command, directory);
            // 一次任务只试一个首选模型；失败由上层切换提供方，避免耗尽整个免费池。
            const model = status.modelEntries.find((item) => (cooldown.get(item.fullId) || 0) <= Date.now());
            if (!model) throw new AiProviderError("all_models_cooling", "OpenCode 模型暂处于冷却期");
            try {
              const data = await callOpenCodeModel(server, directory, model, request, runtimeConfig.ai.opencode.timeoutMs);
              return { data, model: model.fullId };
            } catch (error) {
              attempts.push({ model: model.fullId, code: error?.code || "error", message: cleanError(error) });
              cooldown.set(model.fullId, Date.now() + MODEL_COOLDOWN_MS);
              throw new AiProviderError("model_failed", "OpenCode 首选模型请求失败", attempts);
            }
          } finally {
            server?.child?.kill();
            await cleanupIsolatedDirectory(runtimeConfig.dataDir, directory);
          }
        });
      },
    },
    codex: {
      status: detectCodex,
      async generate(request) {
        return queue(async () => {
          const status = await detectCodex();
          if (!status.ready) throw new AiProviderError(status.installed ? "not_authenticated" : "not_installed", status.detail);
          const command = await resolveCli("codex", runtimeConfig.ai.codex.path);
          const data = await callCodex(runtimeConfig, command, request);
          return { data, model: runtimeConfig.ai.codex.model || "account-default" };
        });
      },
    },
  };

  for (const provider of ["ollama", "deepseek", "openai", "claude"]) {
    adapters[provider] = {
      async status() {
        const ready = configuredApi(runtimeConfig, provider);
        return { id: provider, installed: true, ready, authenticated: ready, version: "", detail: ready ? "已配置" : "未配置", models: ready ? [runtimeConfig.ai[provider].model] : [] };
      },
      async generate(request) {
        if (!configuredApi(runtimeConfig, provider)) throw new AiProviderError("not_configured", `${provider} 未配置`);
        const data = await callApi(runtimeConfig, provider, request);
        return { data, model: runtimeConfig.ai[provider].model };
      },
    };
  }

  return adapters;
}
