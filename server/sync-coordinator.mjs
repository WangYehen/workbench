import { getDb } from "./db.mjs";
import { dingtalk } from "./dingtalk.mjs";
import { localDateString } from "./local-date.mjs";
import { mirrorToEmails } from "./routers/outlook.js";

export const SYNC_POLICIES = {
  outlook: { label: "Outlook 邮件", intervalMinutes: 15, scope: "增量同步收件箱，并更新行动中心" },
  dingtalk: { label: "钉钉团队日志", intervalMinutes: 15, scope: "同步当天启用模板的日志" },
  calendar: { label: "钉钉日程", intervalMinutes: 15, scope: "同步今天起 30 天的主管主日历" },
  dingtalk_chat: { label: "钉钉个人消息", intervalMinutes: 15, scope: "同步私聊及启用群的 @我 消息" },
  dingtalk_minutes: { label: "钉钉 AI 听记", intervalMinutes: 15, scope: "同步近 7 天可访问听记的摘要与行动项" },
};

function readState(db, key) {
  const row = db.prepare("SELECT value_json FROM sync_state WHERE key=?").get(key);
  try { return row ? JSON.parse(row.value_json) : null; } catch { return null; }
}

function writeState(db, key, value) {
  db.prepare("INSERT INTO sync_state(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json")
    .run(key, JSON.stringify(value));
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00+08:00`);
  value.setUTCDate(value.getUTCDate() + days);
  return localDateString(value);
}

export function createSyncCoordinator({ outlookService, aiScheduler = null, now = () => new Date(), database = getDb, dingtalkService = dingtalk, dingtalkChatService = null, meetingClosureService = null, dwsClient = null, mirrorEmails = mirrorToEmails }) {
  const running = new Set();
  const readinessCache = new Map();
  let timer = null;

  async function readiness(source, { force = false } = {}) {
    if (source === "outlook") {
      const status = await outlookService.status();
      return { configured: Boolean(status.configured), ready: Boolean(status.configured && status.consented && status.connected), reason: !status.configured ? "未配置" : !status.consented ? "待确认隐私授权" : !status.connected ? "待连接" : null };
    }
    if (source === "calendar") return { configured: dingtalkService.isConfigured(), ready: dingtalkService.calendarReady(), reason: !dingtalkService.isConfigured() ? "未配置" : !dingtalkService.calendarReady() ? "缺少主管用户 ID" : null };
    if (source === "dingtalk_chat") {
      const chat = dingtalkChatService ? await dingtalkChatService.status({ probeCapabilities: false, force }) : { installed: false, connected: false };
      return { configured: Boolean(chat.installed), ready: Boolean(chat.installed && chat.connected), reason: !chat.installed ? "未安装 DWS" : !chat.connected ? "待连接个人钉钉" : null };
    }
    if (source === "dingtalk_minutes") {
      const status = dwsClient ? await dwsClient.status({ force }) : { installed: false, connected: false };
      return { configured: Boolean(status.installed), ready: Boolean(status.installed && status.connected), reason: !status.installed ? "未安装 DWS" : !status.connected ? "待连接钉钉" : null };
    }
    return { configured: dingtalkService.isConfigured(), ready: dingtalkService.isConfigured(), reason: dingtalkService.isConfigured() ? null : "未配置" };
  }

  function statusItem(source, ready) {
    const db = database();
    const policy = SYNC_POLICIES[source];
    const state = readState(db, `sync_status_${source}`) || {};
    const base = state.lastAttemptAt || state.lastSuccessAt;
    return {
      source, ...policy, automatic: true, ...ready,
      status: running.has(source) ? "running" : state.status || (ready.ready ? "never" : "waiting"),
      trigger: state.trigger || null, lastAttemptAt: state.lastAttemptAt || null, lastSuccessAt: state.lastSuccessAt || null,
      nextRunAt: state.blocked ? null : ready.ready && base ? new Date(Date.parse(base) + policy.intervalMinutes * 60000).toISOString() : ready.ready ? "on-startup" : null,
      recordCount: state.recordCount ?? null, error: state.error || ready.reason || null, errorCode: state.errorCode || null,
      blocked: Boolean(state.blocked), retryable: state.retryable !== false, usingCachedData: Boolean(state.usingCachedData),
      egressIp: state.egressIp || null, warning: state.warning || null,
      checkedAt: ready.checkedAt || null, checking: Boolean(ready.checking), stale: Boolean(ready.stale),
    };
  }

  async function status() {
    const entries = await Promise.all(Object.keys(SYNC_POLICIES).map(async (source) => {
      const ready = await readiness(source);
      const cached = { ...ready, checkedAt: now().toISOString(), checking: false, stale: false };
      readinessCache.set(source, cached);
      return statusItem(source, cached);
    }));
    return entries;
  }

  function statusSnapshot() {
    return Object.keys(SYNC_POLICIES).map((source) => {
      const ready = readinessCache.get(source) || { configured: null, ready: false, reason: "状态检查中", checking: true, stale: false, checkedAt: null };
      return statusItem(source, ready);
    });
  }

  async function runSource(source, { date = localDateString(now()), trigger = "manual", dingtalkChatDays, dingtalkChatBackfill = false } = {}) {
    if (!SYNC_POLICIES[source]) throw new Error(`不支持的数据源：${source}`);
    if (running.has(source)) return { source, status: "running", trigger };
    const ready = await readiness(source, { force: true });
    readinessCache.set(source, { ...ready, checkedAt: now().toISOString(), checking: false, stale: false });
    if (!ready.ready) throw new Error(`${SYNC_POLICIES[source].label}${ready.reason || "尚未就绪"}`);
    const db = database();
    const attemptedAt = now().toISOString();
    running.add(source);
    writeState(db, `sync_status_${source}`, { status: "running", trigger, lastAttemptAt: attemptedAt, lastSuccessAt: readState(db, `sync_status_${source}`)?.lastSuccessAt || null, recordCount: 0, error: null });
    try {
      let recordCount = 0;
      if (source === "outlook") {
        const result = await outlookService.sync();
        await mirrorEmails(outlookService);
        recordCount = result?.classified ?? result?.inspected ?? 0;
      } else if (source === "dingtalk") {
        let warning = null;
        try { await dingtalkService.syncMembers(); } catch (error) { warning = `团队名册刷新失败，已保留本地名册：${error.message}`; }
        recordCount = (await dingtalkService.syncReports(date)).length;
        if (warning) writeState(db, "sync_warning_dingtalk", { warning, at: now().toISOString() });
      } else if (source === "dingtalk_chat") {
        const result = await dingtalkChatService.sync({ days: dingtalkChatDays, forceBackfill: dingtalkChatBackfill });
        recordCount = result.count;
      } else if (source === "dingtalk_minutes") {
        if (!meetingClosureService) throw new Error("会议闭环连接器未启用");
        recordCount = (await meetingClosureService.syncRecent()).count;
      } else {
        recordCount = await dingtalkService.syncCalendarForRange(date, addDays(date, 30));
      }
      const warningState = source === "dingtalk" ? readState(db, "sync_warning_dingtalk") : null;
      const state = { status: "success", trigger, lastAttemptAt: attemptedAt, lastSuccessAt: now().toISOString(), recordCount: Number(recordCount) || 0, error: null, errorCode: null, blocked: false, retryable: true, usingCachedData: false, egressIp: null, warning: warningState?.warning || null };
      writeState(db, `sync_status_${source}`, state);
      // AI 仅后台入队，不能拖慢外部数据同步的完成响应。
      aiScheduler?.dashboardArtifact(date, { trigger: `sync:${source}` });
      if (source === "dingtalk") aiScheduler?.teamAnalysisArtifact(date, { trigger: "sync:dingtalk" });
      return { source, ...state };
    } catch (error) {
      const previous = readState(db, `sync_status_${source}`) || {};
      const blocked = Boolean(error?.blocked);
      const state = {
        status: "error",
        trigger,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: previous.lastSuccessAt || null,
        recordCount: 0,
        error: error.message,
        errorCode: error?.code || null,
        blocked,
        retryable: error?.retryable !== false,
        usingCachedData: Boolean(previous.lastSuccessAt),
        egressIp: error?.egressIp || null,
      };
      writeState(db, `sync_status_${source}`, state);
      throw Object.assign(error, { syncResult: { source, ...state } });
    } finally { running.delete(source); }
  }

  async function run(sources, options = {}) {
    const results = await Promise.allSettled(sources.map((source) => runSource(source, options)));
    return results.map((result, index) => result.status === "fulfilled" ? result.value : result.reason?.syncResult || { source: sources[index], status: "error", trigger: options.trigger || "manual", error: result.reason?.message || "同步失败" });
  }

  async function tick() {
    const current = await status();
    const due = current.filter((item) => item.ready && !running.has(item.source) && (item.nextRunAt === "on-startup" || Date.parse(item.nextRunAt) <= now().getTime())).map((item) => item.source);
    if (due.length) await run(due, { date: localDateString(now()), trigger: "automatic" });
  }

  return {
    status,
    statusSnapshot,
    run,
    start() {
      if (timer) return;
      console.log("[sync] 自动同步已启动：邮件、团队日志、钉钉日程每 15 分钟检查一次");
      timer = setInterval(() => void tick(), 60000);
      void tick();
    },
    close() { if (timer) clearInterval(timer); timer = null; },
  };
}
