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
  // 邮件回复草稿：生成（tone=formal/friendly/action，force=true 强制重生成）与读取缓存
  draft: (id, opts = {}) => api.post(`/outlook/messages/${encodeURIComponent(id)}/draft`, opts),
  getDraft: (id) => api.get(`/outlook/messages/${encodeURIComponent(id)}/draft`),
};

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export const teamApi = {
  reports: (date) => api.get(`/team/reports?date=${date}`),
  sync: (date) => api.post("/team/sync/reports", { date }),
  // 手动维护的日志模板（增删改/启停）
  templateList: () => api.get("/team/report-templates"),
  templateCreate: (name) => api.post("/team/report-templates", { name }),
  templateUpdate: (id, patch) => api.put(`/team/report-templates/${id}`, patch),
  templateDelete: (id) => api.del(`/team/report-templates/${id}`),
};