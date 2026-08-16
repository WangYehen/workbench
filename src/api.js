const BASE = "/api";

async function request(url, options = {}) {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let msg = `请求失败 ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  get: (url) => request(url),
  post: (url, body) => request(url, { method: "POST", body: JSON.stringify(body || {}) }),
  put: (url, body) => request(url, { method: "PUT", body: JSON.stringify(body || {}) }),
  patch: (url, body) => request(url, { method: "PATCH", body: JSON.stringify(body || {}) }),
  del: (url) => request(url, { method: "DELETE" }),
};

// Outlook / Microsoft Graph（与 GitHub 仓库 WangYehen/my-work-bench 的接口一致）
export const outlookApi = {
  status: () => api.get("/outlook/status"),
  consent: () => api.post("/outlook/consent", { accepted: true }),
  start: () => api.post("/outlook/oauth/start", {}),
  // 设备码授权：浏览器无法打开 Microsoft 登录页或无法回跳 127.0.0.1 时的替代通道
  deviceStart: () => api.post("/outlook/oauth/device/start", {}),
  devicePoll: (handle) => api.post("/outlook/oauth/device/poll", { handle }),
  sync: () => api.post("/outlook/sync", {}),
  todos: () => api.get("/outlook/todos"),
  archive: () => api.get("/outlook/archive"),
  all: () => api.get("/outlook/all"),
  informational: () => api.get("/outlook/informational"),
  uncertain: () => api.get("/outlook/uncertain"),
  disconnect: () => api.post("/outlook/disconnect", {}),
  setStatus: (id, status) => api.post(`/outlook/todos/${encodeURIComponent(id)}/status`, { status }),
  correct: (id, patch) => api.patch(`/outlook/messages/${encodeURIComponent(id)}/correction`, patch),
  convert: (id) => api.post(`/outlook/messages/${encodeURIComponent(id)}/task`, {}),
};

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export const teamApi = {
  reports: (date) => api.get(`/team/reports?date=${date}`),
  sync: (date) => api.post("/team/sync/reports", { date }),
  // 钉钉全部日志模板
  dingtalkTemplates: () => api.get("/team/dingtalk-templates"),
  // 已配置要拉取的模板 + 已知模板(id->name)
  templateConfig: () => api.get("/team/report-templates"),
  saveTemplateConfig: (templateIds) => api.post("/team/report-templates", { templateIds }),
};