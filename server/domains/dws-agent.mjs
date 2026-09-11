import crypto from "node:crypto";
import { getDb } from "../db.mjs";
import { ai as defaultAi } from "../ai/ai.mjs";
import { createDwsAgentTools } from "./dws-agent-tools.mjs";
import { localDateString } from "../core/local-date.mjs";

const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const shortTitle = (text) => String(text || "新对话").replace(/\s+/g, " ").trim().slice(0, 32) || "新对话";
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const relativeDate = (value, now) => {
  const day = localDateString(now);
  if (value === "today") return day;
  if (value === "yesterday") {
    const date = new Date(`${day}T00:00:00+08:00`);
    date.setUTCDate(date.getUTCDate() - 1);
    return localDateString(date);
  }
  return value;
};
const reportDate = (text, now) => relativeDate(/昨天|昨日|前一天/.test(String(text)) ? "yesterday" : /上周五/.test(String(text)) ? "previous_friday" : "today", now);

export function createDwsAgentService({ database = getDb, aiService = defaultAi, agentRuntime = null, dwsClient, dashboard = null, now = () => new Date() } = {}) {
  const tools = createDwsAgentTools({ database, dwsClient, dashboard });
  const pending = new Map();
  const db = () => database();
  const stamp = () => now().toISOString();
  const emit = (fn, event, data) => { if (typeof fn === "function") fn(event, data); };
  function conversation(id) { return db().prepare("SELECT * FROM dws_agent_conversations WHERE id=?").get(id); }
  function messages(id) { return db().prepare("SELECT * FROM dws_agent_messages WHERE conversation_id=? ORDER BY created_at,id").all(id).map((row) => ({ ...row, payload: parse(row.payload_json) })); }
  function addMessage(id, role, content, eventType = "text", toolName = null, payload = null) {
    const message = { id: crypto.randomUUID(), conversationId: id, role, content: String(content || ""), eventType, toolName, payload, createdAt: stamp() };
    db().prepare("INSERT INTO dws_agent_messages(id,conversation_id,role,content,event_type,tool_name,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(message.id, id, role, message.content, eventType, toolName, payload == null ? null : JSON.stringify(payload), message.createdAt);
    db().prepare("UPDATE dws_agent_conversations SET updated_at=?,last_message_at=? WHERE id=?").run(message.createdAt, message.createdAt, id);
    return message;
  }
  function listConversations() { return db().prepare("SELECT * FROM dws_agent_conversations WHERE status='active' ORDER BY updated_at DESC").all(); }
  function createConversation(title = "新对话") { const id = `conv_${crypto.randomUUID()}`; const at = stamp(); db().prepare("INSERT INTO dws_agent_conversations(id,title,status,created_at,updated_at,last_message_at) VALUES(?,?, 'active',?,?,NULL)").run(id, shortTitle(title), at, at); return conversation(id); }
  function rename(id, title) { if (!conversation(id)) return null; db().prepare("UPDATE dws_agent_conversations SET title=?,updated_at=? WHERE id=?").run(shortTitle(title), stamp(), id); return conversation(id); }
  function archive(id) { if (!conversation(id)) return null; db().prepare("UPDATE dws_agent_conversations SET status='archived',updated_at=? WHERE id=?").run(stamp(), id); return conversation(id); }
  function saveRun(run) { db().prepare("INSERT INTO dws_agent_runs(id,conversation_id,user_message_id,status,input_hash,output_json,error_json,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)").run(run.id, run.conversationId, run.userMessageId, run.status, run.inputHash, run.output ? JSON.stringify(run.output) : null, run.error ? JSON.stringify(run.error) : null, run.createdAt, run.completedAt || null); }
  function updateRun(id, patch) { const current = db().prepare("SELECT * FROM dws_agent_runs WHERE id=?").get(id); const next = { ...current, ...patch }; db().prepare("UPDATE dws_agent_runs SET status=?,output_json=?,error_json=?,completed_at=? WHERE id=?").run(next.status, next.output ? JSON.stringify(next.output) : null, next.error ? JSON.stringify(next.error) : null, next.completedAt || null, id); return next; }
  function recordAction(runId, preview) { const id = crypto.randomUUID(); const key = crypto.randomUUID(); db().prepare("INSERT INTO dws_agent_actions(id,run_id,action_type,preview_json,confirmed,idempotency_key,status,created_at) VALUES(?,?,?,?,0,?,?,?)").run(id, runId, preview.name, JSON.stringify(preview), key, "previewed", stamp()); return { id, runId, idempotencyKey: key, previewId: preview.id }; }

  async function runTurn(conversationId, userText, onEvent) {
    const current = conversation(conversationId); if (!current) throw Object.assign(new Error("未找到对话"), { code: "DWS_CONVERSATION_NOT_FOUND" });
    const user = addMessage(conversationId, "user", userText); emit(onEvent, "message_start", { id: user.id, role: "user" });
    if (current.title === "新对话") rename(conversationId, shortTitle(userText));
    const run = { id: `run_${crypto.randomUUID()}`, conversationId, userMessageId: user.id, status: "running", inputHash: hash(JSON.stringify({ conversationId, userText })), createdAt: stamp() }; saveRun(run);
    let context = ""; const wantsPersist = /同步|写入|落库|保存|沉淀/.test(String(userText)); let planMessages = messages(conversationId).slice(-16).map((item) => ({ role: item.role, content: item.content }));
    for (let step = 0; step < 6; step += 1) {
      const isTodoCreate = step === 0 && /(创建|新建|添加|指派)/.test(String(userText)) && /(待办|任务|todo)/i.test(String(userText));
      const isTodoQuery = step === 0 && /(查询|查看|看看|有哪些|列出|搜索)/.test(String(userText)) && /(待办|任务|todo)/i.test(String(userText)) && !/(创建|新建|添加|指派|安排一个)/.test(String(userText));
      const isAgendaQuery = !isTodoQuery && step === 0 && /(查询|查看|看看|有哪些)/.test(String(userText)) && /(今天|今日|明天|本周|会议|日程|日历)/.test(String(userText)) && !/(创建|新建|安排一场|开一个|约一个)/.test(String(userText));
      const isReportQuery = step === 0 && /(日报|日志|卡点|阻塞|遗留|协作|提交情况)/.test(String(userText));
      const isMissingReportQuery = isReportQuery && /(谁没有|未提交|没提交|缺交)/.test(String(userText));
      const todoTitle = isTodoCreate ? (String(userText).match(/(?:内容是|内容为|标题是|任务是)\s*[：:]?\s*(.+)$/)?.[1]?.trim() || String(userText).replace(/^.*?(?:创建|新建|添加|指派)(?:一个)?(?:待办|任务)?[，,：:]?\s*/i, "").trim() || "待办") : "";
      const plan = isTodoCreate
        ? { kind: "confirmation", tool: "dws.todo.assign", arguments: { title: todoTitle }, answer: "我已整理好待办创建预览，请确认后同步到钉钉和工作台。", reason: "创建待办需要确认", result_schema: "todo_sync" }
        : isTodoQuery
        ? { kind: "tool_call", tool: "dws.todo.related", arguments: {}, answer: "我先读取与你相关的钉钉待办。", reason: "需要查询真实待办", result_schema: "todo_list" }
        : isAgendaQuery
        ? { kind: "tool_call", tool: "dws.calendar.agenda", arguments: {}, answer: "我先读取你的钉钉日程，再整理今天需要参加的会议。", reason: "需要查询真实日程", result_schema: "calendar_agenda" }
          : isMissingReportQuery
            ? { kind: "tool_call", tool: "dws.report.missing", arguments: { date: reportDate(userText, now()) }, answer: "我先读取日报提交记录和团队成员名单。", reason: "需要真实日志数据。", result_schema: "report_missing" }
          : isReportQuery
            ? { kind: "tool_call", tool: "dws.report.list", arguments: { date: reportDate(userText, now()) }, answer: "我先读取真实日报，再分析成员的卡点和协作需求。", reason: "需要真实日志数据。", result_schema: "report_analysis" }
            : await (agentRuntime?.agentPlan || aiService.agentPlan)({ messages: planMessages, tools: tools.list(), userText: step === 0 ? userText : context }).catch(() => aiService.agentPlan({ messages: planMessages, tools: tools.list(), userText: step === 0 ? userText : context }));
      if (plan.kind === "tool_call" && plan.tool) {
        emit(onEvent, "tool_call", { tool: plan.tool, arguments: plan.arguments, reason: plan.reason });
        addMessage(conversationId, "assistant", plan.reason || `调用 ${plan.tool}`, "tool_call", plan.tool, plan.arguments);
        try {
          const toolArgs = plan.tool === "dws.report.list" && /分析|总结|卡点|阻塞|遗留|协作/.test(String(userText)) ? { ...(plan.arguments || {}), includeDetails: true } : (plan.arguments || {});
          const result = await tools.read(plan.tool, toolArgs); context = JSON.stringify(result); addMessage(conversationId, "tool", context, "tool_result", plan.tool, result); emit(onEvent, "tool_result", { tool: plan.tool, result });
          if (plan.tool === "workbench.team_reports" || plan.tool === "dws.report.list") {
            const reportItems = result.items || result.reports || result.result?.reports || result.result?.data_list || [];
            const blockers = reportItems.flatMap((report) => {
              if (Array.isArray(report.blockers)) return report.blockers.map((item) => ({ item, report }));
              const content = Array.isArray(report.content) ? report.content.filter((field) => /遗留|协作|阻塞|风险/.test(field.key || "") && String(field.value || "").trim()).map((field) => ({ item: field.value, report })) : [];
              return content;
            }).map(({ item, report }, index) => {
              const text = typeof item === "string" ? item : (item.title || item.content || item.summary || "团队阻塞点");
              const ownerId = report.user_id || report.userId || report.creatorUserId || report.creator_user_id || null;
              const ownerName = report.user_name || report.userName || report.creatorName || null;
              const sourceId = report.id || report.reportId || ownerId || "unknown";
              return { title: text, summary: typeof item === "string" ? text : (item.summary || item.content || text), excerpt: report.summary || text, ownerId, ownerName, sourceId: `${sourceId}:${index}`, sourceType: "dingtalk_report", occurredAt: report.report_date || report.createTime };
            });
            if (wantsPersist && blockers.length) {
              const preview = tools.preview("workbench.persist_management_cases", { items: blockers }); const audit = recordAction(run.id, preview); pending.set(preview.id, { runId: run.id, conversationId, name: "workbench.persist_management_cases", preview, audit });
              addMessage(conversationId, "assistant", "我已从今日日志提取出以下阻塞点，请确认后同步到工作台。", "structured_preview", "workbench.persist_management_cases", { preview, audit }); emit(onEvent, "structured_preview", { preview, audit }); emit(onEvent, "confirmation_required", { preview, audit }); updateRun(run.id, { status: "waiting_confirmation", output: { preview, audit } }); return { runId: run.id, status: "waiting_confirmation", preview, audit };
            }
            const aiAnswer = (await (agentRuntime?.agentAnswer || aiService.agentAnswer)({ messages: planMessages, context }).catch(() => aiService.agentAnswer({ messages: planMessages, context }))).answer;
            const answer = blockers.length && (!aiAnswer || /无法分析|未能成功获取|没有获取到/.test(aiAnswer))
              ? `已读取 ${reportItems.length} 篇日报，发现 ${blockers.length} 条卡点线索：\n${blockers.map((item, index) => `${index + 1}. ${item.ownerName ? `${item.ownerName}：` : ""}${item.title}`).join("\n")}`
              : aiAnswer;
            const assistant = addMessage(conversationId, "assistant", answer); emit(onEvent, "assistant_delta", { delta: answer }); emit(onEvent, "done", { runId: run.id, messageId: assistant.id }); updateRun(run.id, { status: "completed", output: { answer }, completedAt: stamp() }); return { runId: run.id, status: "completed", answer };
          }
          if (plan.tool === "dws.calendar.agenda") {
            const payload = result.data || result.result?.data || result;
            const items = Array.isArray(payload) ? payload : (payload.items || payload.events || payload.result?.items || payload.result?.events || []);
            const answer = items.length ? `今天共有 ${items.length} 个日程：\n${items.map((item, index) => { const title = item.summary || item.title || item.subject || "未命名日程"; const start = item.start?.dateTime || item.start; const end = item.end?.dateTime || item.end; const time = start ? new Date(start).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) + (end ? `–${new Date(end).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "") : ""; return `${index + 1}. ${title}${time ? ` · ${time}` : ""}${item.organizer ? ` · 组织者 ${item.organizer}` : ""}`; }).join("\n")}` : "今天没有查询到日程。";
            const assistant = addMessage(conversationId, "assistant", answer); emit(onEvent, "assistant_delta", { delta: answer }); emit(onEvent, "done", { runId: run.id, messageId: assistant.id }); updateRun(run.id, { status: "completed", output: { answer }, completedAt: stamp() }); return { runId: run.id, status: "completed", answer };
          }
          if (plan.tool === "dws.todo.related") {
            const payload = result.data || result.result?.data || result;
            const items = Array.isArray(payload) ? payload : (payload.tasks || payload.items || payload.result?.tasks || payload.result?.items || []);
            const answer = items.length ? `共查询到 ${items.length} 条相关待办：\n${items.slice(0, 20).map((item, index) => { const title = item.title || item.subject || "未命名待办"; const due = item.planFinishDate || item.dueTime || item.due; const dueText = due ? ` · 截止 ${new Date(due).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""; return `${index + 1}. ${title}${dueText}`; }).join("\n")}${items.length > 20 ? `\n…另有 ${items.length - 20} 条` : ""}` : "没有查询到与你相关的待办。";
            const assistant = addMessage(conversationId, "assistant", answer); emit(onEvent, "assistant_delta", { delta: answer }); emit(onEvent, "done", { runId: run.id, messageId: assistant.id }); updateRun(run.id, { status: "completed", output: { answer }, completedAt: stamp() }); return { runId: run.id, status: "completed", answer };
          }
          if (plan.tool === "dws.report.missing") {
            const answer = result.complete ? `共 ${result.memberCount} 名成员，已提交 ${result.submittedCount} 人，未提交 ${result.missing?.length || 0} 人。${result.missing?.length ? `\n未提交：${result.missing.map((item) => item.name).join("、")}` : ""}` : `已获取 ${result.submittedCount} 名提交人，但日报结果不完整，暂不能可靠判断未提交人员。`;
            const assistant = addMessage(conversationId, "assistant", answer); emit(onEvent, "assistant_delta", { delta: answer }); emit(onEvent, "done", { runId: run.id, messageId: assistant.id }); updateRun(run.id, { status: "completed", output: { answer }, completedAt: stamp() }); return { runId: run.id, status: "completed", answer };
          }
          planMessages = messages(conversationId).slice(-16).map((item) => ({ role: item.role === "tool" ? "user" : item.role, content: item.content })); continue;
        } catch (error) { context = `工具 ${plan.tool} 失败：${error.message}`; emit(onEvent, "error", { code: error.code, message: error.message }); break; }
      }
      if (plan.kind === "confirmation" || plan.kind === "structured_write" || (plan.tool && tools.list().find((item) => item.name === plan.tool)?.mode === "write")) {
        if (plan.tool === "dws.calendar.create" && (!plan.arguments?.start || !plan.arguments?.end)) {
          const answer = plan.answer || "请补充会议的具体日期、开始时间、结束时间和参会人，我再为你生成创建预览。"; const assistant = addMessage(conversationId, "assistant", answer); emit(onEvent, "assistant_delta", { delta: answer }); emit(onEvent, "done", { runId: run.id, messageId: assistant.id }); updateRun(run.id, { status: "completed", output: { answer }, completedAt: stamp() }); return { runId: run.id, status: "completed", answer };
        }
        const preview = tools.preview(plan.tool, plan.arguments || {}); const audit = recordAction(run.id, preview); pending.set(preview.id, { runId: run.id, conversationId, name: plan.tool, preview, audit });
        addMessage(conversationId, "assistant", plan.answer || "请确认以下操作", "structured_preview", plan.tool, { preview, audit }); emit(onEvent, "structured_preview", { preview, audit }); emit(onEvent, "confirmation_required", { preview, audit });
        updateRun(run.id, { status: "waiting_confirmation", output: { preview, audit } }); return { runId: run.id, status: "waiting_confirmation", preview, audit };
      }
      const answer = plan.answer || (await (agentRuntime?.agentAnswer || aiService.agentAnswer)({ messages: planMessages, context }).catch(() => aiService.agentAnswer({ messages: planMessages, context }))).answer;
      const assistant = addMessage(conversationId, "assistant", answer); emit(onEvent, "assistant_delta", { delta: answer }); emit(onEvent, "done", { runId: run.id, messageId: assistant.id }); updateRun(run.id, { status: "completed", output: { answer }, completedAt: stamp() }); return { runId: run.id, status: "completed", answer };
    }
    const answer = context || "本次操作未完成，请检查 DWS 连接和权限后重试。"; const assistant = addMessage(conversationId, "assistant", answer, "error"); emit(onEvent, "done", { runId: run.id, messageId: assistant.id }); updateRun(run.id, { status: "failed", error: { message: answer }, completedAt: stamp() }); return { runId: run.id, status: "failed", answer };
  }

  async function confirm(runId, previewId, idempotencyKey, conversationId = null) {
    const item = pending.get(previewId); if (!item || item.runId !== runId || (conversationId && item.conversationId !== conversationId) || item.audit.idempotencyKey !== idempotencyKey) throw Object.assign(new Error("确认信息无效或已过期"), { code: "DWS_CONFIRMATION_INVALID" });
    pending.delete(previewId); const result = await tools.execute(item.name, item.preview.payload, { idempotencyKey }); db().prepare("UPDATE dws_agent_actions SET confirmed=1,status=?,result_json=?,external_id=?,executed_at=? WHERE idempotency_key=?").run(result.verified === false ? "partial" : "completed", JSON.stringify(result), result.id || result.eventId || result.taskId || null, stamp(), idempotencyKey); updateRun(runId, { status: "completed", output: { result }, completedAt: stamp() }); addMessage(item.conversationId, "tool", JSON.stringify(result), "tool_result", item.name, result); addMessage(item.conversationId, "assistant", result.verified ? "已完成并写入工作台。" : `工作台已保留记录，钉钉同步尚未核验：${result.error || "请在待办页查看同步状态。"}`, "text"); return { runId, result };
  }
  function run(id) { const row = db().prepare("SELECT * FROM dws_agent_runs WHERE id=?").get(id); return row ? { ...row, output: parse(row.output_json), error: parse(row.error_json) } : null; }
  return { listConversations, createConversation, rename, archive, conversation, messages, runTurn, confirm, run };
}
