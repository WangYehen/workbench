import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconCheck, IconDownload, IconListCheck, IconRefresh, IconSearch, IconSparkles, IconX,
} from "@tabler/icons-react";
import { dingtalkChatApi, todayStr, workbenchApi } from "../api.js";
import SyncButton from "../components/SyncButton.jsx";
import "./Emails2Page.css";
import "./Emails2PageFixes.css";
import "./DingtalkMessagesPage.css";

const STATUS_TEXT = {
  new: "待处理", needs_confirmation: "AI待确认", task_created: "已建待办",
  informational: "仅供知晓", processed: "已处理", ignored: "已忽略",
};
const STATUS_CLASS = { new: "new", needs_confirmation: "needs_confirmation", task_created: "task_created", informational: "informational" };
const FILTERS = [
  ["", "全部"],
  ["new", "待处理"],
  ["needs_confirmation", "AI待确认"],
  ["task_created", "已建待办"],
  ["linked", "已关联"],
  ["informational", "仅供知晓"],
  ["ignored", "已过滤"],
];
const TARGET_TEXT = { outlook: "邮件", calendar: "日程", project: "项目", todo: "待办" };
const LINK_STATE = { auto: "自动关联", suggested: "建议", confirmed: "已确认", rejected: "已拒绝" };
const LINK_CLASS = { auto: "auto", confirmed: "confirmed", rejected: "rejected" };

function countFor(counts, filter) {
  if (!counts) return "";
  if (filter === "") return counts.total;
  if (filter === "linked") return counts.linked;
  return counts[filter] ?? 0;
}

function attachmentLabel(item) {
  if (item.name) return item.name;
  const ref = (() => { try { return JSON.parse(item.ref_json)?.ref; } catch { return null; } })();
  return `${item.kind || "资源"}${typeof ref === "string" && ref ? ` · ${ref.slice(0, 18)}…` : ""}`;
}

