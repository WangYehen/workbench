import { config } from "./config.mjs";
import { getDb, upsert } from "./db.mjs";
import { localDateString } from "./local-date.mjs";

const NEW_API = "https://api.dingtalk.com";
const OAPI = "https://oapi.dingtalk.com";
export const DINGTALK_IP_NOT_WHITELISTED = "DINGTALK_IP_NOT_WHITELISTED";

const WHITE_LIST_CODES = new Set(["88", "60020", "Forbidden.AccessDenied.IpNotInWhiteList"]);

export function classifyDingtalkFailure({ code, message = "", httpStatus = null } = {}) {
  const normalizedCode = code == null ? "" : String(code);
  const text = String(message || "");
  const blocked = WHITE_LIST_CODES.has(normalizedCode) || /(?:ip.*(?:白名单|white\s*list)|(?:白名单|white\s*list).*ip)/i.test(text);
  const egressIp = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] || null;
  return {
    code: blocked ? DINGTALK_IP_NOT_WHITELISTED : (normalizedCode || (httpStatus ? `DINGTALK_HTTP_${httpStatus}` : "DINGTALK_API_ERROR")),
    blocked,
    retryable: !blocked,
    egressIp,
  };
}

function dingtalkError(context, { code, message, httpStatus }) {
  const details = classifyDingtalkFailure({ code, message, httpStatus });
  const suffix = [code != null ? `错误 ${code}` : null, message].filter(Boolean).join("：");
  const error = new Error(details.blocked
    ? `钉钉拒绝了当前出口 IP，请在开放平台白名单中添加后手动重新同步${details.egressIp ? `（${details.egressIp}）` : ""}`
    : `钉钉 ${context} 失败${suffix ? `：${suffix}` : ""}`);
  Object.assign(error, details, { source: "dingtalk", httpStatus });
  return error;
}

async function dingtalkJson(response, context) {
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch {
    throw dingtalkError(context, { message: text.slice(0, 240) || `HTTP ${response.status}`, httpStatus: response.status });
  }
  const apiCode = data?.errcode ?? data?.code;
  const apiMessage = data?.errmsg || data?.message || data?.errorMessage || "";
  const successCode = apiCode == null || ["0", "OK", "Success"].includes(String(apiCode));
  if (!response.ok || !successCode || data?.success === false) {
    throw dingtalkError(context, { code: apiCode, message: apiMessage || text.slice(0, 240), httpStatus: response.status });
  }
  return data;
}

function kv(key) {
  const db = getDb();
  const row = db.prepare("SELECT value_json FROM sync_state WHERE key=?").get(key);
  return row ? JSON.parse(row.value_json) : null;
}
function setKv(key, obj) {
  const db = getDb();
  db.prepare(
    "INSERT INTO sync_state(key, value_json) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
  ).run(key, JSON.stringify(obj));
}

function dayMs(dateStr) {
  const d = new Date(`${dateStr}T00:00:00+08:00`);
  return d.getTime();
}

// 钉钉返回的多种时间形态统一转成 epoch 毫秒。
// 支持：ISO 字符串、纯数字时间戳（秒/毫秒自动判别）、{ dateTime }、{ time }、{ date }。
function toEpochMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) { const n = Number(v); return n < 1e12 ? n * 1000 : n; }
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === "object") {
    if (v.dateTime) return Date.parse(v.dateTime);
    if (v.time) return v.time < 1e12 ? v.time * 1000 : v.time;
    if (v.date) return Date.parse(`${v.date}T00:00:00`);
  }
  return null;
}

function attendeeStatusAccepted(attendee) {
  const status = String(
    attendee?.responseStatus || attendee?.response_status || attendee?.status || attendee?.rsvpStatus || "",
  ).toLowerCase();
  return ["accepted", "accept", "yes", "attending", "confirmed", "参加", "已接受", "1"].includes(status);
}

function normalizeAttendees(e) {
  const raw = e.attendees || e.attendee || e.participants || e.invitees || [];
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : []);
  const totalValue = e.attendeeCount ?? e.attendee_count ?? e.participantCount ?? e.inviteeCount;
  const acceptedValue = e.acceptedCount ?? e.accepted_count ?? e.acceptCount;
  const total = Number.isFinite(Number(totalValue)) ? Number(totalValue) : (list.length || null);
  const accepted = Number.isFinite(Number(acceptedValue))
    ? Number(acceptedValue)
    : (list.length ? list.filter(attendeeStatusAccepted).length : null);
  return { total, accepted };
}

