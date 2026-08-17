import { config } from "./config.mjs";
import { getDb, upsert } from "./db.mjs";
import { ai } from "./ai.mjs";

const NEW_API = "https://api.dingtalk.com";
const OAPI = "https://oapi.dingtalk.com";

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

function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
    if (!res.ok) throw new Error(`钉钉 userToken HTTP ${res.status}`);
    const data = await res.json();
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
    if (!res.ok) throw new Error(`钉钉 appToken HTTP ${res.status}`);
    const data = await res.json();
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
      if (!res.ok) throw new Error(`钉钉 report HTTP ${res.status}`);
      const data = await res.json();
      if (data.errcode && data.errcode !== 0) {
        throw new Error(`钉钉 report API errcode ${data.errcode}：${data.errmsg || ""}`);
      }
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
      const contents = (r.contents || []).map((c) => `${c.label || ""}：${c.value || ""}`).join("\n");
      return {
        id: String(r.report_id || r.template_id || Math.random()),
        template_id: String(r.template_id || ""),
        user_id: String(r.creator?.userid || r.userid || ""),
        user_name: r.creator?.nick || r.creator_name || "",
        report_date: (r.create_time ? new Date(Number(r.create_time)) : new Date()).toISOString().slice(0, 10),
        template_name: r.template_name || "",
        content_json: JSON.stringify(contents),
        content_text: contents,
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
    if (!res.ok) throw new Error(`钉钉 user/get HTTP ${res.status}`);
    const data = await res.json();
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`钉钉 user/get errcode ${data.errcode}：${data.errmsg || ""}`);
    }
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
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`钉钉日程 HTTP ${res.status}：${txt.slice(0, 240)}`);
      }
      const data = await res.json();
      if (data?.code && String(data.code) !== "0") {
        throw new Error(`钉钉日程 API 错误 ${data.code}：${data.message || ""}`);
      }
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
    const day = start ? ymdLocal(start) : "";
    let organizer = "";
    if (e.organizer) {
      organizer = typeof e.organizer === "string"
        ? e.organizer
        : (e.organizer.name || e.organizer.display_name || e.organizer.unionId || "");
    }
    const location = e.location || (Array.isArray(e.conferences) && e.conferences[0]?.uri) || "";
    return {
      id: String(e.id || e.event_id || Math.random()),
      source: "dingtalk",
      title: e.summary || e.title || "(日程)",
      start_at: start ? start.toISOString() : new Date().toISOString(),
      end_at: endMs ? new Date(endMs).toISOString() : null,
      location,
      organizer,
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
    if (!res.ok) throw new Error(`钉钉 members HTTP ${res.status}`);
    const data = await res.json();
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`钉钉 members API errcode ${data.errcode}：${data.errmsg || ""}`);
    }
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
        else if (Array.isArray(p)) text = p.map((it) => `${it && it.label ? it.label + "：" : ""}${it && (it.value ?? it.content ?? "")}`.trim()).filter(Boolean).join("\n");
      } catch { /* 非 JSON */ }
      const lines = text.replace(/\r/g, "").split("\n")
        .map((l) => l.replace(/^[:：]\s?/, "").trim())
        .filter((l) => l.length > 0 && l !== "[]" && l !== "【】");
      return lines.slice(0, 2).map((l) => l.replace(/[;；]\s*$/, "")).join("；");
    };
    if (ai.available() && reports.length) {
      try {
        const analysis = await ai.analyzeReports(reports);
        const byUser = new Map();
        const byName = new Map();
        for (const m of analysis.members || []) {
          if (m.userId) byUser.set(String(m.userId), m);
          if (m.name) byName.set(m.name, m);
        }
        const used = new Set();
        const db = getDb();
        for (const r of reports) {
          const a = byUser.get(String(r.user_id)) || byName.get(r.user_name);
          let summary = a && a.summary ? a.summary : "";
          // 防止 AI 退化导致多人小结雷同：雷同或为空时回退到真实内容的确定性摘要
          if (!summary || used.has(summary)) summary = deriveSummary(r.content_json);
          used.add(summary);
          db.prepare("UPDATE dingtalk_reports SET blockers=?, needs_review=?, summary=? WHERE id=?")
            .run(JSON.stringify(a?.blockers || []), JSON.stringify(a?.reviewItems || []), summary, r.id);
        }
      } catch {
        // AI 不可用时统一用确定性小结兜底（仍保证按人区分）
        const db = getDb();
        const upd = db.prepare("UPDATE dingtalk_reports SET summary=? WHERE id=?");
        for (const r of reports) upd.run(deriveSummary(r.content_json), r.id);
      }
    }
    return reports;
  },
};
