import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { IconChecklist, IconListCheck } from "@tabler/icons-react";
import { DatePicker } from "../components/DatePicker";
import { api } from "../api.js";

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

  async function load() {
    const d = await api.get("/todos");
    setItems(d.items);
  }
  useEffect(() => { load(); }, []);

  async function add() {
    if (!title.trim()) return;
    await api.post("/todos", { title, priority, due_date: due });
    setTitle(""); setDue(""); load();
  }
  async function toggle(t) {
    await api.patch(`/todos/${t.id}`, { status: t.status === "done" ? "inbox" : "done" });
    load();
  }
  async function del(id) { await api.del(`/todos/${id}`); load(); }

  if (!items) return <div className="spinner">加载中…</div>;

  return (
    <div>
      <PageHeader
        eyebrow="TODOS / TODAY"
        title="今日待办"
        description="手动添加个人待办任务"
      />

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel__head">
          <div className="panel__title"><span className="work-page-icon"><IconChecklist size={22} stroke={1.75} /></span>添加待办</div>
        </div>
        <div className="row wrap">
          <input placeholder="待办内容…" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 2, minWidth: 220 }} />
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className="select-priority" data-priority={priority} style={{ width: 120 }}>
            {PRIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <DatePicker value={due} onChange={setDue} />
          <button className="btn primary" onClick={add}>添加</button>
        </div>
      </div>

      <div className="panel">
        <div className="panel__head">
          <div className="panel__title"><span className="work-page-icon"><IconListCheck size={22} stroke={1.75} /></span>待办列表</div>
          <span className="meta">{items.length} 项</span>
        </div>
        <div className="list">
          {items.map((t) => (
            <div className="item" key={t.id}>
              <input type="checkbox" checked={t.status === "done"} onChange={() => toggle(t)} style={{ width: 18 }} />
              <span className={`pill ${priorityClass(t.priority)}`}>{t.priority}</span>
              <div style={{ flex: 1 }}>
                <div className="title" style={{ textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</div>
                {t.due_date && <div className="sub">截止 {t.due_date}</div>}
              </div>
              <button className="btn sm" onClick={() => del(t.id)}>删除</button>
            </div>
          ))}
          {!items.length && <div className="empty">还没有待办，添加一条吧</div>}
        </div>
      </div>
    </div>
  );
}
