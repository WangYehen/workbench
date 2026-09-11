import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconCheck, IconClock, IconFolder, IconMessageCircle2, IconRefresh, IconX } from "@tabler/icons-react";
import { dingtalkChatApi, todayStr, workbenchApi } from "../api.js";
import SearchInput from "../components/SearchInput.jsx";
import EmptyState from "../components/EmptyState.jsx";
import "./DingtalkMessagesPage.css";
import "./ModuleShellTheme.css";

const formatTime = (value) => value ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const priorityLabel = { P0: "紧急", P1: "重要", P2: "一般" };

function Item({ item, active, onClick }) {
  return <button className={`signal-nav__item ${active ? "is-selected" : ""}`} onClick={() => onClick(item)}>
    <strong><span className={`oc-tag oc-tag--${(item.priority || "P2").toLowerCase()}`}>{priorityLabel[item.priority] || item.priority}</span>{item.title}</strong>
    <span>{item.project_name ? `${item.project_name} · ` : ""}{item.conversation_title || "钉钉会话"}{item.mention_scope === "self" ? " · @我" : item.mention_scope === "all" ? " · @所有人" : ""}</span>
    <time>{formatTime(item.sent_at || item.updated_at)}</time>
  </button>;
}

function Queue({ items, selected, onSelect, query }) {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? items : items.slice(0, 20);
  useEffect(() => setExpanded(false), [query, items]);
  if (!items.length) return <EmptyState title={query.split(":")[1] ? "未找到匹配的事项" : "当前分组暂无事项"} minHeight={180}/>;
  return <div className="signal-nav__list">{visibleItems.map((item) => <Item key={`${item.source}:${item.id}:${item.project_id || ""}`} item={item} active={selected?.id === item.id && selected?.source === item.source} onClick={onSelect} />)}{items.length > 20 && <button className="signal-nav__more" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起列表" : `查看其余 ${items.length - 20} 条`}</button>}</div>;
}

export default function DingtalkMessagesPage({ onStatusChange, onSyncReady, onSyncingChange }) {
  const [inbox, setInbox] = useState(null); const [selected, setSelected] = useState(null); const [detail, setDetail] = useState(null);
  const [syncing, setSyncing] = useState(false); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const [view, setView] = useState("reply"); const [query, setQuery] = useState("");
  const selectionRequest = useRef(0);
  const load = useCallback(async () => { try { const [result, status] = await Promise.all([dingtalkChatApi.inbox(), dingtalkChatApi.status().catch(() => null)]); setInbox(result); onStatusChange?.(status); } catch (e) { setError(e.message); } }, [onStatusChange]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 30000); return () => clearInterval(timer); }, [load]);
  const select = useCallback(async (item) => { const requestId = ++selectionRequest.current; setSelected(item); setDetail(null); setError(""); try { const result = item.source === "message" ? await dingtalkChatApi.message(item.id) : await dingtalkChatApi.signal(item.id); if (requestId === selectionRequest.current) setDetail({ ...result.item, source: item.source }); } catch (e) { if (requestId === selectionRequest.current) setError(e.message); } }, []);
  const queues = useMemo(() => inbox ? [{ key: "reply", label: "待回复", hint: "仅展示 AI 判断为需要你明确回复、且尚无本人后续回复的消息。", items: inbox.replyPending }, { key: "action", label: "待处理", items: inbox.actionRequired }, { key: "project", label: "项目动态", hint: "仅包含已关联的群聊风险、进度或状态变化。", items: inbox.projectUpdates }] : [], [inbox]);
  const activeQueue = queues.find((queue) => queue.key === view) || queues[0];
  const visibleItems = useMemo(() => (activeQueue?.items || []).filter((item) => `${item.title || ""} ${item.conversation_title || ""} ${item.project_name || ""}`.toLowerCase().includes(query.trim().toLowerCase())), [activeQueue, query]);
  useEffect(() => { const current = visibleItems.find((item) => item.id === selected?.id && item.source === selected?.source); if (!current && selected) { selectionRequest.current += 1; setSelected(null); setDetail(null); } else if (visibleItems[0] && !selected) void select(visibleItems[0]); }, [visibleItems, selected, select]);
  const sync = useCallback(async () => { setSyncing(true); onSyncingChange?.(true); try { await workbenchApi.syncRun(todayStr(), ["dingtalk_chat"]); await load(); } catch (e) { setError(e.message); } finally { setSyncing(false); onSyncingChange?.(false); } }, [load, onSyncingChange]);
  useEffect(() => { onSyncReady?.(sync); return () => onSyncReady?.(null); }, [onSyncReady, sync]);
  const act = async (key, fn) => { if (!detail || busy) return; setBusy(key); setError(""); try { await fn(); selectionRequest.current += 1; setSelected(null); setDetail(null); await load(); } catch (e) { setError(e.message); } finally { setBusy(""); } };
  if (!inbox) return <div className="spinner">加载钉钉事项中心…</div>;
  if (!inbox.ready) return <div className="error">{inbox.error}</div>;
  return <div className="signal-page">{error && <div className="error">{error}</div>}<div className="signal-head"><div><h1>钉钉事项中心</h1><p>按主管需要回复、处理和关注的项目动态集中整理</p></div><button className="btn sm" onClick={sync} disabled={syncing || Boolean(busy)}><IconRefresh size={15}/>{syncing ? "同步中" : "同步并研判"}</button></div><div className="signal-layout"><aside className="signal-nav"><div className="signal-nav__tabs" role="tablist" aria-label="事项分组">{queues.map((queue) => <button key={queue.key} role="tab" aria-selected={view === queue.key} className={view === queue.key ? "is-active" : ""} onClick={() => { selectionRequest.current += 1; setView(queue.key); setQuery(""); setSelected(null); setDetail(null); }}>{queue.label}<span>{queue.items.length}</span></button>)}</div><SearchInput className="signal-nav__search" value={query} onChange={(value) => { selectionRequest.current += 1; setQuery(value); setSelected(null); setDetail(null); }} placeholder="搜索当前事项" />{activeQueue?.hint && <p className="signal-muted signal-nav__hint">{activeQueue.hint}</p>}<Queue items={visibleItems} selected={selected} onSelect={select} query={`${view}:${query}`}/></aside><main className="signal-brief">{detail ? <><div className="signal-source"><span>{detail.conversation_title || detail.evidence?.at(-1)?.conversation_title || "钉钉会话"}</span><time>{formatTime(detail.sent_at || detail.updated_at)}</time></div><h2>{detail.title || detail.summary || detail.content?.slice(0, 80)}</h2><section className="signal-reading"><h3><IconMessageCircle2 size={20}/>AI 判断</h3><strong>{detail.conclusion || detail.summary || "待你确认后续处理方式"}</strong><p>{detail.draft_note || detail.action_text || detail.content}</p></section>{detail.facts?.length ? <section className="signal-steps"><h3><IconFolder size={20}/>关键信息</h3><ul>{detail.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul></section> : null}<div className="signal-actions"><button className="btn primary" disabled={Boolean(busy) || detail.todo_id || detail.processing_status === "task_created" || detail.state === "todo_created"} onClick={() => act("todo", () => detail.source === "message" ? dingtalkChatApi.createTodo(detail.id) : dingtalkChatApi.confirmSignalDraft(detail.id, { title: detail.draft_title || detail.title, note: detail.draft_note || "", priority: detail.draft_priority || detail.priority || "P2", dueDate: detail.draft_due_date || null }))}><IconCheck size={16}/>{detail.todo_id || detail.processing_status === "task_created" || detail.state === "todo_created" ? "已转为待办" : busy === "todo" ? "创建中" : "转为待办"}</button>{detail.source === "signal" && <button className="btn" disabled={Boolean(busy)} onClick={() => act("waiting", () => dingtalkChatApi.updateSignal(detail.id, "waiting"))}><IconClock size={16}/>等待他人</button>}<button className="btn" disabled={Boolean(busy)} onClick={() => act("ignore", () => detail.source === "message" ? dingtalkChatApi.updateMessage(detail.id, "ignored") : dingtalkChatApi.updateSignal(detail.id, "ignored"))}><IconX size={16}/>{busy === "ignore" ? "处理中" : "不需要处理"}</button></div></> : <div className="signal-empty">选择一条事项查看详情。</div>}</main><aside className="signal-evidence">{detail ? <><div className="signal-evidence__head"><h2>消息证据</h2><span>最近 5 条</span></div><div className="signal-timeline signal-evidence__timeline">{(detail.evidence || detail.context || []).slice(-5).map((item) => <p key={item.id}><time>{formatTime(item.sent_at)}</time><b>{item.sender_name || "成员"}</b>{item.raw_content || item.content || item.excerpt}</p>)}</div></> : <div className="signal-empty">详情会显示关联消息。</div>}</aside></div></div>;
}
