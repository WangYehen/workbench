import { useEffect, useState } from "react";
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

  async function load() {
    const d = await api.get("/todos");
    setItems(d.items);
  }
  useEffect(() => { load(); }, []);

  async function add() {
    if (!title.trim()) return;
    await api.post("/todos", { title, priority, due_date: due });
    setTitle(""); setDue(""); setShowAdd(false); setVisibleCount(5); load();
  }
  async function toggle(t) {
    await api.patch(`/todos/${t.id}`, { status: t.status === "done" ? "inbox" : "done" });
    load();
  }
  async function del(id) { await api.del(`/todos/${id}`); load(); }

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
        description="手动添加个人待办任务"
      />

      <div className="panel">
        <div className="panel__head">
          <div className="panel__title"><span className="work-page-icon"><IconListCheck size={22} stroke={1.75} /></span>待办列表</div>
          <div className="row"><span className="meta">{items.length} 项</span><button className="btn primary sm" onClick={() => setShowAdd(true)}><IconPlus size={15} />添加待办</button></div>
        </div>
        <div className="list">
          {visibleItems.map((t) => (
            <div className="item todo-item" key={t.id}>
              <input type="checkbox" checked={t.status === "done"} onChange={() => toggle(t)} style={{ width: 18 }} />
              <PriorityBadge priority={t.priority} className="todo-priority" />
              <div style={{ flex: 1 }}>
                <div className={`title todo-title ${t.status === "done" ? "is-done" : ""}`}>{t.title}</div>
                {t.due_date && <div className="sub">截止 {t.due_date}</div>}
              </div>
              <DeleteButton onClick={() => del(t.id)} />
            </div>
          ))}
          {!items.length && <div className="empty">还没有待办，添加一条吧</div>}
        </div>
        {visibleCount < sortedItems.length && <button className="todo-load-more" onClick={() => setVisibleCount((count) => count + 5)}>查看更多（还有 {sortedItems.length - visibleCount} 条）</button>}
      </div>
      {showAdd && <div className="todo-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setShowAdd(false)}><div className="todo-modal" role="dialog" aria-modal="true" aria-labelledby="todo-add-title"><div className="todo-modal__head"><h2 id="todo-add-title"><IconChecklist size={20} />添加待办</h2><button className="todo-modal__close" onClick={() => setShowAdd(false)} aria-label="关闭"><IconX size={20} /></button></div><input autoFocus placeholder="待办内容…" value={title} onChange={(e) => setTitle(e.target.value)} /><div className="todo-modal__fields"><select value={priority} onChange={(e) => setPriority(e.target.value)} className="select-priority" data-priority={priority}>{PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select><DatePicker value={due} onChange={setDue} /></div><div className="todo-modal__actions"><button className="btn" onClick={() => setShowAdd(false)}>取消</button><button className="btn primary" onClick={add}>添加</button></div></div></div>}
    </div>
  );
}
