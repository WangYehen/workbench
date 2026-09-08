import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { config } from "./config.mjs";
import { getDb } from "./db.mjs";
import { seedDemoIfEmpty } from "./demo.mjs";
import { createOutlookService, OutlookServiceError } from "./outlook.mjs";
import { dingtalk } from "./dingtalk.mjs";
import { dingtalkChat } from "./dingtalk-chat.mjs";
import { ai } from "./ai.mjs";
import { createAiScheduler } from "./ai-scheduler.mjs";

import outlookRouter from "./routers/outlook.js";
import team from "./routers/team.js";
import calendar from "./routers/calendar.js";
import todos from "./routers/todos.js";
import review from "./routers/review.js";
import reports from "./routers/reports.js";
import projects from "./routers/projects.js";
import aihot from "./routers/aihot.js";
import systemRouter from "./routers/system.js";
import workbenchRouter from "./routers/workbench.js";
import dingtalkChatRouter from "./routers/dingtalk-chat.js";
import dwsRouter from "./routers/dws.js";
import managementRouter from "./routers/management.js";
import dwsAgentRouter from "./routers/dws-agent.js";
import { createSyncCoordinator } from "./sync-coordinator.mjs";
import { dwsClient } from "./dws-client.mjs";
import { createManagementCases } from "./management-cases.mjs";
import { createDwsAgentService } from "./dws-agent.mjs";
import { createOpenCodeAdapter } from "./opencode-adapter.mjs";
import { createMeetingClosureService } from "./meeting-closure.mjs";
import meetingsRouter from "./routers/meetings.js";
import { setGlobalDispatcher, EnvHttpProxyAgent, ProxyAgent, Agent } from "undici";

// ---------------------------------------------------------------------------
// 出口网络策略
// Node 全局 fetch 默认不读代理环境变量，故用 EnvHttpProxyAgent 让对外请求（Microsoft
// Graph / 外部 AI）走系统代理。钉钉(oapi/api.dingtalk.com)白名单登记的是直连出口 IP，
// 故显式加入 NO_PROXY 走直连，避免经代理换 IP 被拦（errcode 88 / 60020）。
//
// 关键：代理环境变量可能是「陈旧」的——代理软件换端口、关闭，或切到 TUN 透明代理模式后，
// PROXY 端口已无人监听。此时若仍启用 EnvHttpProxyAgent，所有对外请求都会被扔进死代理，
// 表现为 `fetch failed` / ECONNRESET（Outlook 拉取邮件失败的真实根因之一）。
// 因此启动时先 TCP 探测代理端口，不可达则清除代理变量、回退直连（TUN 模式下直连即通）。
// ---------------------------------------------------------------------------
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
// 探测目标必须是「必须走通才算出口可用」的域名。用 Microsoft 登录端点：GET 会返回 200/400
// 这类 HTTP 层响应即证明隧道通；只有网络层失败（抛异常）才算不可用。
const PROBE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const PROBE_TIMEOUT_MS = 4_000;

// 仅做功能性连通探测：TCP 能连上不代表代理能转发（Clash/V2Ray 的规则可能 REJECT 或节点已失效），
// 所以必须真的发一个请求。
async function reachable(dispatcher) {
  try {
    const response = await fetch(PROBE_URL, {
      method: "GET",
      dispatcher,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return Boolean(response.status);
  } catch {
    return false;
  }
}

async function configureOutboundProxy() {
  const raw = PROXY_ENV_KEYS.map((key) => process.env[key]).find(Boolean);
  const clearProxyEnv = () => { for (const key of PROXY_ENV_KEYS) delete process.env[key]; };

  if (!raw) {
    console.log("[net] 未配置 HTTP 代理，对外请求直连。");
    return;
  }

  let proxyUrl;
  try {
    proxyUrl = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    clearProxyEnv();
    console.warn(`[net] 代理地址无法解析（${raw}），已回退直连。`);
    return;
  }

  const label = `${proxyUrl.hostname}:${proxyUrl.port || 80}`;
  if (await reachable(new ProxyAgent(proxyUrl.toString()))) {
    // 钉钉白名单登记的是直连出口 IP，必须绕过代理，否则 errcode 88 / 60020。
    const noProxyExtra = "*.dingtalk.com,oapi.dingtalk.com,api.dingtalk.com";
    process.env.NO_PROXY = [process.env.NO_PROXY, noProxyExtra].filter(Boolean).join(",");
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log(`[net] 对外请求经代理 ${label}（钉钉域名直连）。`);
    return;
  }

  // 代理不可用：死代理比没有代理更糟（会让 Microsoft Graph / 外部 AI 全部请求失败）。
  // 代理软件关闭、换端口，或切到 TUN 透明代理模式时，直连本身即可通。
  if (await reachable(new Agent())) {
    clearProxyEnv();
    console.warn(`[net] 代理 ${label} 不可用，但直连可达，已回退直连。`);
    return;
  }

  clearProxyEnv();
  console.error(`[net] 代理 ${label} 与直连均无法访问 Microsoft，请检查网络或代理软件。`);
}

await configureOutboundProxy();

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "2mb" }));

