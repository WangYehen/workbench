import { useEffect, useState } from "react";
import { IconChecklist, IconListCheck } from "@tabler/icons-react";
import { api } from "../api.js";

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
      <div className="page-head"><div><h1>今日待办</h1><div className="sub">手动添加个人待办任务</div></div></div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel__head">
          <div className="panel__title"><span className="work-page-icon"><IconChecklist size={22} stroke={1.75} /></span>添加待办</div>
        </div>
        <div className="row wrap">
          <input placeholder="待办内容…" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 2, minWidth: 220 }} />
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ width: 90 }}>
            <option>P0</option><option>P1</option><option>P2</option>
          </select>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} style={{ width: 150 }} />
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
              <span className={`pill ${t.priority === "P0" ? "red" : t.priority === "P1" ? "amber" : "blue"}`}>{t.priority}</span>
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
