import { useEffect, useRef, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { IconChecklist, IconListCheck, IconPlus, IconX } from "@tabler/icons-react";
import { DatePicker } from "../components/DatePicker";
import { api } from "../api.js";
import { PriorityBadge } from "../components/PriorityBadge";
import { DeleteButton } from "../components/DeleteButton";

// 优先级配置（统一语义）
const PRIORITY_OPTIONS = [
  { value: "P0", label: "P0 — 紧急", class: "p0" },
  { value: "P1", label: "P1 — 重要", class: "p1" },
  { value: "P2", label: "P2 — 普通", class: "p2" },
];
function priorityClass(p) { return { P0: "p0", P1: "p1", P2: "p2" }[p] || "p2"; }

export default function TodosPage() {
  const [items, setItems] = useState(null);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("P1");
  const [due, setDue] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [visibleCount, setVisibleCount] = useState(5);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [syncingId, setSyncingId] = useState(null);
  const requestId = useRef(null);
  const savingRef = useRef(false);

  async function load() {
    const d = await api.get("/todos");
    setItems(d.items);
  }
  useEffect(() => { load(); }, []);

  async function add() {
    if (!title.trim() || savingRef.current) return;
    savingRef.current = true; setSaving(true); setNotice("");
    requestId.current ||= crypto.randomUUID();
    try {
      const result = await api.post("/todos", { title, priority, due_date: due, requestId: requestId.current });
      setNotice(result.verified ? "待办已创建，并已同步到钉钉。" : `工作台已保存，钉钉尚未同步成功：${result.error || "请查看同步状态"}`);
      requestId.current = null;
      setTitle(""); setDue(""); setShowAdd(false); setVisibleCount(5); await load();
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

  if (!items) return <div className="spinner">加载中…</div>;

  const priorityRank = { P0: 0, P1: 1, P2: 2 };
  const sortedItems = [...items].sort((a, b) => {
    const status = Number(a.status === "done") - Number(b.status === "done");
    if (status) return status;
    const dueDiff = String(b.due_date || "").localeCompare(String(a.due_date || ""));
    if (dueDiff) return dueDiff;
    return (priorityRank[a.priority] ?? 2) - (priorityRank[b.priority] ?? 2);
  });
  const visibleItems = sortedItems.slice(0, visibleCount);

  return (
    <div>
      <PageHeader
        eyebrow="TODOS / TODAY"
        title="今日待办"
        description="新建待办将自动同步到钉钉，Agent 创建的待办也会显示在这里"
      />

      {notice && <p role="status">{notice}</p>}
      <div className="panel">
        <div className="panel__head">
          <div className="panel__title"><span className="work-page-icon"><IconListCheck size={22} stroke={1.75} /></span>待办列表</div>
          <div className="row"><span className="meta">{items.length} 项</span><button className="btn primary sm" onClick={() => setShowAdd(true)}><IconPlus size={15} />添加待办</button></div>
        </div>
        <div className="list">
          {visibleItems.map((t) => (
            <div className="item todo-item" key={t.id}>
              <input type="checkbox" checked={t.status === "done"} disabled={syncingId === t.id} onChange={() => toggle(t)} style={{ width: 18 }} />
              <PriorityBadge priority={t.priority} className="todo-priority" />
              <div style={{ flex: 1 }}>
                <div className={`title todo-title ${t.status === "done" ? "is-done" : ""}`}>{t.title}</div>
                {t.due_date && <div className="sub">截止 {t.due_date}</div>}
                {t.sync_status && <div className="sub" title={t.sync_error || ""}>{t.sync_status === "synced" ? "已同步钉钉" : t.sync_status === "pending" ? "正在同步钉钉" : `钉钉待核验 · ${t.sync_error || "请检查同步结果"}`}</div>}
                {syncingId === t.id && <div className="sub">正在同步状态…</div>}
              </div>
              <DeleteButton onClick={() => del(t.id)} />
              {t.external_task_id && t.sync_status !== "synced" && <button className="btn sm" onClick={() => verify(t.id)}>重新核验</button>}
            </div>
          ))}
          {!items.length && <div className="empty">还没有待办，添加一条吧</div>}
        </div>
        {visibleCount < sortedItems.length && <button className="todo-load-more" onClick={() => setVisibleCount((count) => count + 5)}>查看更多（还有 {sortedItems.length - visibleCount} 条）</button>}
      </div>
      {showAdd && <div className="todo-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setShowAdd(false)}><div className="todo-modal" role="dialog" aria-modal="true" aria-labelledby="todo-add-title"><div className="todo-modal__head"><h2 id="todo-add-title"><IconChecklist size={20} />添加待办</h2><button className="todo-modal__close" onClick={() => setShowAdd(false)} aria-label="关闭"><IconX size={20} /></button></div><input autoFocus placeholder="待办内容…" value={title} onChange={(e) => setTitle(e.target.value)} /><div className="todo-modal__fields"><select value={priority} onChange={(e) => setPriority(e.target.value)} className="select-priority" data-priority={priority}>{PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select><DatePicker value={due} onChange={setDue} /></div><div className="todo-modal__actions"><button className="btn" onClick={() => setShowAdd(false)}>取消</button><button className="btn primary" disabled={saving || !title.trim()} onClick={add}>{saving ? "正在创建并同步…" : "添加并同步钉钉"}</button></div></div></div>}
    </div>
  );
}
