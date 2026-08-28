import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconAlertTriangle, IconArchive, IconArrowUpRight, IconCalendarDue, IconCheck,
  IconCircleCheck, IconClock, IconCopy, IconFileText, IconListCheck, IconMail,
  IconRefresh, IconSearch, IconShieldLock, IconSparkles, IconUserQuestion,
} from "@tabler/icons-react";
import { outlookApi, todayStr } from "../api.js";
import "./Emails2Page.css";
import "./Emails2PageFixes.css";

const queues = {
  action: { label: "需要行动", empty: "没有需要你立即处理的邮件" },
  informational: { label: "仅供知晓", empty: "暂无通知、抄送或系统消息" },
  uncertain: { label: "无法判断", empty: "暂无需要你确认的邮件" },
  archive: { label: "已归档", empty: "暂无已归档邮件" },
};

function dueInfo(message) {
  if (!message.dueAt) return { tone: "none", label: "无明确截止", detail: "—" };
  const dueKey = String(message.dueAt).slice(0, 10);
  const now = new Date();
  const due = new Date(message.dueAt);
  if (dueKey < todayStr()) return { tone: "overdue", label: "已逾期", detail: due.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) };
  if (dueKey === todayStr()) return { tone: "today", label: `今天 ${due.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`, detail: "今天截止" };
  const days = Math.ceil((due - now) / 86400000);
  return { tone: "later", label: `${days} 天后`, detail: due.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) };
}

function receivedAt(message) {
  if (!message.receivedAt) return "—";
  return new Date(message.receivedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Kpi({ icon, label, value, detail, tone = "blue" }) {
  return <section className={`m2-kpi m2-kpi--${tone}`}><span className="m2-kpi__icon">{icon}</span><div><div className="m2-kpi__label">{label}</div><strong>{value}</strong><div className="m2-kpi__detail">{detail}</div></div></section>;
}

function DraftModal({ message, onClose, onFlash }) {
  const [tone, setTone] = useState("formal");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; outlookApi.getDraft(message.id).then((r) => { if (live && r.draft) { setDraft(r.draft); setTone(r.tone || "formal"); } }).catch(() => {}).finally(() => live && setBusy(false)); return () => { live = false; }; }, [message.id]);
  const generate = async (nextTone = tone) => { setBusy(true); try { const r = await outlookApi.draft(message.id, { tone: nextTone, force: Boolean(draft) }); setDraft(r.draft); setTone(r.tone || nextTone); } catch (e) { onFlash(`草稿生成失败：${e.message}`); } finally { setBusy(false); } };
  const copy = async () => { try { await navigator.clipboard.writeText(draft); onFlash("回复草稿已复制"); } catch { onFlash("复制失败，请手动复制草稿"); } };
  return <div className="m2-modal-backdrop"><section className="m2-modal" role="dialog" aria-modal="true" aria-label="AI 回复草稿"><header><div><h2>AI 回复草稿</h2><p>{message.sender} · {message.subject}</p></div><button onClick={onClose} aria-label="关闭">×</button></header><div className="m2-tone">{[["formal", "正式简洁"], ["friendly", "温和友好"], ["action", "直接行动"]].map(([key, label]) => <button className={tone === key ? "is-active" : ""} onClick={() => generate(key)} disabled={busy} key={key}>{label}</button>)}</div><textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="点击下方按钮生成回复草稿" disabled={busy} /><footer><button className="m2-btn m2-btn--quiet" onClick={onClose}>关闭</button><button className="m2-btn m2-btn--quiet" onClick={() => generate()} disabled={busy}>{busy ? "生成中…" : "生成草稿"}</button><button className="m2-btn" onClick={copy} disabled={!draft || busy}><IconCopy size={16} />复制草稿</button></footer></section></div>;
}