export default function DingtalkMessagesPage({ embedded = false, onStatusChange, onSyncReady, onSyncingChange }) {
  const [status, setStatus] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [messages, setMessages] = useState([]);
  const [counts, setCounts] = useState(null);
  const [selected, setSelected] = useState(null);
  const [active, setActive] = useState("");
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [includeBots, setIncludeBots] = useState(false);
  const [showBots, setShowBots] = useState(false);
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState(null);
  const reloadRef = useRef(null);

  // 目录与设置页共用会话启停状态；停用群仍保留消息数据，但不再出现在行动中心目录。
  const activeConversations = useMemo(() => conversations.filter((item) =>
    (item.type !== "group" || item.enabled) && item.message_count > 0 && item.open_count > 0,
  ), [conversations]);
  const human = useMemo(() => activeConversations.filter((item) => !item.is_bot), [activeConversations]);
  const bots = useMemo(() => activeConversations.filter((item) => item.is_bot), [activeConversations]);
  const groupedMessages = useMemo(() => {
    if (active) return [{ key: active, title: "", items: messages }];
    const groups = new Map();
    messages.forEach((message) => {
      const key = message.conversation_id || message.conversation_title || "unknown";
      if (!groups.has(key)) groups.set(key, { key, title: message.conversation_title || "未知会话", items: [] });
      groups.get(key).items.push(message);
    });
    return [...groups.values()];
  }, [active, messages]);

  const load = useCallback(async () => {
    try {
      const [statusResult, conversationResult] = await Promise.all([
        dingtalkChatApi.status().catch(() => null),
        dingtalkChatApi.conversations().catch(() => ({ items: [] })),
      ]);
      setStatus(statusResult);
      onStatusChange?.(statusResult);
      setConversations(conversationResult.items || []);
      reloadRef.current?.();
    } catch (e) { setError(e.message); }
  }, [onStatusChange]);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const params = { limit: String(limit), includeBots: String(includeBots) };
      if (active) params.conversationId = active;
      if (filter) params.status = filter;
      if (query) params.q = query;
      const result = await dingtalkChatApi.messages(params);
      setMessages(result.items || []);
      setCounts(result.counts || null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [active, filter, includeBots, limit, query]);

  useEffect(() => { reloadRef.current = loadMessages; }, [loadMessages]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadMessages(); }, [loadMessages]);
  useEffect(() => {
    if (active && !activeConversations.some((item) => item.id === active)) setActive("");
  }, [active, activeConversations]);
  // 调试入口：URL ?select=<id> 自动打开详情，方便截图与单条回归。
  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get("select");
    if (target) detail(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const refreshSelected = useCallback(async (id) => {
    if (!id) return;
    try {
      const result = await dingtalkChatApi.message(id);
      setSelected(result.item);
      setDraft(result.item ? {
        title: result.item.draft_title ?? "",
        note: result.item.draft_note ?? "",
        priority: result.item.draft_priority ?? result.item.priority ?? "P2",
        dueDate: result.item.draft_due_date ?? result.item.due_date ?? "",
        rationale: result.item.draft_rationale ?? "",
      } : null);
    } catch { /* 详情可能已被清理 */ }
  }, []);

  const sync = useCallback(async () => {
    setSyncing(true); onSyncingChange?.(true); setError("");
    try {
      await workbenchApi.syncRun(todayStr(), ["dingtalk_chat"]);
      await load();
    } catch (e) { setError(e.message); }
    finally { setSyncing(false); onSyncingChange?.(false); }
  }, [load, onSyncingChange]);
  useEffect(() => {
    if (!onSyncReady) return undefined;
    onSyncReady(sync);
    return () => onSyncReady(null);
  }, [onSyncReady, sync]);

  async function act(key, fn, done) {
    setBusy(key); setError(""); setFlash("");
    try { const note = await fn(); if (done) await done(); setFlash(note || "已更新"); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  }

  const detail = (id) => refreshSelected(id);
  const createTodo = () => act("todo", async () => {
    const result = await dingtalkChatApi.createTodo(selected.id);
    return `已创建待办：${result.todo?.title || ""}`;
  }, async () => { await loadMessages(); await load(); await refreshSelected(selected.id); });
  // 生成待办草稿：AI 基于消息与上下文生成可编辑草稿（已生成过则直接返回缓存）。
  const generateDraft = () => act("draft", async () => {
    const result = await dingtalkChatApi.generateTodoDraft(selected.id);
    const item = result.item;
    setDraft({
      title: item.draft_title ?? "",
      note: item.draft_note ?? "",
      priority: item.draft_priority ?? item.priority ?? "P2",
      dueDate: item.draft_due_date ?? item.due_date ?? "",
      rationale: item.draft_rationale ?? "",
    });
    return result.cached ? "已读取缓存草稿" : "已生成待办草稿";
  }, () => refreshSelected(selected.id));
  // 确认创建待办：用用户编辑过的草稿写入待办，按消息幂等。
  const confirmDraft = () => act("confirm", async () => {
    if (!draft?.title?.trim()) { setError("请先填写待办标题"); return; }
    const result = await dingtalkChatApi.confirmTodoDraft(selected.id, {
      title: draft.title, note: draft.note, priority: draft.priority, dueDate: draft.dueDate || null, rationale: draft.rationale,
    });
    return result.created ? `已创建待办：${result.todo?.title || ""}` : `已存在待办：${result.todo?.title || ""}`;
  }, async () => { await loadMessages(); await load(); await refreshSelected(selected.id); });
  const setDraftField = (key, value) => setDraft((prev) => ({ ...(prev || {}), [key]: value }));
  const setMessageStatus = (processingStatus, note) => act(processingStatus, async () => {
    await dingtalkChatApi.updateMessage(selected.id, processingStatus);
    return note;
  }, async () => { await loadMessages(); await load(); await refreshSelected(selected.id); });
  const updateLink = (id, approved, label) => act(`link-${id}`, async () => {
    await (approved ? dingtalkChatApi.confirmLink(id) : dingtalkChatApi.rejectLink(id));
    return label;
  }, () => refreshSelected(selected.id));
  const downloadAttachment = (attachmentId) => act(`att-${attachmentId}`, async () => {
    const result = await dingtalkChatApi.downloadAttachment(selected.id, attachmentId);
    return `附件已保存：${result.attachment?.local_path || "本地数据目录"}`;
  }, () => refreshSelected(selected.id));

  const lastSync = status?.lastSync;
  const syncState = !lastSync ? null
    : lastSync.partial ? "partial"
      : lastSync.complete === false ? "partial" : "ok";

  return <div className="m2">
    {!embedded && <div className="m2-header"><div><h1>钉钉消息</h1><p>私聊完整上下文与群聊 @我 消息</p></div></div>}
    {!embedded && <div className="m2-detail__sync">
      <span className={`pill-dot ${syncState === "partial" ? "pill-dot--partial" : syncState === "ok" ? "" : "pill-dot--error"}`} />
      <span>
        {lastSync
          ? `${lastSync.partial ? "部分成功" : lastSync.complete === false ? "部分成功" : "同步完整"} · ${new Date(lastSync.finishedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
          : "尚未同步"}
        {lastSync?.conversations != null ? ` · ${lastSync.conversations} 个会话` : ""}
        {lastSync?.mentions != null ? ` · ${lastSync.mentions} 条 @我` : ""}
      </span>
      {lastSync?.problems?.length ? <span>· {lastSync.problems.length} 处不完整</span> : null}
      <SyncButton className="m2-btn m2-btn--quiet" style={{ marginLeft: "auto" }} onClick={sync} syncing={syncing}>立即同步</SyncButton>
    </div>}
    {error && <div className="error">{error}</div>}
    {flash && <div className="m2-flash m2-flash--sticky">{flash}</div>}

    <div className="m2-workspace m2-workspace--three">
      <section className="m2-queue">
        <div className="m2-toolbar">
          <span style={{ fontSize: 12, color: "var(--m2-soft)" }}>会话目录</span>
          <label style={{ marginLeft: "auto", fontSize: 12, color: "var(--m2-soft)", display: "flex", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={includeBots} onChange={(e) => setIncludeBots(e.target.checked)} style={{ width: "auto" }} />
            含机器人
          </label>
        </div>
        <div className="m2-dirs">
          <div className="m2-dir-section">
            <span>联系人与群（{human.length}）</span>
            <button className={`m2-dir ${!active ? "is-selected" : ""}`} onClick={() => setActive("")}>
              <span className="m2-dir__tag">全</span>
              <span className="m2-dir__name">全部会话</span>
              {counts?.total ? <span className={`m2-dir__count ${counts.total > 99 ? "m2-dir__count--quiet" : ""}`}>{counts.total > 99 ? "99+" : counts.total}</span> : null}
            </button>
            {human.map((c) => (
              <button className={`m2-dir ${active === c.id ? "is-selected" : ""}`} key={c.id} onClick={() => setActive(c.id)}>
                <span className={`m2-dir__tag ${c.type === "group" ? "m2-dir__tag--group" : ""}`}>{c.type === "group" ? "群" : "私"}</span>
                <span className="m2-dir__name" title={c.title}>{c.title}</span>
                {c.open_count > 0 && <span className="m2-dir__count">{c.open_count > 99 ? "99+" : c.open_count}</span>}
              </button>
            ))}
            {!human.length && !loading && <div className="m2-empty" style={{ padding: "18px 8px" }}>暂无待处理会话</div>}
          </div>
          {bots.length ? <div className="m2-dir-section">
            <span>机器人与通知（{bots.length}）</span>
            <button className="m2-dir" onClick={() => setShowBots(!showBots)}>
              <span className="m2-dir__tag m2-dir__tag--bot">器</span>
              <span className="m2-dir__name">{showBots ? "收起" : `默认降权，点击展开`}</span>
            </button>
            {showBots && bots.map((c) => (
              <button className={`m2-dir ${active === c.id ? "is-selected" : ""}`} key={c.id} onClick={() => setActive(c.id)}>
                <span className="m2-dir__tag m2-dir__tag--bot">群</span>
                <span className="m2-dir__name" title={c.title}>{c.title}</span>
                {c.open_count > 0 && <span className="m2-dir__count m2-dir__count--quiet">{c.open_count > 99 ? "99+" : c.open_count}</span>}
              </button>
            ))}
          </div> : null}
        </div>
      </section>

      <section className="m2-queue">
        <div className="m2-tabs m2-tabs--wrap">
          {FILTERS.map(([key, label]) => (
            <button key={key || "all"} className={filter === key ? "is-active" : ""} onClick={() => setFilter(key)}>
              {label}<span>{countFor(counts, key)}</span>
            </button>
          ))}
        </div>
        <div className="m2-search">
          <IconSearch size={18} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setQuery(search.trim()); }}
            placeholder="搜索消息内容或发送人，回车确认"
            aria-label="搜索钉钉消息"
          />
          {search ? <button className="m2-text-btn" onClick={() => { setSearch(""); setQuery(""); }} aria-label="清除搜索"><IconX size={13} /></button> : null}
        </div>
        <div className="m2-list">
          {groupedMessages.map((group) => <div className="m2-message-group" key={group.key}>
            {!active && <div className="m2-message-group__title">{group.title}</div>}
            {group.items.map((m) => (
            <button
              className={`m2-row m2-row--msg ${selected?.id === m.id ? "is-selected" : ""}`}
              key={m.id}
              onClick={() => detail(m.id)}
            >
              <span className={`m2-msg-row__status ${STATUS_CLASS[m.processing_status] || ""}`}>{STATUS_TEXT[m.processing_status] || m.processing_status}</span>
              <span className="m2-row__sender">
                {m.sender_name || "未知"}
                {!active && <span className="m2-msg-row__conv">{m.conversation_title}</span>}
              </span>
              <span className="m2-row__subject">{m.content || "（非文本消息）"}</span>
            </button>
            ))}
          </div>)}
          {!messages.length && !loading && <div className="m2-empty">该筛选下没有消息</div>}
        </div>
        {messages.length >= limit ? (
          <div className="m2-list__more">
            <button className="m2-btn m2-btn--quiet" onClick={() => setLimit(limit + 50)}>加载更多</button>
          </div>
        ) : null}
      </section>

      <aside className="m2-detail">
        {selected ? <>
          <div className="m2-detail__meta">
            <span>{selected.conversation_title}</span>
            <span>{selected.direction === "outbound" ? "我发出的" : selected.sender_name || "未知发送人"}</span>
            <span>{new Date(selected.sent_at).toLocaleString("zh-CN")}</span>
          </div>
          <p className="m2-summary">{selected.content || "（非文本消息）"}</p>

          <h3>AI 分析</h3>
          <div className="m2-recommend">
            <strong>{selected.action_text || selected.summary || "等待分析或无需行动"}</strong>
            <p>
              {selected.classification ? `分类 ${selected.classification === "action" ? "行动项" : selected.classification === "informational" ? "通知" : "待确认"}` : "尚未分析"}
              {selected.confidence != null ? ` · 置信度 ${selected.confidence}%` : ""}
              {selected.assignee_self ? " · 需要你处理" : ""}
              {selected.due_date ? ` · 截止 ${selected.due_date}` : ""}
              {selected.todo_id ? ` · 待办 ${selected.todo_id}` : ""}
            </p>
          </div>

          {selected.attachments?.length ? <>
            <h3>附件</h3>
            {selected.attachments.map((attachment) => (
              <div className="m2-attach" key={attachment.id}>
                <span className="m2-attach__name" title={attachmentLabel(attachment)}>{attachmentLabel(attachment)}</span>
                <span className="m2-attach__meta">
                  {attachment.downloaded_at ? "已下载" : attachment.download_error ? "下载失败" : "未下载"}
                </span>
                {attachment.local_path
                  ? <a className="btn sm" href={`file:///${String(attachment.local_path).replace(/\\/g, "/")}`} target="_blank" rel="noreferrer">查看</a>
                  : <button className="btn sm" disabled={busy === `att-${attachment.id}`} onClick={() => downloadAttachment(attachment.id)}>
                    {busy === `att-${attachment.id}` ? "下载中…" : <><IconDownload size={13} />下载</>}
                  </button>}
              </div>
            ))}
          </> : null}

          {selected.links?.length ? <>
            <h3>关联</h3>
            {selected.links.map((link) => (
              <div className="m2-link-row" key={link.id}>
                <span className="m2-link-row__target">{TARGET_TEXT[link.target_type] || link.target_type} · {link.target_id}</span>
                <span className={`m2-link-row__state ${LINK_CLASS[link.status] || ""}`}>{LINK_STATE[link.status] || link.status}</span>
                <span style={{ fontSize: 11, color: "var(--m2-soft)" }}>置信度 {link.confidence}%</span>
                {link.status === "suggested" && <>
                  <button className="btn sm" disabled={busy === `link-${link.id}`} onClick={() => updateLink(link.id, true, "已确认关联")}>确认</button>
                  <button className="btn sm" disabled={busy === `link-${link.id}`} onClick={() => updateLink(link.id, false, "已拒绝关联")}>拒绝</button>
                </>}
                {(link.status === "auto" || link.status === "confirmed") &&
                  <button className="btn sm" disabled={busy === `link-${link.id}`} onClick={() => updateLink(link.id, false, "已撤销关联")}>撤销</button>}
              </div>
            ))}
          </> : null}

          {selected.context?.length ? <>
            <h3>上下文</h3>
            <div className="m2-context">
              {selected.context.map((item) => (
                <p key={item.id} className={item.id === selected.id ? "is-root" : ""}>
                  <b>{item.sender_name || "成员"}</b>：{item.content || "（非文本消息）"}
                </p>
              ))}
            </div>
          </> : null}

          {selected.processing_status === "task_created" ? (
            <div className="m2-draft-form">
              <div className="m2-draft__done">已建待办（ID {selected.todo_id}）</div>
              {selected.todo_id ? <p className="m2-draft-created-note">该消息已关联待办，重复操作不会创建重复待办。</p> : null}
            </div>
          ) : (
            <>
              <h3>待办草稿</h3>
              {!(draft?.title) && !selected.draft_title ? (
                <div className="m2-draft-empty">
                  <p>尚未生成待办草稿。AI 将基于消息与会话上下文生成标题、说明、优先级、截止时间和依据。</p>
                  <button className="m2-btn" disabled={busy === "draft"} onClick={generateDraft}>
                    <IconSparkles size={16} />{busy === "draft" ? "生成中…" : "生成待办草稿"}
                  </button>
                </div>
              ) : (
                <div className="m2-draft-form">
                  <label>标题
                    <input value={draft?.title || ""} onChange={(e) => setDraftField("title", e.target.value)} placeholder="待办标题" />
                  </label>
                  <label>说明
                    <textarea rows={2} value={draft?.note || ""} onChange={(e) => setDraftField("note", e.target.value)} placeholder="可执行要点" />
                  </label>
                  <div className="m2-draft-row">
                    <label>优先级
                      <select value={draft?.priority || "P2"} onChange={(e) => setDraftField("priority", e.target.value)}>
                        <option value="P0">P0 紧急</option>
                        <option value="P1">P1 高</option>
                        <option value="P2">P2 普通</option>
                      </select>
                    </label>
                    <label>截止时间
                      <input type="date" value={draft?.dueDate || ""} onChange={(e) => setDraftField("dueDate", e.target.value)} />
                    </label>
                  </div>
                  <label>生成依据
                    <textarea rows={2} value={draft?.rationale || ""} onChange={(e) => setDraftField("rationale", e.target.value)} placeholder="为何需要处理" />
                  </label>
                  <div className="m2-draft-form__actions">
                    <button className="m2-btn" disabled={busy === "confirm"} onClick={confirmDraft}>
                      <IconListCheck size={16} />{busy === "confirm" ? "创建中…" : "确认创建待办"}
                    </button>
                    <button className="m2-btn m2-btn--quiet" disabled={busy === "draft"} onClick={generateDraft}>
                      <IconRefresh size={16} />重新生成
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          <div className="m2-detail__actions">
            {selected.processing_status !== "informational" && (
              <button className="m2-btn m2-btn--quiet" disabled={busy === "informational"} onClick={() => setMessageStatus("informational", "已标记为仅供知晓")}>
                <IconCheck size={16} />标记知晓
              </button>
            )}
            {selected.processing_status !== "ignored" && (
              <button className="m2-btn m2-btn--quiet" disabled={busy === "ignored"} onClick={() => setMessageStatus("ignored", "已忽略")}>
                <IconX size={16} />忽略
              </button>
            )}
          </div>
        </> : <div className="m2-detail__empty"><p>选择一条消息查看上下文和AI建议</p></div>}
      </aside>
    </div>
  </div>;
}
