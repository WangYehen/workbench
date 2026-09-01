import { useCallback, useEffect, useState } from "react";
import { IconBulb, IconCalendarEvent, IconCheck, IconChevronDown, IconCircleFilled, IconClock, IconFolder, IconLink, IconMail, IconMessageCircle2, IconX } from "@tabler/icons-react";
import { dingtalkChatApi, todayStr, workbenchApi } from "../api.js";
import "./Emails2Page.css";
import "./Emails2PageFixes.css";
import "./DingtalkMessagesPage.css";

const SECTIONS = [["priority", "优先处理"], ["confirm", "待确认"], ["know", "知晓即可"]];
const TARGET_TEXT = { outlook: "邮件", calendar: "日程", project: "项目", todo: "待办" };
const formatTime = (value) => value ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
function relativeTime(value) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时前`;
  return formatTime(value);
}
function SignalNav({ groups, selected, onSelect }) {
  return <aside className="signal-nav">{SECTIONS.map(([key, label]) => {
    const items = groups.filter((item) => item.section === key);
    return <section className="signal-nav__section" key={key}><h2><IconCircleFilled className={`signal-dot signal-dot--${key}`} size={9} />{label}<span>{items.length}</span></h2>
      {items.map((item) => <button key={item.id} className={`signal-nav__item ${selected?.id === item.id ? "is-selected" : ""}`} onClick={() => onSelect(item)}><strong>{item.title}</strong><span>{item.conversation_title || "钉钉会话"}{item.mention_scope === "all" ? " · @所有人" : item.mention_scope === "self" ? " · @我" : ""}</span><time>{relativeTime(item.latest_evidence_at || item.updated_at)}</time></button>)}
    </section>;
  })}{!groups.length && <div className="signal-empty">目前没有需要你关注的钉钉信号。</div>}</aside>;
}

export default function DingtalkMessagesPage({ onStatusChange, onSyncReady, onSyncingChange }) {
  const [signals, setSignals] = useState([]); const [selectedSignal, setSelectedSignal] = useState(null);
  const [detail, setDetail] = useState(null); const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false); const [busy, setBusy] = useState("");
  const [error, setError] = useState(""); const [showRaw, setShowRaw] = useState(false);
  const selectSignal = useCallback(async (signal) => {
    setSelectedSignal(signal); setShowRaw(false); setError("");
    try { setDetail((await dingtalkChatApi.signal(signal.id)).item); } catch (e) { setError(e.message); }
  }, []);
  const load = useCallback(async () => {
    try {
      const [result, info] = await Promise.all([
        dingtalkChatApi.signals({ limit: "200" }),
        dingtalkChatApi.status().catch(() => null),
      ]);
      setSignals((result.items || []).filter((item) => Number(item.confidence) > 0));
      setStatus(info); onStatusChange?.(info);
    } catch (e) { setError(e.message); }
  }, [onStatusChange]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!signals.length) { setSelectedSignal(null); setDetail(null); } else if (!selectedSignal || !signals.some((item) => item.id === selectedSignal.id)) void selectSignal(signals[0]); }, [signals, selectedSignal, selectSignal]);
  const sync = useCallback(async () => { setSyncing(true); onSyncingChange?.(true); setError(""); try { await workbenchApi.syncRun(todayStr(), ["dingtalk_chat"]); await load(); } catch (e) { setError(e.message); } finally { setSyncing(false); onSyncingChange?.(false); } }, [load, onSyncingChange]);
  useEffect(() => { onSyncReady?.(sync); return () => onSyncReady?.(null); }, [onSyncReady, sync]);
  const update = async (key, work) => { if (!detail) return; setBusy(key); setError(""); try { await work(); await load(); } catch (e) { setError(e.message); } finally { setBusy(""); } };
  const adopt = () => update("adopt", () => dingtalkChatApi.confirmSignalDraft(detail.id, { title: detail.draft_title || detail.title, note: detail.draft_note || "", priority: detail.draft_priority || detail.priority || "P2", dueDate: detail.draft_due_date || null }));
  const evidence = detail?.evidence || []; const rootEvidence = evidence.find((item) => item.is_root) || evidence.at(-1);
  const suggestedSteps = Array.isArray(detail?.steps) && detail.steps.length ? detail.steps : [
    "确认事项是否需要由你推进，以及相关负责人。",
    "核对关联对象与上下文，避免遗漏已有安排。",
    "采纳后创建待办；不需要处理时将不再出现在默认列表。",
  ];
  const rawMessages = evidence;
  return <div className="signal-page">
    {error && <div className="error">{error}</div>}
    <div className="signal-head"><div><h1>钉钉工作信号</h1><p>AI 从与你相关的对话中提炼需要关注的事项</p></div><div className="signal-head__actions"><span className="signal-head__sync"><i />{status?.lastSync?.finishedAt ? `最近同步 ${formatTime(status.lastSync.finishedAt)}` : "等待同步"}{syncing ? " · 同步中" : ""}</span></div></div>
    <div className="signal-layout"><SignalNav groups={signals} selected={selectedSignal} onSelect={selectSignal} />
      <main className="signal-brief">{detail ? <>
        <div className="signal-source"><span>{rootEvidence?.conversation_title || "钉钉会话"}</span>{rootEvidence?.mention_scope === "all" ? <b>@所有人</b> : rootEvidence?.mention_scope === "self" ? <b>@我</b> : null}<time>{relativeTime(rootEvidence?.sent_at || detail.updated_at)}</time></div><h2>{detail.title}</h2>
        <section className="signal-reading"><h3><IconMessageCircle2 size={21} />AI 读懂 <small>（用大白话）</small></h3><strong>{detail.conclusion || "正在分析这条工作信号"}</strong><p>{detail.draft_note || (detail.classification === "action" ? "这件事需要你作出判断或推动下一步。" : "这是一条重要同步，当前无需你直接处理。")}</p></section>
        <section className="signal-steps"><h3><IconBulb size={20} />建议你如何处理</h3><ul>{suggestedSteps.map((step) => <li key={step}>{step}</li>)}</ul></section>
        <div className="signal-actions"><button className="btn primary" disabled={busy === "adopt"} onClick={adopt}><IconCheck size={16} />{busy === "adopt" ? "正在创建…" : "采纳待办建议"}</button><button className="btn" disabled={busy === "waiting"} onClick={() => update("waiting", () => dingtalkChatApi.updateSignal(detail.id, "waiting"))}><IconClock size={16} />标记等待他人</button><button className="btn" disabled={busy === "ignore"} onClick={() => update("ignore", () => dingtalkChatApi.updateSignal(detail.id, "ignored"))}><IconX size={16} />不需要处理</button></div>
      </> : <div className="signal-empty">选择一条工作信号查看 AI 判断。</div>}</main>
      <aside className="signal-evidence">{detail && <><h2>AI 如何得出这个结论</h2><section><h3>核心事实</h3><ul className="signal-facts">{(detail.facts?.length ? detail.facts : ["尚未获得有效 AI 分析结果"]).map((fact) => <li key={fact}>{fact}</li>)}</ul></section>
        <section><h3>相关对象（项目、邮件、日程）</h3>{detail.links?.length ? detail.links.map((link) => { const TargetIcon = link.target_type === "project" ? IconFolder : link.target_type === "calendar" ? IconCalendarEvent : link.target_type === "outlook" ? IconMail : IconLink; return <div className={`signal-link signal-link--${link.target_type}`} key={link.id}><TargetIcon size={17} /><span>{TARGET_TEXT[link.target_type] || link.target_type}：{link.target_id}</span><IconChevronDown size={15} /></div>; }) : <p className="signal-muted">暂未识别到明确的邮件、项目或日程关联。</p>}</section>
        <section><h3>上下文时间线（{evidence.length} 条）</h3><div className="signal-timeline">{evidence.slice(0, 4).map((item) => <p key={item.id}><time>{formatTime(item.sent_at)}</time><b>{item.sender_name || "成员"}</b>{item.excerpt || "（原消息已清理）"}</p>)}</div></section>
        <button className="signal-raw" onClick={() => setShowRaw((value) => !value)}><IconChevronDown size={16} />{showRaw ? "收起原始消息" : `展开 ${rawMessages.length} 条原始消息`}</button>{showRaw && <div className="signal-raw-list">{rawMessages.map((item) => <p key={item.id}><b>{item.sender_name || "成员"}</b>：{item.message_available ? (item.raw_content || item.excerpt || "（非文本消息）") : "原始消息已按保留策略清理"}</p>)}</div>}
      </>}</aside>
    </div>
  </div>;
}
