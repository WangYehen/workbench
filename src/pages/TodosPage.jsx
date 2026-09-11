import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import {
  IconAlertTriangle,
  IconCalendar,
  IconChecklist,
  IconChecks,
  IconCircleCheck,
  IconClock,
  IconListCheck,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { DatePicker } from "../components/DatePicker";
import { api } from "../api.js";
import { PriorityBadge } from "../components/PriorityBadge";
import { DeleteButton } from "../components/DeleteButton";
import EmptyState from "../components/EmptyState.jsx";

// 优先级配置（统一语义）
const PRIORITY_OPTIONS = [
  { value: "P0", label: "P0 — 紧急", class: "p0" },
  { value: "P1", label: "P1 — 重要", class: "p1" },
  { value: "P2", label: "P2 — 普通", class: "p2" },
];
function priorityClass(p) { return { P0: "p0", P1: "p1", P2: "p2" }[p] || "p2"; }
function priorityRank(p) { return { P0: 0, P1: 1, P2: 2 }[p] ?? 2; }

// 来源翻译：manual / email / dingtalk / agent / 其他
const SOURCE_LABEL = {
  manual: "手动创建",
  email: "邮件转",
  mail: "邮件转",
  dingtalk: "钉钉同步",
  agent: "Agent 创建",
  outlook: "邮件转",
  meeting: "会议生成",
};
function sourceLabel(t) {
  if (t.source_type && SOURCE_LABEL[t.source_type]) return SOURCE_LABEL[t.source_type];
  // 未标 source_type 但有 external_task_id 说明是同步过来的
  if (!t.source_type && t.external_task_id) return "钉钉同步";
  return "手动创建";
}

// 创建时间渲染：今天 / 昨天 / MM-dd
function createdLabel(iso, todayStr, yesterdayStr) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const key = iso.slice(0, 10);
  const time = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (key === todayStr) return `今天 ${time}`;
  if (key === yesterdayStr) return `昨天 ${time}`;
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

// 截止时间渲染：已逾期 / 今天 / 未来 / 无
function dueLabel(iso, todayStr) {
  if (!iso) return { tone: "none", text: "无截止" };
  const key = String(iso).slice(0, 10);
  if (key < todayStr) return { tone: "overdue", text: `已逾期 ${iso.slice(5)}` };
  if (key === todayStr) return { tone: "today", text: "今天截止" };
  return { tone: "upcoming", text: `${iso.slice(5)} 截止` };
}

function groupTodos(items, todayStr) {
  const open = [];
  const done = [];
  for (const t of items) (t.status === "done" ? done : open).push(t);

  const byDue = (a, b) => {
    const dueDiff = String(a.due_date || "9999-99-99").localeCompare(String(b.due_date || "9999-99-99"));
    if (dueDiff) return dueDiff;
    return priorityRank(a.priority) - priorityRank(b.priority);
  };
  const byPriority = (a, b) => {
    const dueDiff = String(a.due_date || "9999-99-99").localeCompare(String(b.due_date || "9999-99-99"));
    if (dueDiff) return dueDiff;
    return priorityRank(a.priority) - priorityRank(b.priority);
  };

  const overdue = open.filter((t) => t.due_date && String(t.due_date).slice(0, 10) < todayStr).sort(byDue);
  const today = open.filter((t) => t.due_date && String(t.due_date).slice(0, 10) === todayStr).sort(byDue);
  const upcoming = open.filter((t) => t.due_date && String(t.due_date).slice(0, 10) > todayStr).sort(byDue);
  const noDue = open.filter((t) => !t.due_date).sort(byPriority);
  const doneSorted = [...done].sort((a, b) => String(b.completed_at || "").localeCompare(String(a.completed_at || "")));

  return { overdue, today, upcoming, noDue, done: doneSorted };
}

const PRIORITY_FILTERS = [
  { value: "all", label: "全部优先级" },
  { value: "P0", label: "P0" },
  { value: "P1", label: "P1" },
  { value: "P2", label: "P2" },
];

const STATUS_FILTERS = [
  { value: "open", label: "未完成" },
  { value: "done", label: "已完成" },
  { value: "all", label: "全部" },
];

export default function TodosPage() {
  const [items, setItems] = useState(null);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("P1");
  const [due, setDue] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [visibleCount, setVisibleCount] = useState(10);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [syncingId, setSyncingId] = useState(null);
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");
  const [selected, setSelected] = useState(() => new Set());
  const [batchWorking, setBatchWorking] = useState(false);
  const requestId = useRef(null);
  const savingRef = useRef(false);

  async function load() {
    const d = await api.get("/todos");
    setItems(d.items);
    // 清理已不存在的 selected
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(d.items.map((t) => t.id));
      const next = new Set();
      for (const id of prev) if (alive.has(id)) next.add(id);
      return next;
    });
  }
  useEffect(() => { load(); }, []);

  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  async function add() {
    if (!title.trim() || savingRef.current) return;
    savingRef.current = true; setSaving(true); setNotice("");
    requestId.current ||= crypto.randomUUID();
    try {
      const result = await api.post("/todos", { title, priority, due_date: due, requestId: requestId.current });
      setNotice(result.verified ? "待办已创建，并已同步到钉钉。" : `工作台已保存，钉钉尚未同步成功：${result.error || "请查看同步状态"}`);
      requestId.current = null;
      setTitle(""); setDue(""); setShowAdd(false); setVisibleCount(10); await load();
    } catch (error) { setNotice(error.message); }
    finally { savingRef.current = false; setSaving(false); }
  }
  async function toggle(t) {
    setSyncingId(t.id); setNotice("");
    try {
      const result = await api.patch(`/todos/${t.id}`, { status: t.status === "done" ? "inbox" : "done" });
      setNotice(result.verified === false ? `工作台状态已更新，钉钉同步待核验：${result.error || "请稍后重试"}` : "待办状态已同步到钉钉。");
      await load();
    } catch (error) { setNotice(`工作台状态同步失败：${error.message}`); await load(); }
    finally { setSyncingId(null); }
  }
  async function del(id) { await api.del(`/todos/${id}`); load(); }
  async function verify(id) {
    try {
      const result = await api.post(`/todos/${id}/verify`, {});
      setNotice(result.verified ? "已核验并同步钉钉待办。" : result.error);
      await load();
    } catch (error) { setNotice(error.message); }
  }

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function clearSelection() { setSelected(new Set()); }
  async function batchDone() {
    if (selected.size === 0 || batchWorking) return;
    setBatchWorking(true); setNotice("");
    try {
      for (const id of selected) {
        await api.patch(`/todos/${id}`, { status: "done" });
      }
      setNotice(`已将 ${selected.size} 项标记完成。`);
      setSelected(new Set());
      await load();
    } catch (error) { setNotice(`批量完成失败：${error.message}`); }
    finally { setBatchWorking(false); }
  }
  async function batchDelete() {
    if (selected.size === 0 || batchWorking) return;
    if (!confirm(`确认删除选中的 ${selected.size} 项待办？此操作不可撤销。`)) return;
    setBatchWorking(true); setNotice("");
    try {
      for (const id of selected) {
        await api.del(`/todos/${id}`);
      }
      setNotice(`已删除 ${selected.size} 项。`);
      setSelected(new Set());
      await load();
    } catch (error) { setNotice(`批量删除失败：${error.message}`); }
    finally { setBatchWorking(false); }
  }

  const groups = useMemo(() => groupTodos(items || [], todayStr), [items, todayStr]);

  // 应用筛选
  function applyFilter(list) {
    if (priorityFilter === "all") return list;
    return list.filter((t) => t.priority === priorityFilter);
  }
  const filteredOpen = useMemo(
    () => ({
      overdue: applyFilter(groups.overdue),
      today: applyFilter(groups.today),
      upcoming: applyFilter(groups.upcoming),
      noDue: applyFilter(groups.noDue),
    }),
    [groups, priorityFilter],
  );
  const filteredDone = useMemo(() => applyFilter(groups.done), [groups, priorityFilter]);

  // 当前展示的分组列表（按状态筛选过滤）
  const visibleSections = useMemo(() => {
    if (statusFilter === "done") return [{ key: "done", title: "已完成", tone: "done", items: filteredDone }];
    if (statusFilter === "all") {
      return [
        { key: "overdue", title: "已逾期", tone: "overdue", items: filteredOpen.overdue },
        { key: "today", title: "今日截止", tone: "today", items: filteredOpen.today },
        { key: "upcoming", title: "未来截止", tone: "upcoming", items: filteredOpen.upcoming },
        { key: "noDue", title: "未设截止", tone: "noDue", items: filteredOpen.noDue },
        { key: "done", title: "已完成", tone: "done", items: filteredDone },
      ];
    }
    return [
      { key: "overdue", title: "已逾期", tone: "overdue", items: filteredOpen.overdue },
      { key: "today", title: "今日截止", tone: "today", items: filteredOpen.today },
      { key: "upcoming", title: "未来截止", tone: "upcoming", items: filteredOpen.upcoming },
      { key: "noDue", title: "未设截止", tone: "noDue", items: filteredOpen.noDue },
    ];
  }, [statusFilter, filteredOpen, filteredDone]);

  const totalOpen = items ? items.filter((t) => t.status !== "done").length : 0;
  const totalDone = items ? items.length - totalOpen : 0;
  const totalShown = visibleSections.reduce((acc, s) => acc + s.items.length, 0);
  const showLoadMore = statusFilter === "all" && visibleCount < totalShown;

  const visibleIds = useMemo(
    () => new Set(visibleSections.flatMap((s) => s.items.map((t) => t.id))),
    [visibleSections],
  );
  const selectedVisibleCount = useMemo(
    () => [...selected].filter((id) => visibleIds.has(id)).length,
    [selected, visibleIds],
  );
  const allVisibleSelected = selectedVisibleCount === visibleIds.size && visibleIds.size > 0;
  function selectAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) next.add(id);
      return next;
    });
  }
  function clearSelection() { setSelected(new Set()); }

  if (!items) return <div className="spinner">加载中…</div>;

  function renderItem(t) {
    const due = dueLabel(t.due_date, todayStr);
    const created = createdLabel(t.created_at, todayStr, yesterday);
    const source = sourceLabel(t);
    const checked = t.status === "done";
    const busy = syncingId === t.id;
    return (
      <div className={`item todo-item todo-item--${due.tone} ${checked ? "is-done" : ""} ${selected.has(t.id) ? "is-selected" : ""}`} key={t.id}>
      <input
        type="checkbox"
        className="todo-complete-checkbox"
        checked={checked}
        disabled={busy}
        onChange={() => toggle(t)}
        aria-label={`${checked ? "恢复为待处理" : "完成"}待办：${t.title}`}
        style={{ width: 18 }}
      />
      <PriorityBadge priority={t.priority} className="todo-priority" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={`title todo-title ${checked ? "is-done" : ""}`}>{t.title}</div>
          <div className="todo-meta">
            <span className={`todo-meta__due todo-meta__due--${due.tone}`}>
              {due.tone === "overdue" ? <IconAlertTriangle size={13} /> : <IconCalendar size={13} />}
              {due.text}
            </span>
            <span className="todo-meta__src" title={`来源：${source}`}>
              {source}
            </span>
            {created && <span className="todo-meta__created"><IconClock size={13} />{created}</span>}
            {t.sync_status && <span className={`todo-meta__sync todo-meta__sync--${t.sync_status}`} title={t.sync_error || ""}>
              {t.sync_status === "synced" ? "已同步钉钉" : t.sync_status === "pending" ? "正在同步钉钉" : `钉钉待核验 · ${t.sync_error || "请检查同步结果"}`}
            </span>}
            {busy && <span className="todo-meta__busy">正在同步状态…</span>}
          </div>
        </div>
        {!checked && t.external_task_id && t.sync_status !== "synced" && (
          <button className="btn sm" onClick={() => verify(t.id)} aria-label={`重新核验待办：${t.title}`}>
            <IconRefresh size={14} />核验
          </button>
        )}
        <DeleteButton onClick={() => del(t.id)} aria-label={`删除待办：${t.title}`} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="TODOS / TODAY"
        title="今日待办"
        description="新建待办将自动同步到钉钉，Agent 创建的待办也会显示在这里"
      />

      {notice && <p role="status" className="todo-notice">{notice}</p>}

      {/* 筛选条 */}
      <div className="todo-filters" role="toolbar" aria-label="待办筛选">
        <div className="todo-filters__group">
          <span className="todo-filters__label">状态</span>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`todo-filter-chip ${statusFilter === f.value ? "is-active" : ""}`}
              onClick={() => { setStatusFilter(f.value); setVisibleCount(10); }}
              aria-pressed={statusFilter === f.value}
            >
              {f.label}
              <span className="todo-filter-chip__count">
                {f.value === "open" ? totalOpen : f.value === "done" ? totalDone : (totalOpen + totalDone)}
              </span>
            </button>
          ))}
        </div>
        <div className="todo-filters__group">
          <span className="todo-filters__label">优先级</span>
          {PRIORITY_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`todo-filter-chip todo-filter-chip--${f.value} ${priorityFilter === f.value ? "is-active" : ""}`}
              onClick={() => setPriorityFilter(f.value)}
              aria-pressed={priorityFilter === f.value}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* 批量操作条 */}
      {visibleIds.size > 0 && (
        <div className="todo-batch-bar" role="region" aria-label="批量操作">
          {selected.size === 0 ? (
            <div className="todo-batch-bar__start">
              <button type="button" className="btn sm todo-batch-bar__select" onClick={selectAllVisible}>
                <IconChecks size={14} />全选当前列表（{visibleIds.size} 项）
              </button>
            </div>
          ) : (
            <>
              <span>已选 <b>{selectedVisibleCount}</b> 项</span>
              <div className="todo-batch-bar__actions">
                <button type="button" className="btn sm todo-batch-bar__select" disabled={allVisibleSelected} onClick={selectAllVisible}>
                  <IconChecks size={14} />全选当前列表
                </button>
                <button type="button" className="btn sm" disabled={batchWorking} onClick={batchDone}>
                  <IconChecks size={14} />批量完成
                </button>
                <button type="button" className="btn sm todo-batch-bar__delete" disabled={batchWorking} onClick={batchDelete}>
                  <IconTrash size={14} />批量删除
                </button>
                <button type="button" className="btn sm" disabled={batchWorking} onClick={clearSelection}>
                  <IconX size={14} />清除选择
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="panel">
        <div className="panel__head">
          <div className="panel__title">
            <span className="work-page-icon"><IconListCheck size={22} stroke={1.75} /></span>
            待办列表
          </div>
          <div className="row">
            <span className="meta">{items.length} 项 · 未完成 {totalOpen}</span>
            <button className="btn primary sm" onClick={() => setShowAdd(true)}>
              <IconPlus size={15} />添加待办
            </button>
          </div>
        </div>

        {totalShown === 0 && (
          <EmptyState
            icon={IconListCheck}
            minHeight={220}
            title={statusFilter === "done" ? "暂无已完成的待办" : priorityFilter !== "all" ? `当前筛选下暂无 ${priorityFilter} 待办` : "暂无待办事项"}
          />
        )}

        {visibleSections.map((section) => {
          if (!section.items.length) return null;
          if (section.tone === "done") {
            return (
              <section key={section.key} className={`todo-section todo-section--done`} aria-labelledby={`todo-h-${section.key}`}>
                <header className="todo-section__head">
                  <button
                    type="button"
                    className="todo-section__toggle"
                    onClick={() => setShowDone((v) => !v)}
                    aria-expanded={showDone}
                    aria-controls={`todo-list-${section.key}`}
                  >
                    <IconCircleCheck size={16} />
                    <h3 id={`todo-h-${section.key}`}>{section.title}</h3>
                    <span className="todo-section__count">{section.items.length}</span>
                  </button>
                </header>
                {showDone && (
                  <div id={`todo-list-${section.key}`} className="list" role="list">
                    {section.items.map(renderItem)}
                  </div>
                )}
              </section>
            );
          }
          return (
            <section
              key={section.key}
              className={`todo-section todo-section--${section.tone}`}
              aria-labelledby={`todo-h-${section.key}`}
            >
              <header className="todo-section__head">
                <h3 id={`todo-h-${section.key}`}>
                  {section.tone === "overdue" ? <IconAlertTriangle size={16} /> : <IconCalendar size={16} />}
                  {section.title}
                </h3>
                <span className="todo-section__count">{section.items.length}</span>
              </header>
              <div id={`todo-list-${section.key}`} className="list" role="list">
                {section.items.map(renderItem)}
              </div>
            </section>
          );
        })}

        {showLoadMore && (
          <button className="todo-load-more" onClick={() => setVisibleCount((count) => count + 10)}>
            查看更多（还有 {totalShown - visibleCount} 条）
          </button>
        )}
      </div>

      {showAdd && (
        <div className="todo-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="todo-modal" role="dialog" aria-modal="true" aria-labelledby="todo-add-title">
            <div className="todo-modal__head">
              <h2 id="todo-add-title"><IconChecklist size={20} />添加待办</h2>
              <button className="todo-modal__close" onClick={() => setShowAdd(false)} aria-label="关闭添加待办"><IconX size={20} /></button>
            </div>
            <input autoFocus placeholder="待办内容…" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="待办内容" />
            <div className="todo-modal__fields">
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className="select-priority" data-priority={priority} aria-label="优先级">
                {PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <DatePicker value={due} onChange={setDue} />
            </div>
            <div className="todo-modal__actions">
              <button className="btn" onClick={() => setShowAdd(false)}>取消</button>
              <button className="btn primary" disabled={saving || !title.trim()} onClick={add}>
                {saving ? "正在创建并同步…" : "添加并同步钉钉"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
