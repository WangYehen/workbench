import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// 关键：dotenv 默认不会覆盖已经存在的环境变量。
// 一旦 shell/WorkBuddy 桌面进程里挂着过期的 DEEPSEEK_API_KEY 等凭据，.env 里更新过的密钥会被静默吞掉，
// 导致"按文档改了 .env 还是报错"的诡异现象。
// 这里强制以 .env 为准：与代码仓库版本一致、便于团队多人协作与 CI。
const ENV_PATH = process.env.WORKBENCH_CONFIG_PATH
  ? path.resolve(process.env.WORKBENCH_CONFIG_PATH)
  : path.resolve(__dirname, "..", ".env");
if (fs.existsSync(ENV_PATH)) {
  dotenv.config({ path: ENV_PATH, override: true });
}

// 开发环境前端走 Vite 5174；安装包生产环境由 Express 在 8787 同时托管前后端。
const FRONTEND_PORT = Number(process.env.WORKBENCH_PORT || 5174);
const SERVICE_PORT = Number(process.env.PORT || 8787);
const IS_PROD = process.env.NODE_ENV === "production";
const DEFAULT_PUBLIC_BASE_URL = IS_PROD
  ? `http://127.0.0.1:${SERVICE_PORT}`
  : `http://127.0.0.1:${FRONTEND_PORT}`;

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function list(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  root: ROOT,
  installRoot: process.env.WORKBENCH_INSTALL_ROOT || ROOT,
  configPath: ENV_PATH,
  appVersion: process.env.WORKBENCH_APP_VERSION || "dev",
  runtimeMode: process.env.WORKBENCH_RUNTIME_MODE || (IS_PROD ? "web-installer" : "development"),
  displayName: process.env.WORKBENCH_DISPLAY_NAME || "",
  host: process.env.HOST || "127.0.0.1",
  port: SERVICE_PORT,
  publicBaseUrl: process.env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL,
  corsOrigin: process.env.CORS_ORIGIN || DEFAULT_PUBLIC_BASE_URL,
  isProd: IS_PROD,

  ai: {
    provider: process.env.AI_PROVIDER || "deepseek",
    routingMode: ["legacy", "smart"].includes(process.env.AI_ROUTING_MODE)
      ? process.env.AI_ROUTING_MODE
      : "legacy",
    maxConcurrency: Math.max(1, Number(process.env.AI_MAX_CONCURRENCY || 1)),
    apiFallbackOrder: list(process.env.AI_API_FALLBACK_ORDER),
    opencode: {
      path: process.env.OPENCODE_CLI_PATH || "",
      model: process.env.OPENCODE_MODEL || "opencode/big-pickle",
      freeModelOrder: list(process.env.OPENCODE_FREE_MODEL_ORDER),
      timeoutMs: Math.max(5_000, Number(process.env.OPENCODE_TIMEOUT_MS || 90_000)),
    },
    codex: {
      path: process.env.CODEX_CLI_PATH || "",
      // AI 总结以低延迟和稳定结构化输出为主，默认使用高频工作负载模型。
      model: process.env.CODEX_MODEL || "gpt-5.6-luna",
      reasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"].includes(process.env.CODEX_REASONING_EFFORT)
        ? process.env.CODEX_REASONING_EFFORT
        : "medium",
      timeoutMs: Math.max(5_000, Number(process.env.CODEX_TIMEOUT_MS || 120_000)),
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY || "",
      baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      model: process.env.OPENAI_MODEL || "gpt-4o",
    },
    claude: {
      apiKey: process.env.CLAUDE_API_KEY || "",
      baseUrl: process.env.CLAUDE_BASE_URL || "https://api.anthropic.com",
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4",
    },
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      model: process.env.OLLAMA_MODEL || process.env.OLLM_MODEL || "qwen2.5:14b",
      enabled: (process.env.AI_PROVIDER || "deepseek") === "ollama" || Boolean(
        process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL || process.env.OLLM_MODEL,
      ),
    },
  },

  // Outlook / Microsoft Graph（多租户公共客户端，PKCE 无 secret；令牌用 AES-256-GCM 加密存本地）
  // 变量名与 GitHub 仓库 WangYehen/my-work-bench 保持一致
  outlook: {
    clientId: process.env.OUTLOOK_ENTRA_CLIENT_ID || "",
    tenantId: process.env.OUTLOOK_ENTRA_TENANT_ID || "common",
    redirectUri: process.env.OUTLOOK_OAUTH_REDIRECT_URI || `${DEFAULT_PUBLIC_BASE_URL}/api/outlook/oauth/callback`,
    tokenEncryptionKey: process.env.OUTLOOK_TOKEN_ENCRYPTION_KEY || "",
  },

  dingtalk: {
    clientId: process.env.DINGTALK_CLIENT_ID || "",
    clientSecret: process.env.DINGTALK_CLIENT_SECRET || "",
    redirectUri: process.env.DINGTALK_REDIRECT_URI || `${DEFAULT_PUBLIC_BASE_URL}/oauth/dingtalk/callback`,
    managerUserId: process.env.DINGTALK_MANAGER_USER_ID || "",
    reportTemplateId: process.env.DINGTALK_REPORT_TEMPLATE_ID || "",
    agentId: process.env.DINGTALK_AGENT_ID || "",
  },

  // DWS 负责当前登录用户的个人/群聊消息；认证材料由 DWS 自己的安全存储管理。
  dws: {
    executable: process.env.DWS_EXECUTABLE || "dws",
  },

  aiHot: {
    origin: process.env.AI_HOT_ORIGIN || "https://aihot.virxact.com",
  },

  useDemoData: bool(process.env.USE_DEMO_DATA, true),

  dataDir: process.env.WORKBENCH_DATA_DIR
    ? path.resolve(process.env.WORKBENCH_DATA_DIR)
    : path.join(ROOT, ".local"),
};

export function ensureDataDir() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
}

export function configured() {
  return {
    outlook: Boolean(
      config.outlook.clientId &&
        config.outlook.redirectUri &&
        config.outlook.tokenEncryptionKey,
    ),
    dingtalk: Boolean(config.dingtalk.clientId && config.dingtalk.clientSecret),
    ai: Boolean(
      config.ai.routingMode === "smart" ||
        (config.ai.provider === "deepseek" && config.ai.deepseek.apiKey) ||
        (config.ai.provider === "openai" && config.ai.openai.apiKey) ||
        (config.ai.provider === "claude" && config.ai.claude.apiKey) ||
        config.ai.provider === "ollama",
    ),
    aiHot: true,
  };
}
