import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { IconRoute, IconFolderPlus, IconCalendarPlus, IconChartBar, IconTrash, IconX } from "@tabler/icons-react";
import { DeleteButton } from "../components/DeleteButton";
import { api } from "../api.js";
import { StatusPill } from "../lib/project-status.jsx";
import { DatePicker } from "../components/DatePicker.jsx";
import "./ProjectsPage.css";

const PHASE_ORDER = ["需求评审", "产品设计", "开发", "测试", "上线"];

function fmtMD(d) {
  const x = new Date(d);
  return `${x.getMonth() + 1}/${x.getDate()}`;
}

function Roadmap({ projects }) {
  const allPhases = projects.flatMap((p) => p.phases || []);
  if (!allPhases.length) return <div className="empty">还没有项目时间线，先在下方添加项目与阶段</div>;

  // 时间范围（用时间戳计算，避免 Date 被 Math.min 转成数字后丢失方法）
  const times = allPhases.flatMap((p) => [
    new Date(p.start_date).getTime(),
    new Date(p.end_date).getTime(),
  ]);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const span = Math.max(1, maxTime - minTime);
  // 两侧各留 4% 余量，避免阶段条贴边
  const PAD = 0.04;
  const pct = (d) => {
    const t = new Date(d).getTime();
    return PAD * 100 + ((t - minTime) / span) * (100 - PAD * 200);
  };

  const minDate = new Date(minTime);
  const maxDate = new Date(maxTime);

  // 月份刻度
  const months = [];
  let cur = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
  while (cur <= maxDate) {
    months.push(new Date(cur));
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }

  // 今日标线位置（可能不在范围内）
  const today = new Date();
  const todayInside = today >= minDate && today <= maxDate;
  const todayPct = todayInside ? pct(today) : null;

  return (
    <div className="roadmap">
      <div className="roadmap-track" style={{ paddingTop: 8 }}>
        {/* 月份刻度行 */}
        <div style={{ position: "relative", height: 18, marginBottom: 6 }}>
          {months.map((m, i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                left: `${pct(new Date(m.getFullYear(), m.getMonth(), 1))}%`,
                fontSize: 11,
                color: "var(--ink-faint)",
                fontFamily: "var(--font-mono)",
                transform: "translateX(0%)",
                whiteSpace: "nowrap",
              }}
            >
              {m.getFullYear() % 100}/{String(m.getMonth() + 1).padStart(2, "0")}
            </span>
          ))}
        </div>

        {/* 今日标线 */}
        {todayPct !== null && (
          <div className="roadmap-today" style={{ left: `${todayPct}%` }}>
            <span>今天</span>
          </div>
        )}

        {projects.map((p) => (
          <div key={p.id} style={{ marginBottom: 26 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span>{p.name}</span> <span className="meta">· {p.owner}</span>
              <StatusPill status={p.status} />
            </div>
            <div style={{ position: "relative", height: 30 }}>
              {[...p.phases].sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase)).map((ph) => {
                const left = pct(ph.start_date);
                const width = Math.max(4, pct(ph.end_date) - left);
                const idx = PHASE_ORDER.indexOf(ph.phase);
                return (
                  <div
                    key={ph.id}
                    className={`phase-bar phase-${idx >= 0 ? idx + 1 : "x"}`}
                    title={`${ph.phase} ${ph.start_date} ~ ${ph.end_date}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  >
                    <span className="phase-bar__label">{ph.phase}</span>
                    <span className="phase-bar__date">{fmtMD(ph.start_date)}–{fmtMD(ph.end_date)}</span>
                  </div>
                );
              })}
            </div>
            <div className="progress" style={{ marginTop: 8 }}>
              <span style={{ width: `${p.progress}%` }}></span>
            </div>
            <div className="meta" style={{ marginTop: 4 }}>进度 {p.progress}%</div>
          </div>
        ))}

        <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink-faint)", fontSize: 12, marginTop: 4 }}>
          <span>{minDate.toISOString().slice(0, 10)}</span>
          <span>{maxDate.toISOString().slice(0, 10)}</span>
        </div>
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState(null);
  const [name, setName] = useState("");
  const [pid, setPid] = useState("");
  const [phase, setPhase] = useState("需求评审");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [editing, setEditing] = useState(null); // 正在编辑进度的项目 id
  const [editVal, setEditVal] = useState(0);
  const [dragTip, setDragTip] = useState(null);
  const [modal, setModal] = useState(null);

  async function load() { setProjects((await api.get("/projects")).items); }
  useEffect(() => { load(); }, []);

  async function addProject() {
    if (!name.trim()) return;
    await api.post("/projects", { name });
    setName(""); load();
  }
  async function addPhase() {
    if (!pid || !start || !end) return false;
    await api.post(`/projects/${pid}/phases`, { phase, start_date: start, end_date: end });
    setStart(""); setEnd(""); load(); return true;
  }
  async function delProject(id) { await api.del(`/projects/${id}`); load(); }
  function openEdit(p) { setEditing(p.id); setEditVal(p.progress); }
  async function saveProgress() {
    await api.patch(`/projects/${editing}`, { progress: Number(editVal) });
    setEditing(null); load();
  }
  function dragProgress(p, event) {
    const bar = event.currentTarget;
    const update = (clientX) => {
      const rect = bar.getBoundingClientRect();
      const value = Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * 100);
      setDragTip({ id: p.id, value, x: clientX, y: rect.top });
      return value;
    };
    update(event.clientX);
    bar.setPointerCapture?.(event.pointerId);
    const move = (e) => update(e.clientX);
    const end = async (e) => {
      bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerup", end); bar.removeEventListener("pointercancel", end);
      bar.releasePointerCapture?.(e.pointerId);
      const rect = bar.getBoundingClientRect();
      const value = Math.round(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * 100);
      await api.patch(`/projects/${p.id}`, { progress: value });
      setDragTip(null); load();
    };
    bar.addEventListener("pointermove", move); bar.addEventListener("pointerup", end); bar.addEventListener("pointercancel", end);
  }
  function wheelProgress(p, event) {
    event.preventDefault();
    const current = editing === p.id ? Number(editVal) : Number(p.progress) || 0;
    setEditing(p.id);
    setEditVal(Math.max(0, Math.min(100, current + (event.deltaY < 0 ? 1 : -1))));
  }
  function closeModal() { setModal(null); setEditing(null); }

  if (!projects) return <div className="spinner">加载中…</div>;

  const riskCount = projects.filter((p) => p.status === "at_risk" || p.status === "overdue").length;

  return (
    <div>
      <PageHeader
        eyebrow="PROJECTS / ROADMAP"
        title="项目时间线"
        description="需求评审 → 产品设计 → 开发 → 测试 → 上线，一目了然"
      />

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel__head">
          <div className="panel__title"><span className="work-page-icon"><IconRoute size={22} stroke={1.75} /></span>项目时间线</div>
          <div className="project-timeline__actions">
            <span className="meta">{projects.length} 个项目{riskCount ? ` · ${riskCount} 风险` : ""}</span>
            <button className="btn sm" type="button" onClick={() => setModal("projects")}><IconFolderPlus size={15} />项目管理</button>
            <button className="btn primary sm" type="button" onClick={() => setModal("phase")}><IconCalendarPlus size={15} />添加阶段</button>
          </div>
        </div>
        <Roadmap projects={projects} />
        <div className="legend">
          {PHASE_ORDER.map((p, i) => (
            <span key={p}><i className={`phase-bar phase-${i + 1}`} style={{ borderRadius: 4 }} />{p}</span>
          ))}
        </div>
      </div>

      {modal === "projects" && <div className="project-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && closeModal()}>
        <section className="project-modal project-modal--projects" role="dialog" aria-modal="true" aria-labelledby="project-manage-title">
          <div className="panel__head">
            <div><div className="panel__title" id="project-manage-title"><span className="work-page-icon"><IconFolderPlus size={22} stroke={1.75} /></span>项目管理</div><p className="project-modal__sub">新建项目、查看进度或调整项目状态。</p></div>
            <button className="project-modal__close" type="button" onClick={closeModal} aria-label="关闭项目管理"><IconX size={20} /></button>
          </div>
          <label>新建项目</label>
          <div className="row">
            <input placeholder="项目名称" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
            <button className="btn primary" onClick={addProject}>添加</button>
          </div>
          <label style={{ marginTop: 14 }}>项目列表</label>
          <div className="list">
            {projects.map((p) => (
              <div className="item" key={p.id}>
                <span className="pill blue">{p.phases.length} 阶段</span>
                <div style={{ flex: 1 }}>
                  <div className="title" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {p.name} <StatusPill status={p.status} />
                  </div>
                  <div className="sub">{p.note}</div>
                  <div className="progress project-progress-bar" style={{ marginTop: 8 }} role="slider" aria-label={`拖动设置${p.name}进度`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={editing === p.id ? editVal : p.progress} onPointerDown={(event) => dragProgress(p, event)} onWheel={(event) => wheelProgress(p, event)}>
                    <span style={{ width: `${dragTip?.id === p.id ? dragTip.value : p.progress}%` }}></span>
                    {dragTip?.id === p.id && <span className="project-progress-tooltip" style={{ left: `${dragTip.value}%` }}>{dragTip.value}%</span>}
                  </div>
                  <div className="meta" style={{ marginTop: 4 }}>进度 {p.progress}%</div>
                </div>
                <div className="row project-actions" style={{ flexDirection: "column", gap: 6 }}>
                  {editing === p.id ? (
                    <>
                      <input className="project-progress-input" type="number" min="0" max="100" value={editVal} onChange={(e) => setEditVal(e.target.value)} aria-label={`输入${p.name}进度`} />
                      <button className="btn primary sm" onClick={saveProgress}>保存</button>
                      <button className="btn sm" onClick={() => setEditing(null)}>取消</button>
                    </>
                  ) : (
                    <button className="btn sm" onClick={() => openEdit(p)}>设进度</button>
                  )}
                  <DeleteButton className="project-delete" onClick={() => delProject(p.id)} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>}

      {modal === "phase" && <div className="project-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && closeModal()}>
        <section className="project-modal project-modal--phase" role="dialog" aria-modal="true" aria-labelledby="phase-add-title">
          <div className="panel__head">
            <div><div className="panel__title" id="phase-add-title"><span className="work-page-icon"><IconCalendarPlus size={22} stroke={1.75} /></span>添加阶段</div><p className="project-modal__sub">为项目补充一个新的时间线阶段。</p></div>
            <button className="project-modal__close" type="button" onClick={closeModal} aria-label="关闭添加阶段"><IconX size={20} /></button>
          </div>
          <label>选择项目</label>
          <select value={pid} onChange={(e) => setPid(e.target.value)}>
            <option value="">—</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label>阶段类型</label>
          <select value={phase} onChange={(e) => setPhase(e.target.value)}>
            {PHASE_ORDER.map((p) => <option key={p}>{p}</option>)}
          </select>
          <div className="row project-date-fields">
            <div className="project-date-field"><label>开始日期</label><DatePicker value={start} onChange={setStart} placeholder="选择开始日期" /></div>
            <div className="project-date-field"><label>结束日期</label><DatePicker value={end} onChange={setEnd} placeholder="选择结束日期" /></div>
          </div>
          <div className="project-modal__footer"><button className="btn" type="button" onClick={closeModal}>取消</button><button className="btn primary" type="button" onClick={async () => { if (await addPhase()) closeModal(); }}>添加阶段</button></div>
          <div className="panel__title" style={{ fontSize: 15, marginTop: 18 }}>
            <span className="work-page-icon" style={{ width: 34, height: 34 }}><IconChartBar size={18} stroke={1.75} /></span>进度说明
          </div>
          <div className="meta">进度可手动在「设进度」中填写（0–100）；状态（正常 / 有风险 / 审核中 / 已逾期 / 待验收）由系统根据进度与阶段截止日自动推算。</div>
        </section>
      </div>}
    </div>
  );
}