export const dingtalk = {
  isConfigured() {
    return Boolean(config.dingtalk.clientId && config.dingtalk.clientSecret);
  },

  // 拉取钉钉日程除 appKey/secret 外，还需主管的 userid（staffId）以圈定其主日历。
  // 仅当三者齐备才尝试真实同步，避免无 managerUserId 时每次请求都白打一遍钉钉。
  calendarReady() {
    return Boolean(
      config.dingtalk.clientId &&
        config.dingtalk.clientSecret &&
        config.dingtalk.managerUserId,
    );
  },

  getAuthUrl() {
    const params = new URLSearchParams({
      client_id: config.dingtalk.clientId,
      response_type: "code",
      scope: "openid",
      redirect_uri: config.dingtalk.redirectUri,
      state: "team-workbench",
    });
    return `https://login.dingtalk.com/oauth2/auth?${params.toString()}`;
  },

  async handleCallback(code) {
    const res = await fetch(`${NEW_API}/v1.0/oauth2/userAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: config.dingtalk.clientId,
        clientSecret: config.dingtalk.clientSecret,
        code,
      }),
    });
    const data = await dingtalkJson(res, "userToken");
    setKv("dt_user_token", { ...data, obtained_at: Date.now() });
    return data;
  },

  async getAppToken() {
    const t = kv("dt_app_token");
    if (t && Date.now() < t.obtained_at + (t.expireIn || 7200) * 1000 - 60000) return t.accessToken;
    const res = await fetch(`${NEW_API}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appKey: config.dingtalk.clientId,
        appSecret: config.dingtalk.clientSecret,
      }),
    });
    const data = await dingtalkJson(res, "appToken");
    setKv("dt_app_token", { accessToken: data.accessToken, expireIn: data.expireIn, obtained_at: Date.now() });
    return data.accessToken;
  },

  // 注意：官方 topapi/report/list（文档名 dingtalk.oapi.report.list）按模板过滤的字段是
  // **template_name**（模板名），不是 template_id。之前传 template_id 被服务端静默忽略，返回当天全量，
  // 是“过滤不生效”的根因。实测传 template_name 后服务端精确按模板返回。
  async fetchReports(dateStr, templateName) {
    const token = await this.getAppToken();
    const start = dayMs(dateStr);
    const end = start + 24 * 3600 * 1000;
    // 本应用使用企业内部应用 appToken，可直接读取组织内日志（无需按主管 userid 过滤；
    // 若传入 userid 反而会把非其下属提交人的日志全部滤掉，导致拉不到数据）。
    // templateName 作为可选模板过滤（仅拉该模板的日志），直接透传给服务端。
    // 注意翻页：topapi/report/list 单页最多 size 条，has_more=true 时需用 next_cursor 继续拉，
    // 否则高流量模板（如部门日报）会丢数据。
    const reports = [];
    let cursor = 0;
    for (;;) {
      const body = { start_time: start, end_time: end, cursor, size: 20 };
      if (templateName) body.template_name = templateName;
      const res = await fetch(`${OAPI}/topapi/report/list?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await dingtalkJson(res, "report");
      const page = this.normalizeReports(data);
      reports.push(...page);
      if (!data?.result?.has_more || !page.length) break;
      cursor = data?.result?.next_cursor ?? 0;
    }
    return reports;
  },

  normalizeReports(data) {
    // 钉钉 topapi/report/list 的真实数据字段是 result.data_list（不是 result.data）
    const list = data?.result?.data_list || data?.result?.data || [];
    return list.map((r) => {
      // 保留原始 contents 结构：[{sort, type, value, key}]，前端按 key 分区展示
      const rawContents = r.contents || [];
      const contents = rawContents.map((c) => ({
        sort: String(c.sort || ""),
        type: String(c.type || "1"),
        key: c.key || c.label || "",
        value: c.value || "",
      }));
      // 兼容旧 content_text：扁平化为可读字符串
      const contentText = rawContents.map((c) => `${c.key || c.label || ""}：${c.value || ""}`).join("\n");
      return {
        id: String(r.report_id || r.template_id || Math.random()),
        template_id: String(r.template_id || ""),
        user_id: String(r.creator?.userid || r.userid || ""),
        user_name: r.creator?.nick || r.creator_name || "",
        dept_name: r.dept_name || "",
        report_date: (r.create_time ? new Date(Number(r.create_time)) : new Date()).toISOString().slice(0, 10),
        template_name: r.template_name || "",
        content_json: JSON.stringify(contents),
        content_text: contentText,
      };
    });
  },

  // 钉钉员工 staffId → unionId（新版日历 REST API 以 unionId 作为路径参数）。
  // unionId 相对稳定，做进程内缓存避免重复调用。
  async getUnionId(staffId) {
    if (!staffId) throw new Error("未配置 DINGTALK_MANAGER_USER_ID，无法拉取钉钉日程");
    this._unionCache = this._unionCache || {};
    if (this._unionCache[staffId]) return this._unionCache[staffId];
    const token = await this.getAppToken();
    const res = await fetch(`${OAPI}/topapi/v2/user/get?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userid: staffId }),
    });
    const data = await dingtalkJson(res, "user/get");
    const unionId = data?.result?.unionid || data?.result?.userid || staffId;
    this._unionCache[staffId] = unionId;
    return unionId;
  },

  // 拉取指定时间范围内的钉钉日程（新版 REST API：api.dingtalk.com/v1.0/calendar/...）。
  // 接口文档：开放平台「查询日程列表」
  //   https://open.dingtalk.com/document/development/query-an-event-list
  // 请求：GET /v1.0/calendar/users/{unionId}/calendars/primary/events
  //   Header: x-acs-dingtalk-access-token = 企业内部应用 accessToken
  //   Query : timeMin/timeMax（ISO-8601 date-time，差值≤1年），maxResults(≤100)，nextToken 翻页
  // 响应：events[]，每项含 id / summary / start{dateTime|date|time} / end / location / organizer
  async fetchCalendarRange(startMs, endMs) {
    const staffId = config.dingtalk.managerUserId;
    const token = await this.getAppToken();
    const unionId = await this.getUnionId(staffId);
    const events = [];
    let nextToken = null;
    for (let page = 0; page < 20; page++) {
      const url = new URL(`${NEW_API}/v1.0/calendar/users/${encodeURIComponent(unionId)}/calendars/primary/events`);
      url.searchParams.set("timeMin", new Date(startMs).toISOString());
      url.searchParams.set("timeMax", new Date(endMs).toISOString());
      url.searchParams.set("maxResults", "100");
      if (nextToken) url.searchParams.set("nextToken", nextToken);
      const res = await fetch(url, { method: "GET", headers: { "x-acs-dingtalk-access-token": token } });
      const data = await dingtalkJson(res, "日程");
      const items = data?.events || data?.result?.events || [];
      for (const e of items) events.push(this.normalizeCalendarEvent(e));
      nextToken = data?.nextToken || data?.result?.nextToken || null;
      if (!nextToken || !items.length) break;
    }
    return events;
  },

  normalizeCalendarEvent(e) {
    const startMs = toEpochMs(e.start);
    const endMs = toEpochMs(e.end);
    const start = startMs ? new Date(startMs) : null;
    const day = start ? localDateString(start) : "";
    let organizer = "";
    if (e.organizer) {
      organizer = typeof e.organizer === "string"
        ? e.organizer
        : (e.organizer.displayName || e.organizer.name || e.organizer.display_name || e.organizer.unionId || "");
    }
    // 钉钉日程的 location 可能是对象 { displayName } 或字符串，统一收敛成字符串，
    // 否则对象作为 better-sqlite3 的 ? 参数会被当成命名参数而抛 "Too few parameter values"。
    let location = "";
    if (e.location) {
      location = typeof e.location === "string"
        ? e.location
        : (e.location.displayName || e.location.name || e.location.address || e.location.locationName || e.location.placeName || e.location.place || "");
    }
    if (!location) location = e.meetingRoom || e.roomName || e.venue || "";
    if (!location && Array.isArray(e.meetingRooms)) {
      const room = e.meetingRooms.find(Boolean);
      location = typeof room === "string"
        ? room
        : (room?.displayName || room?.name || room?.roomName || room?.locationName || "");
    }
    if (!location && Array.isArray(e.conferences) && e.conferences[0]?.uri) {
      location = e.conferences[0].uri;
    }
    const attendees = normalizeAttendees(e);
    return {
      id: String(e.id || e.event_id || Math.random()),
      source: "dingtalk",
      title: e.summary || e.title || "(日程)",
      start_at: start ? start.toISOString() : new Date().toISOString(),
      end_at: endMs ? new Date(endMs).toISOString() : null,
      location,
      organizer,
      attendee_count: attendees.total,
      accepted_count: attendees.accepted,
      day,
      raw: e,
    };
  },

  // 把某日期区间的钉钉日程写入 calendars 表（按 id 幂等 upsert，前缀 dt_ 区分来源）。
  // 返回新写入/更新的条数。
  async syncCalendarForRange(startDateStr, endDateStr) {
    const startMs = dayMs(startDateStr);
    const endMs = dayMs(endDateStr) + 24 * 3600 * 1000;
    const events = await this.fetchCalendarRange(startMs, endMs);
    // 记录最近一次成功同步时间（无论当天有无日程，拉取动作已完成）
    setKv("calendar_last_sync_at", { at: new Date().toISOString() });
    if (!events.length) return 0;
    const now = new Date().toISOString();
    const rows = events.map((e) => ({
      id: `dt_${e.id}`,
      source: "dingtalk",
      title: e.title,
      start_at: e.start_at,
      end_at: e.end_at,
      location: e.location,
      organizer: e.organizer,
      attendee_count: e.attendee_count,
      accepted_count: e.accepted_count,
      day: e.day,
      raw_json: JSON.stringify(e.raw),
      created_at: now,
    }));
    upsert("calendars", rows, ["id"]);
    return rows.length;
  },

  async fetchMembers() {
    const token = await this.getAppToken();
    const res = await fetch(`${OAPI}/topapi/user/list?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dept_id: 1, cursor: 0, size: 100 }),
    });
    const data = await dingtalkJson(res, "members");
    const users = data?.result?.list || [];
    return users.map((u) => ({
      user_id: String(u.userid),
      name: u.name,
      dept_id: String(u.dept_id || ""),
      dept_name: u.dept_name || "",
      is_manager: u.isLeader || u.isBoss ? 1 : 0,
      updated_at: new Date().toISOString(),
    }));
  },

  async syncMembers() {
    const members = await this.fetchMembers();
    if (!members.length) return [];
    upsert(
      "dingtalk_members",
      members.map((member) => ({ ...member, active: 1 })),
      ["user_id"],
    );
    return members;
  },

  async syncReports(dateStr) {
    // 手动维护的日志模板：只拉取「启用」的模板（按 name 服务端过滤），
    // 不再调用钉钉模板列表接口、不回退 .env、不拉全量；无启用模板时直接跳过。
    const db = getDb();
    const rows = db.prepare("SELECT name FROM report_templates WHERE enabled=1 ORDER BY id").all();
    let reports = [];
    if (rows.length) {
      const seen = new Set();
      for (const row of rows) {
        const name = String(row.name || "").trim();
        if (!name) continue;
        const part = await this.fetchReports(dateStr, name);
        for (const r of part) {
          if (seen.has(r.id)) continue; // 跨模板去重
          // 安全网：若服务端偶发未按 template_name 过滤，丢弃非目标模板，避免污染
          if (r.template_name && r.template_name !== name) continue;
          seen.add(r.id);
          reports.push(r);
        }
      }
    }
    const now = new Date().toISOString();
    upsert(
      "dingtalk_reports",
      reports.map((r) => ({
        id: r.id,
        user_id: r.user_id,
        user_name: r.user_name,
        dept_name: r.dept_name || "",
        report_date: r.report_date,
        template_name: r.template_name,
        content_json: r.content_json || JSON.stringify(r.content_text || ""),
        blockers: "",
        needs_review: "",
        summary: "",
        created_at: now,
      })),
      ["id"],
    );
    // AI 分析：用 user_id / user_name 双键匹配，并把雷同或空的小结回退为真实内容的确定性摘要
    const deriveSummary = (raw) => {
      if (!raw) return "";
      let text = raw;
      try {
        const p = JSON.parse(raw);
        if (typeof p === "string") text = p;
        else if (Array.isArray(p)) {
          // 新格式：[{sort, type, key, value}] 或 旧格式：[{label, value}]
          text = p.map((it) => {
            const label = it?.key || it?.label || "";
            const val = it?.value ?? it?.content ?? "";
            return label ? `${label}：${val}` : val;
          }).map((line) => String(line || "").trim()).filter(Boolean).join("\n");
        }
      } catch { /* 非 JSON */ }
      const lines = text.replace(/\r/g, "").split("\n")
        .map((l) => l.replace(/^[:：]\s?/, "").trim())
        .filter((l) => l.length > 0 && l !== "[]" && l !== "【】");
      return lines.slice(0, 2).map((l) => l.replace(/[;；]\s*$/, "")).join("；");
    };
    // 同步主链路只保留按人可读的确定性摘要。AI 团队分析由 ai-scheduler
    // 在协调器确认同步成功后后台入队，慢模型和失败都不会阻塞本次同步。
    if (reports.length) {
      const db = getDb();
      const update = db.prepare("UPDATE dingtalk_reports SET blockers=?, needs_review=?, summary=? WHERE id=?");
      for (const report of reports) update.run("[]", "[]", deriveSummary(report.content_json), report.id);
    }
    // 记录最近一次成功同步时间（手动同步与定时同步共用）
    setKv("reports_last_sync_at", { at: new Date().toISOString() });
    return reports;
  },
};
