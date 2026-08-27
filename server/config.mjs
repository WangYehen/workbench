import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
// 前端端口：与仓库对齐，默认 5174（可用 WORKBENCH_PORT 覆盖），决定 OAuth 回跳/跨域源
const FRONTEND_PORT = Number(process.env.WORKBENCH_PORT || 5174);

// 关键：dotenv 默认不会覆盖已经存在的环境变量。
// 一旦 shell/WorkBuddy 桌面进程里挂着过期的 DEEPSEEK_API_KEY 等凭据，.env 里更新过的密钥会被静默吞掉，
// 导致"按文档改了 .env 还是报错"的诡异现象。
// 这里强制以 .env 为准：与代码仓库版本一致、便于团队多人协作与 CI。
const ENV_PATH = path.resolve(__dirname, "..", ".env");
if (fs.existsSync(ENV_PATH)) {
  dotenv.config({ path: ENV_PATH, override: true });
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export const config = {
  root: ROOT,
  displayName: process.env.WORKBENCH_DISPLAY_NAME || "",
  port: Number(process.env.PORT || 8787),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${FRONTEND_PORT}`,
  corsOrigin: process.env.CORS_ORIGIN || `http://127.0.0.1:${FRONTEND_PORT}`,
  isProd: bool(process.env.NODE_ENV === "production"),

  ai: {
    provider: process.env.AI_PROVIDER || "deepseek",
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
      model: process.env.OLLM_MODEL || "qwen2.5:14b",
    },
  },

  // Outlook / Microsoft Graph（多租户公共客户端，PKCE 无 secret；令牌用 AES-256-GCM 加密存本地）
  // 变量名与 GitHub 仓库 WangYehen/my-work-bench 保持一致
  outlook: {
    clientId: process.env.OUTLOOK_ENTRA_CLIENT_ID || "",
    tenantId: process.env.OUTLOOK_ENTRA_TENANT_ID || "common",
    redirectUri: process.env.OUTLOOK_OAUTH_REDIRECT_URI || `http://127.0.0.1:${FRONTEND_PORT}/api/outlook/oauth/callback`,
    tokenEncryptionKey: process.env.OUTLOOK_TOKEN_ENCRYPTION_KEY || "",
  },

  dingtalk: {
    clientId: process.env.DINGTALK_CLIENT_ID || "",
    clientSecret: process.env.DINGTALK_CLIENT_SECRET || "",
    redirectUri: process.env.DINGTALK_REDIRECT_URI || `http://127.0.0.1:${FRONTEND_PORT}/oauth/dingtalk/callback`,
    managerUserId: process.env.DINGTALK_MANAGER_USER_ID || "",
    reportTemplateId: process.env.DINGTALK_REPORT_TEMPLATE_ID || "",
    agentId: process.env.DINGTALK_AGENT_ID || "",
  },

  aiHot: {
    origin: process.env.AI_HOT_ORIGIN || "https://aihot.virxact.com",
  },

  useDemoData: bool(process.env.USE_DEMO_DATA, true),

  dataDir: path.join(ROOT, ".local"),
};

export function ensureDataDir() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
}

export function configured() {
  return {
    outlook: Boolean(
      config.outlook.clientId &&
        config.outlook.redirectUri &&
        config.outlook.tokenEncryptionKey &&
        config.ai.deepseek.apiKey,
    ),
    dingtalk: Boolean(config.dingtalk.clientId && config.dingtalk.clientSecret),
    ai: Boolean(
      (config.ai.provider === "deepseek" && config.ai.deepseek.apiKey) ||
        (config.ai.provider === "openai" && config.ai.openai.apiKey) ||
        (config.ai.provider === "claude" && config.ai.claude.apiKey) ||
        config.ai.provider === "ollama",
    ),
    aiHot: true,
  };
}