export default function Emails2Page({ embedded = false, onStatusChange, onSyncReady }) {
  const nav = useNavigate();
  const [status, setStatus] = useState(null);
  const [data, setData] = useState({ action: [], informational: [], uncertain: [], archive: [] });
  const [view, setView] = useState("action");
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState(false);
  const [drafting, setDrafting] = useState(null);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const [consentAccepted, setConsentAccepted] = useState(false);

  const refresh = useCallback(async () => {
    const [nextStatus, action, informational, uncertain, archive] = await Promise.all([outlookApi.status(), outlookApi.todos(), outlookApi.informational(), outlookApi.uncertain(), outlookApi.archive()]);
    const next = nextStatus.data || nextStatus;
    setStatus(next);
    onStatusChange?.(next);
    setData({ action: action.items || [], informational: informational.items || [], uncertain: uncertain.items || [], archive: archive.items || [] });
  }, [onStatusChange]);
  useEffect(() => { refresh().catch((e) => setError(e.message)); }, [refresh]);
  useEffect(() => { const first = data[view]?.[0]?.id || null; setSelectedId((current) => data[view]?.some((m) => m.id === current) ? current : first); }, [data, view]);

  const visible = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return [...(data[view] || [])].filter((m) => !keyword || [m.sender, m.subject, m.summary, m.actionText].some((x) => String(x || "").toLowerCase().includes(keyword))).sort((a, b) => {
      const rank = { overdue: 0, today: 1, later: 2, none: 3 };
      const due = rank[dueInfo(a).tone] - rank[dueInfo(b).tone];
      if (due) return due;
      return ({ P0: 0, P1: 1, P2: 2 }[a.priority] ?? 3) - ({ P0: 0, P1: 1, P2: 2 }[b.priority] ?? 3);
    });
  }, [data, view, search]);
  const selected = visible.find((m) => m.id === selectedId) || data[view]?.find((m) => m.id === selectedId) || null;
  const action = data.action || [];
  const overdue = action.filter((m) => dueInfo(m).tone === "overdue").length;
  const today = action.filter((m) => dueInfo(m).tone === "today").length;
  const high = action.filter((m) => m.priority === "P0").length;
  const run = async (task) => { setPending(true); setError(""); try { await task(); await refresh(); } catch (e) { setError(e.message || "操作失败"); } finally { setPending(false); } };
  const sync = async () => { setSyncing(true); await run(outlookApi.sync); setSyncing(false); };
  useEffect(() => {
    if (!onSyncReady) return undefined;
    onSyncReady(sync);
    return () => onSyncReady(null);
  }, [onSyncReady, sync]);
  const convert = (m) => run(async () => { const r = await outlookApi.convert(m.id); setFlash(`已创建待办：${r.title}`); });
  const open = (m) => { if (m.webLink) window.open(m.webLink, "_blank", "noopener,noreferrer"); else window.open(`https://outlook.office.com/mail/search/${encodeURIComponent(`subject:${m.subject || ""}`)}`, "_blank", "noopener,noreferrer"); };
  const acceptConsent = () => run(async () => {
    await outlookApi.consent();
    setFlash("隐私确认已更新，邮件功能已恢复。");
  });
  if (error && !status) return <div className="error">加载失败：{error}</div>;
  if (!status) return <div className="spinner">加载中…</div>;
  if (!status.configured) return <div className="m2 m2-setup"><IconMail size={32}/><h1>邮件</h1><p>请先在设置中完成 Outlook 配置。</p><button className="m2-btn" onClick={() => nav("/settings")}>前往设置</button></div>;
  if (!status.consented && status.connected) return <div className="m2 m2-setup m2-consent"><IconShieldLock size={32}/><h1>重新确认邮件隐私告知</h1><p>当前 Outlook 已连接。由于 AI 内容生成来源已切换为“{status.modelProvider || "已配置来源"}”，需要重新确认后才能继续查看和处理邮件。</p><ul><li>邮件分类与回复草稿会按当前 AI 路由策略处理；分类结果保存在本机。</li><li>应用仅使用 Mail.Read 权限，不会修改 Outlook 邮箱。</li></ul><label className="m2-consent__check"><input type="checkbox" checked={consentAccepted} onChange={(event) => setConsentAccepted(event.target.checked)} />我已了解并同意上述处理方式。</label>{error ? <div className="error">{error}</div> : null}<button className="m2-btn" type="button" disabled={!consentAccepted || pending} onClick={acceptConsent}>{pending ? "确认中…" : "确认并继续使用邮件"}</button></div>;
  if (!status.connected) return <div className="m2 m2-setup"><IconMail size={32}/><h1>连接 Outlook</h1><p>Outlook 已配置，但尚未完成授权。请前往设置完成连接。</p><button className="m2-btn" onClick={() => nav("/settings")}>前往设置</button></div>;

  return <div className="m2">
    {!embedded && <header className="m2-header"><div><h1>邮件</h1><p>集中处理需要行动的邮件</p></div><div className="m2-header__actions"><span className="m2-sync"><i />已连接 · {status.lastSyncAt ? "数据已同步" : "等待同步"}</span><button className="m2-btn" onClick={sync} disabled={syncing || pending}><IconRefresh size={16} className={syncing ? "m2-spin" : ""}/>{syncing ? "同步中…" : "立即同步"}</button></div></header>}
    <div className="m2-kpis"><Kpi icon={<IconMail size={21}/>} label="待处理" value={action.length} detail="需要你行动的邮件"/><Kpi icon={<IconAlertTriangle size={21}/>} label="P0 高优先级" value={high} detail="需要立即处理" tone="danger"/><Kpi icon={<IconCalendarDue size={21}/>} label="今天截止" value={today} detail={overdue ? `${overdue} 封已逾期` : "暂无逾期邮件"} tone="warn"/><Kpi icon={<IconUserQuestion size={21}/>} label="AI 待确认" value={data.uncertain.length} detail="建议你确认分类" tone="purple"/></div>
    {flash && <div className="m2-flash" onAnimationEnd={() => setFlash("")}>{flash}</div>}{error && <div className="error">{error}</div>}
    <div className="m2-workspace"><section className="m2-queue"><div className="m2-search"><IconSearch size={18}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索邮件" aria-label="搜索邮件" /></div><div className="m2-tabs">{Object.entries(queues).map(([key, item]) => <button key={key} onClick={() => setView(key)} className={view === key ? "is-active" : ""}>{item.label}<span>{data[key].length}</span></button>)}</div><div className="m2-list-head"><span>优先级</span><span>发件人</span><span>邮件主题</span><span>时间 / 截止</span></div><div className="m2-list">{visible.map((m) => { const due = dueInfo(m); return <button key={m.id} className={`m2-row ${selected?.id === m.id ? "is-selected" : ""}`} onClick={() => setSelectedId(m.id)}><span className={`m2-priority ${m.priority ? `m2-priority--${m.priority.toLowerCase()}` : ""}`}>{m.priority || "—"}</span><span className="m2-row__sender">{m.sender || "未知发件人"}</span><span className="m2-row__subject">{m.subject || "（无主题）"}</span><span className={`m2-row__due m2-row__due--${due.tone}`}><b>{due.tone === "overdue" ? <IconAlertTriangle size={14}/> : due.tone === "today" ? <IconClock size={14}/> : null}{due.label}</b><small>{receivedAt(m)}</small></span></button>; })}{!visible.length && <div className="m2-empty">{queues[view].empty}</div>}</div><section className="m2-ai"><span><IconSparkles size={20}/></span><div><strong>AI 建议</strong><p>{high ? `共识别到 ${high} 封 P0 邮件，建议优先处理今天到期或已逾期的事项。` : data.uncertain.length ? `还有 ${data.uncertain.length} 封邮件等待人工确认，请先完成分类，再按截止时间处理行动队列。` : "当前没有 P0 高优先级邮件，可按截止时间处理队列。"}</p></div></section></section>
      <aside className="m2-detail">{selected ? <><div className="m2-detail__meta"><span className={`m2-priority m2-priority--${(selected.priority || "P2").toLowerCase()}`}>{selected.priority || "P2"}</span><span>{selected.queue === "action" ? "需要行动" : queues[selected.queue]?.label}</span></div><h2>{selected.subject || "（无主题）"}</h2><p className="m2-detail__from">{selected.sender || "未知发件人"} · {receivedAt(selected)}</p><hr/><h3><IconSparkles size={18}/>AI 行动建议</h3><div className="m2-recommend"><strong>{selected.actionText || "请阅读邮件并确认下一步"}</strong><p>{selected.priorityReason || "AI 已依据邮件内容和截止时间完成分类。"}</p></div><h3><IconFileText size={18}/>邮件摘要</h3><p className="m2-summary">{selected.bodyText || selected.summary || "暂无可展示的邮件正文摘要。"}</p>{selected.dueAt && <div className="m2-deadline"><IconCalendarDue size={17}/><div><span>截止时间</span><strong>{dueInfo(selected).detail}</strong></div></div>}<div className="m2-detail__actions">{selected.queue === "uncertain" && <><button className="m2-btn" disabled={pending} onClick={()=>run(()=>outlookApi.correct(selected.id,{queue:"action"}))}>设为需要行动</button><button className="m2-btn m2-btn--quiet" disabled={pending} onClick={()=>run(()=>outlookApi.correct(selected.id,{queue:"informational"}))}>设为仅供知晓</button></>}{selected.queue === "action" && selected.status === "open" && <button className="m2-btn" disabled={pending} onClick={() => convert(selected)}><IconListCheck size={16}/>转为待办</button>}{selected.queue === "action" && selected.status === "open" && <button className="m2-btn m2-btn--quiet" onClick={() => setDrafting(selected)}><IconSparkles size={16}/>生成回复草稿</button>}<button className="m2-btn m2-btn--quiet" onClick={() => open(selected)}><IconArrowUpRight size={16}/>打开原邮件</button>{selected.status === "open" && <button className="m2-text-btn" onClick={() => run(() => outlookApi.setStatus(selected.id, selected.queue === "action" ? "ignored" : "processed"))}><IconCheck size={15}/>{selected.queue === "action" ? "标为无需处理" : "标记已处理"}</button>}</div></> : <div className="m2-detail__empty"><IconMail size={32}/><p>从左侧选择一封邮件查看详情</p></div>}</aside></div>
    {drafting && <DraftModal message={drafting} onClose={() => setDrafting(null)} onFlash={setFlash}/>}</div>;
}