// 启动器用该接口区分“工作台已就绪”和“8787 被其他程序占用”。
app.get("/api/health", (req, res) => res.json({
  ok: true,
  service: "team-daily-workbench",
  version: config.appVersion,
  runtimeMode: config.runtimeMode,
  instanceId: process.env.WORKBENCH_INSTANCE_ID || "development",
}));

// Outlook / Microsoft Graph（PKCE 公共客户端 + 本地加密状态）
const outlookService = createOutlookService({
  config: {
    clientId: config.outlook.clientId,
    tenantId: config.outlook.tenantId,
    redirectUri: config.outlook.redirectUri,
    tokenEncryptionKey: config.outlook.tokenEncryptionKey,
    modelProvider: ai.label(),
  },
  aiService: ai,
  stateDirectory: path.join(config.dataDir, "outlook"),
});
const aiScheduler = createAiScheduler({ aiService: ai });
const meetingClosureService = createMeetingClosureService({ dwsClient, aiService: ai });
const syncCoordinator = createSyncCoordinator({ outlookService, aiScheduler, dingtalkChatService: dingtalkChat, meetingClosureService, dwsClient });
const managementCases = createManagementCases({ database: getDb });
// Agent 只需要 OpenCode 的推理能力，不需要扫描整个工作台源码；使用本地数据目录作为
// 轻量工作目录，避免每轮启动都索引前端工程导致首字节延迟过长。
const openCode = createOpenCodeAdapter({ enabled: process.env.OPENCODE_ENABLED === "1", executable: config.ai.opencode.path || "opencode", cwd: config.dataDir, model: config.ai.opencode.model, timeoutMs: config.ai.opencode.timeoutMs });
const dwsAgent = createDwsAgentService({ database: getDb, dwsClient, agentRuntime: openCode, dashboard: (date) => managementCases.dashboard(date) });

// 路由
app.use("/api/outlook", outlookRouter(outlookService));
app.use("/api/team", team);
app.use("/api/calendar", calendar);
app.use("/api/todos", todos);
app.use("/api/review", review);
app.use("/api/reports", reports);
app.use("/api/projects", projects);
app.use("/api/ai-hot", aihot);
app.use("/api/dingtalk-chat", dingtalkChatRouter(dingtalkChat));
app.use("/api/dws", dwsRouter(dwsClient));
app.use("/api/meetings", meetingsRouter(meetingClosureService));
app.use("/api/management", managementRouter(managementCases, dwsClient));
app.use("/api/dws-agent", dwsAgentRouter(dwsAgent));
app.use("/api", workbenchRouter(syncCoordinator));
app.use("/api", systemRouter(aiScheduler));

// OAuth 入口：未配置时从系统页点「连接 Outlook」跳到邮件页完成同意+授权流程
app.get("/oauth/outlook", (req, res) => res.redirect(`${config.publicBaseUrl}/emails`));
// Outlook 授权回调（由 Microsoft 回跳，Express 8787 处理），完成后跳回前端邮件页
app.get("/api/outlook/oauth/callback", async (req, res) => {
  try {
    await outlookService.completeOAuth({ code: req.query.code, state: req.query.state, error: req.query.error });
    res.redirect(`${config.publicBaseUrl}/emails?connected=1`);
  } catch (e) {
    res.status(500).send(`Outlook 授权失败：${e?.message || e}`);
  }
});
app.get("/oauth/dingtalk", (req, res) => res.redirect(dingtalk.getAuthUrl()));
app.get("/oauth/dingtalk/callback", async (req, res) => {
  try {
    await dingtalk.handleCallback(req.query.code);
    res.redirect(`${config.publicBaseUrl}/team?synced=dingtalk`);
  } catch (e) {
    res.status(500).send(`钉钉授权失败：${e.message}`);
  }
});

// 生产：托管前端构建产物
const distClient = path.join(config.root, "dist/client");
if (config.isProd && fs.existsSync(distClient)) {
  app.use(express.static(distClient));
  app.get("*", (req, res) => res.sendFile(path.join(distClient, "index.html")));
}

// 初始化
getDb();
if (config.useDemoData) seedDemoIfEmpty();

const server = app.listen(config.port, config.host, () => {
  console.log(`[team-workbench] API listening on http://${config.host}:${config.port}`);
  void ai.status().catch(() => {});
  void dingtalkChat.status({ probeCapabilities: false }).catch(() => {});
  aiScheduler.start();
  syncCoordinator.start();
});
server.on("error", async (error) => {
  console.error(`[team-workbench] server failed: ${error?.message || error}`);
  syncCoordinator.close();
  aiScheduler.close();
  await outlookService.close().catch(() => {});
  process.exit(1);
});


// 优雅退出：停掉 Outlook 自动同步定时器
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    syncCoordinator.close();
    aiScheduler.close();
    outlookService.close().finally(() => server.close(() => process.exit(0)));
  });
}
