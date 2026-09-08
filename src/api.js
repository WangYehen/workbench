const BASE = "/api";

async function request(url, options = {}) {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let msg = `请求失败 ${res.status}`;
    try {
      const body = await res.json();
      msg = body.error || body.results?.map((item) => item.error).filter(Boolean).join("；") || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export async function fetchSse(url, body, onEvent) {
  const response = await fetch(`${BASE}${url}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(body || {}) });
  if (!response.ok) { let message = `请求失败 ${response.status}`; try { message = (await response.json()).error || message; } catch {} throw new Error(message); }
  if (!response.body) throw new Error("当前浏览器不支持流式响应");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const chunks = buffer.split("\n\n"); buffer = chunks.pop() || ""; for (const chunk of chunks) { const event = chunk.match(/^event:\s*(.+)$/m)?.[1] || "message"; const data = chunk.match(/^data:\s*(.+)$/m)?.[1]; if (data) onEvent?.(event, JSON.parse(data)); } }
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
  todos: (options = {}) => api.get(`/outlook/todos?${new URLSearchParams(options)}`),
  archive: (options = {}) => api.get(`/outlook/archive?${new URLSearchParams(options)}`),
  all: (options = {}) => api.get(`/outlook/all?${new URLSearchParams(options)}`),
  informational: (options = {}) => api.get(`/outlook/informational?${new URLSearchParams(options)}`),
  uncertain: (options = {}) => api.get(`/outlook/uncertain?${new URLSearchParams(options)}`),
  disconnect: () => api.post("/outlook/disconnect", {}),
  setStatus: (id, status) => api.post(`/outlook/todos/${encodeURIComponent(id)}/status`, { status }),
  correct: (id, patch) => api.patch(`/outlook/messages/${encodeURIComponent(id)}/correction`, patch),
  convert: (id) => api.post(`/outlook/messages/${encodeURIComponent(id)}/task`, {}),
  // 邮件回复草稿：生成（tone=formal/friendly/action，force=true 强制重生成）与读取缓存
  draft: (id, opts = {}) => api.post(`/outlook/messages/${encodeURIComponent(id)}/draft`, opts),
  getDraft: (id) => api.get(`/outlook/messages/${encodeURIComponent(id)}/draft`),
};

export function todayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export const workbenchApi = {
  dashboard: (date) => api.get(`/dashboard?date=${encodeURIComponent(date || todayStr())}`),
  attention: (date, filters = {}) => {
    const params = new URLSearchParams({ date: date || todayStr(), ...filters });
    return api.get(`/attention?${params}`);
  },
  pulse: (date) => api.get(`/team/pulse?date=${encodeURIComponent(date || todayStr())}`),
  syncStatus: () => api.get("/sync/status"),
  syncRun: (date, sources) => api.post("/sync/run", { date: date || todayStr(), sources }),
};

export const managementApi = {
  dashboard: (date) => api.get(`/management/dashboard?date=${encodeURIComponent(date || todayStr())}`),
  cases: (filters = {}) => api.get(`/management/cases?${new URLSearchParams(filters)}`),
  detail: (id) => api.get(`/management/cases/${encodeURIComponent(id)}`),
  update: (id, patch) => api.patch(`/management/cases/${encodeURIComponent(id)}`, patch),
  actionPreview: (id, action) => api.post(`/management/cases/${encodeURIComponent(id)}/actions/preview`, action),
  actionExecute: (id, action) => api.post(`/management/cases/${encodeURIComponent(id)}/actions/execute`, action),
};

export const dwsApi = {
  status: () => api.get("/dws/status"),
  capabilities: () => api.get("/dws/capabilities"),
};

export const dwsAgentApi = {
  conversations: () => api.get("/dws-agent/conversations"),
  createConversation: (title) => api.post("/dws-agent/conversations", { title }),
  renameConversation: (id, title) => api.patch(`/dws-agent/conversations/${encodeURIComponent(id)}`, { title }),
  archiveConversation: (id) => api.post(`/dws-agent/conversations/${encodeURIComponent(id)}/archive`, {}),
  messages: (id) => api.get(`/dws-agent/conversations/${encodeURIComponent(id)}/messages`),
  sendTurn: (id, content, onEvent) => fetchSse(`/dws-agent/conversations/${encodeURIComponent(id)}/turns`, { content }, onEvent),
  confirm: (id, payload) => api.post(`/dws-agent/conversations/${encodeURIComponent(id)}/confirm`, payload),
};

export const dingtalkChatApi = {
  status: ({ refresh = false } = {}) => api.get(`/dingtalk-chat/status${refresh ? "?refresh=1" : ""}`),
  startAuth: () => api.post("/dingtalk-chat/auth/start", {}),
  authStatus: (id) => api.get(`/dingtalk-chat/auth/${encodeURIComponent(id)}`),
  settings: () => api.get("/dingtalk-chat/settings"),
  updateSettings: (patch) => api.patch("/dingtalk-chat/settings", patch),
  signals: (filters = {}) => api.get(`/dingtalk-chat/signals?${new URLSearchParams(filters)}`),
  signal: (id) => api.get(`/dingtalk-chat/signals/${encodeURIComponent(id)}`),
  updateSignal: (id, state) => api.patch(`/dingtalk-chat/signals/${encodeURIComponent(id)}`, { state }),
  confirmSignalDraft: (id, draft) => api.post(`/dingtalk-chat/signals/${encodeURIComponent(id)}/draft/confirm`, draft),
  conversations: (filters = {}) => api.get(`/dingtalk-chat/conversations?${new URLSearchParams(filters)}`),
  updateConversation: (id, patch) => api.patch(`/dingtalk-chat/conversations/${encodeURIComponent(id)}`, patch),
  messages: (filters = {}) => api.get(`/dingtalk-chat/messages?${new URLSearchParams(filters)}`),
  message: (id) => api.get(`/dingtalk-chat/messages/${encodeURIComponent(id)}`),
  updateMessage: (id, processingStatus) => api.patch(`/dingtalk-chat/messages/${encodeURIComponent(id)}`, { processingStatus }),
  createTodo: (id) => api.post(`/dingtalk-chat/messages/${encodeURIComponent(id)}/task`, {}),
  generateTodoDraft: (id) => api.post(`/dingtalk-chat/messages/${encodeURIComponent(id)}/draft`, {}),
  confirmTodoDraft: (id, draft) => api.post(`/dingtalk-chat/messages/${encodeURIComponent(id)}/draft/confirm`, draft),
  downloadAttachment: (id, attachmentId) => api.post(`/dingtalk-chat/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/download`, {}),
  confirmLink: (id) => api.post(`/dingtalk-chat/links/${encodeURIComponent(id)}/confirm`, {}),
  rejectLink: (id) => api.post(`/dingtalk-chat/links/${encodeURIComponent(id)}/reject`, {}),
};

export const teamApi = {
  reports: (date) => api.get(`/team/reports?date=${date}`),
  reportDetails: (date) => api.get(`/reports/dingtalk?date=${date}`),
  reportDates: () => api.get("/reports/dingtalk/dates"),
  sync: (date) => api.post("/team/sync/reports", { date }),
  // 手动维护的日志模板（增删改/启停）
  templateList: () => api.get("/team/report-templates"),
  templateCreate: (name) => api.post("/team/report-templates", { name }),
  templateUpdate: (id, patch) => api.put(`/team/report-templates/${id}`, patch),
  templateDelete: (id) => api.del(`/team/report-templates/${id}`),
};
