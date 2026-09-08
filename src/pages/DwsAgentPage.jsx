import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconArchive, IconArrowUp, IconCheck, IconEdit, IconMessagePlus, IconRefresh, IconRobot, IconTool, IconX } from "@tabler/icons-react";
import { dwsAgentApi } from "../api.js";
import "./DwsAgentPage.css";

const formatTime = (value) => value ? new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";
const displayToolResult = (item) => {
  const value = item.payload || {};
  if (item.tool_name === "dws.calendar.agenda") {
    const events = value.events || value.data?.events || [];
    if (!events.length) return "今天没有日程。";
    return events.map((event, index) => {
      const start = event.start?.dateTime || event.start || "";
      const end = event.end?.dateTime || event.end || "";
      return `${index + 1}. ${event.summary || event.title || "未命名日程"}${start ? `\n   ${new Date(start).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" })}${end ? `–${new Date(end).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : ""}` : ""}`;
    }).join("\n");
  }
  if (item.tool_name === "dws.report.list") return `已读取 ${value.reports?.length || 0} 篇日报${value.complete ? "（数据完整）" : "（结果仍有分页或不完整）"}。`;
  if (item.tool_name === "dws.report.missing") return `团队成员 ${value.memberCount || 0} 人，已提交 ${value.submittedCount || 0} 人，未提交 ${value.missing?.length || 0} 人。`;
  return item.content || JSON.stringify(value, null, 2);
};
const initialConversation = () => ({ id: "local-new", title: "新对话", local: true });

export default function DwsAgentPage() {
  const messageList = useRef(null);
  const followLatest = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const jumpToLatest = useCallback(() => {
    followLatest.current = true;
    setAwayFromLatest(false);
    if (messageList.current) messageList.current.scrollTop = messageList.current.scrollHeight;
  }, []);
  const [conversations, setConversations] = useState([]); const [active, setActive] = useState(null); const [messages, setMessages] = useState([]); const [draft, setDraft] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [pending, setPending] = useState(null);
  useLayoutEffect(() => {
    if (followLatest.current) jumpToLatest();
  }, [messages, busy, pending, error, jumpToLatest]);
  useEffect(() => {
    const observer = new ResizeObserver(() => { if (followLatest.current) jumpToLatest(); });
    if (messageList.current) observer.observe(messageList.current);
    return () => observer.disconnect();
  }, [jumpToLatest]);
  const loadConversations = useCallback(async () => { const result = await dwsAgentApi.conversations(); setConversations(result.items || []); if (!active && result.items?.length) setActive(result.items[0]); }, [active]);
  const loadMessages = useCallback(async (id) => { if (!id || id === "local-new") { setMessages([]); return; } const result = await dwsAgentApi.messages(id); setMessages(result.items || []); }, []);
  useEffect(() => { void loadConversations().catch((e) => setError(e.message)); }, [loadConversations]);
  useEffect(() => { void loadMessages(active?.id).catch((e) => setError(e.message)); }, [active, loadMessages]);
  const choose = (item) => { jumpToLatest(); setActive(item); setError(""); };
  async function newConversation() { try { const result = await dwsAgentApi.createConversation("新对话"); setConversations((items) => [result.conversation, ...items]); setActive(result.conversation); setMessages([]); } catch (e) { setError(e.message); } }
  async function rename(item) { const title = window.prompt("重命名对话", item.title); if (!title?.trim() || item.local) return; try { const result = await dwsAgentApi.renameConversation(item.id, title.trim()); setConversations((items) => items.map((x) => x.id === item.id ? result.conversation : x)); setActive(result.conversation); } catch (e) { setError(e.message); } }
  async function archive(item) { if (item.local) return; try { await dwsAgentApi.archiveConversation(item.id); setConversations((items) => items.filter((x) => x.id !== item.id)); setActive(null); setMessages([]); } catch (e) { setError(e.message); } }
  async function send() {
    const content = draft.trim(); if (!content || busy) return; jumpToLatest(); setError(""); setBusy(true); setDraft("");
    try {
      let conversation = active;
      if (!conversation || conversation.local) { const result = await dwsAgentApi.createConversation(content.slice(0, 32)); conversation = result.conversation; setConversations((items) => [conversation, ...items]); setActive(conversation); }
      setMessages((items) => [...items, { id: `local-${Date.now()}`, role: "user", content, event_type: "text", created_at: new Date().toISOString() }]);
      await dwsAgentApi.sendTurn(conversation.id, content, (event, data) => {
        if (event === "tool_call") setMessages((items) => [...items, { id: `tool-${Date.now()}`, role: "assistant", content: data.reason || `正在调用 ${data.tool}`, event_type: "tool_call", tool_name: data.tool, payload: data.arguments, created_at: new Date().toISOString() }]);
        if (event === "tool_result") setMessages((items) => [...items, { id: `result-${Date.now()}`, role: "tool", content: displayToolResult({ payload: data.result, tool_name: data.tool }), payload: data.result, event_type: "tool_result", tool_name: data.tool, created_at: new Date().toISOString() }]);
        if (event === "assistant_delta") setMessages((items) => [...items, { id: `answer-${Date.now()}`, role: "assistant", content: data.delta, event_type: "text", created_at: new Date().toISOString() }]);
        if (event === "structured_preview" || event === "confirmation_required") setPending(data);
        if (event === "error") setError(data.message || "Agent 执行失败");
      });
      await loadMessages(conversation.id); await loadConversations();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function confirm() { if (!pending?.audit || !active) return; setBusy(true); try { const result = await dwsAgentApi.confirm(active.id, { runId: pending.audit.runId || pending.preview?.runId, previewId: pending.audit.previewId || pending.preview?.id, idempotencyKey: pending.audit.idempotencyKey }); setPending(null); setMessages((items) => [...items, { id: `confirm-${Date.now()}`, role: "assistant", content: result.result?.verified ? "已完成并写入工作台。" : "动作已执行，请检查结果。", event_type: "text", created_at: new Date().toISOString() }]); await loadMessages(active.id); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const visible = useMemo(() => messages.filter(Boolean), [messages]);
  return <div className="dws-agent-page">
    <aside className="dws-agent-sidebar"><div className="dws-agent-sidebar__head"><strong>DWS Agent</strong><button className="btn primary sm" onClick={newConversation}><IconMessagePlus size={15} />新对话</button></div><div className="dws-agent-sidebar__list">{conversations.map((item) => <div className={`dws-agent-conversation ${active?.id === item.id ? "is-active" : ""}`} key={item.id}><button onClick={() => choose(item)}><IconMessagePlus size={15} /><span>{item.title}</span><small>{formatTime(item.updated_at)}</small></button><div><button title="重命名" onClick={() => rename(item)}><IconEdit size={14} /></button><button title="归档" onClick={() => archive(item)}><IconArchive size={14} /></button></div></div>)}{!conversations.length && <div className="dws-agent-empty">新建一个对话开始</div>}</div></aside>
    <main className="dws-agent-main"><header className="dws-agent-main__head"><div><h1>{active?.title || "DWS Agent"}</h1><p>让 Agent 查询钉钉真实数据，并在确认后更新工作台。</p></div><button className="btn sm" onClick={() => active && loadMessages(active.id)}><IconRefresh size={14} />刷新</button></header>
      <section ref={messageList} className="dws-agent-messages" onScroll={(event) => { const el = event.currentTarget; const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64; followLatest.current = nearBottom; setAwayFromLatest(!nearBottom); }}>{!visible.length && <div className="dws-agent-welcome"><IconRobot size={34} /><h2>今天想让 DWS 帮你推进什么？</h2><p>例如：总结今日日志中的团队阻塞点，或创建一场项目风险评审会。</p></div>}{visible.map((item) => <article className={`dws-agent-message dws-agent-message--${item.role}`} key={item.id}><span className="dws-agent-message__avatar">{item.role === "user" ? "我" : item.role === "tool" ? <IconTool size={14} /> : <IconRobot size={15} />}</span><div className="dws-agent-message__body"><div className="dws-agent-message__meta">{item.role === "user" ? "你" : item.role === "tool" ? `DWS · ${item.tool_name || "工具结果"}` : "DWS Agent"} · {formatTime(item.created_at)}</div><div className={item.event_type === "tool_result" ? "dws-agent-tool-result" : "dws-agent-message__content"}>{item.event_type === "tool_result" ? displayToolResult(item) : item.content}</div></div></article>)}{busy && <div className="dws-agent-running"><span className="dws-agent-dots" />Agent 正在处理…</div>}</section>
      {awayFromLatest && <button type="button" className="btn sm dws-agent-jump" onClick={jumpToLatest}>回到最新消息 ↓</button>}
      {pending && <section className="dws-agent-confirm"><div><strong>需要确认后执行</strong><p>{pending.preview?.summary || "该操作将改变工作台或钉钉数据。"}</p>{pending.preview?.payload?.items?.length > 0 && <ul className="dws-agent-preview-list">{pending.preview.payload.items.map((item, index) => <li key={`${item.sourceId || item.title}-${index}`}><b>{item.title}</b>{item.ownerName ? ` · ${item.ownerName}` : ""}</li>)}</ul>}</div><div className="dws-agent-confirm__actions"><button className="btn" onClick={() => setPending(null)}><IconX size={15} />取消</button><button className="btn primary" disabled={busy} onClick={confirm}><IconCheck size={15} />确认执行</button></div></section>}
      {error && <div className="error dws-agent-error">{error}</div>}
      <form className="dws-agent-composer" onSubmit={(e) => { e.preventDefault(); void send(); }}><textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); void send(); } }} placeholder="输入你的任务，例如：帮我找出今日日志中的团队阻塞点…（Ctrl+Enter 发送）" rows={2} disabled={busy} /><button className="dws-agent-send" disabled={busy || !draft.trim()} aria-label="发送" title="发送（Ctrl+Enter）"><IconArrowUp size={18} /></button></form>
    </main>
  </div>;
}
