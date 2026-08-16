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

export const dingtalk = {
  isConfigured() {
    return Boolean(config.dingtalk.clientId && config.dingtalk.clientSecret);
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
      else if (config.dingtalk.reportTemplateId) body.template_name = config.dingtalk.reportTemplateId;
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

  // 拉取企业内所有日志模板（供页面勾选配置要拉取哪些）
  // 接口：topapi/report/template/listbyuserid（注意不是 list）；返回 template_list，模板唯一标识为 report_code
  async fetchReportTemplates() {
    const token = await this.getAppToken();
    const body = { offset: 0, size: 100 };
    const res = await fetch(`${OAPI}/topapi/report/template/listbyuserid?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`钉钉 template HTTP ${res.status}`);
    const data = await res.json();
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`钉钉 template API errcode ${data.errcode}：${data.errmsg || ""}`);
    }
    const list = data?.result?.template_list || [];
    return list.map((t) => ({
      template_id: String(t.report_code || t.template_id || ""),
      template_name: t.name || t.template_name || "",
    }));
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

  async fetchCalendar(dateStr) {
    const token = await this.getAppToken();
    const start = Math.floor(dayMs(dateStr) / 1000);
    const end = start + 24 * 3600;
    const res = await fetch(`${OAPI}/topapi/calendar/list?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calendar_id: "primary", start_time: start, end_time: end, max_results: 50 }),
    });
    if (!res.ok) throw new Error(`钉钉 calendar HTTP ${res.status}`);
    const data = await res.json();
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`钉钉 calendar API errcode ${data.errcode}：${data.errmsg || ""}`);
    }
    const events = data?.events || data?.result?.events || [];
    return events.map((e) => ({
      id: String(e.id || Math.random()),
      source: "dingtalk",
      title: e.summary || e.title || "(日程)",
      start_at: new Date((e.start?.time || e.start_time || e.dtstart || 0) * 1000).toISOString(),
      end_at: e.end?.time ? new Date(e.end.time * 1000).toISOString() : null,
      location: e.location || "",
      organizer: e.organizer || e.creator || "",
      day: dateStr,
    }));
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
    // 读取页面配置的要拉取的模板 ID 列表（存于 sync_state）
    const selRow = kv("selected_template_ids");
    const selected = Array.isArray(selRow) ? selRow : [];
    let reports = [];
    if (selected.length) {
      // 按所选模板逐个用官方 template_name 服务端过滤拉取（文档标准用法），再按 report_id 去重合并。
      // 先取 report_code -> template_name 映射（fetchReportTemplates 返回的 template_id 实为 report_code）。
      let nameByCode = {};
      try {
        const tpls = await this.fetchReportTemplates();
        nameByCode = Object.fromEntries((tpls || []).map((t) => [t.template_id, t.template_name]));
        // 直接用官方模板列表刷新 known_templates（结构干净、不再手工累积，避免 template_name 被套成嵌套数组）
        setKv("known_templates", (tpls || []).map((t) => ({ template_id: String(t.template_id || ""), template_name: String(t.template_name || "") })));
      } catch {
        /* 模板名解析失败则不刷新 known_templates，也不拉全量，避免污染 */
      }
      const seen = new Set();
      for (const code of selected) {
        const name = nameByCode[code];
        if (!name) continue; // 名称解析不到就不拉，避免传空 template_name 拉回全量
        const part = await this.fetchReports(dateStr, name);
        for (const r of part) {
          if (seen.has(r.id)) continue; // 跨模板去重
          // 安全网：若服务端偶发未按 template_name 过滤，丢弃非目标模板，避免污染
          if (r.template_name && r.template_name !== name) continue;
          seen.add(r.id);
          reports.push(r);
        }
      }
    } else if (config.dingtalk.reportTemplateId) {
      reports = await this.fetchReports(dateStr, config.dingtalk.reportTemplateId);
    } else {
      reports = await this.fetchReports(dateStr);
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
