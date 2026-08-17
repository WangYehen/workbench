import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconShieldCheck,
  IconMail,
  IconUsers,
  IconListCheck,
  IconRefresh,
  IconThumbUp,
  IconThumbDown,
  IconCalendarEvent,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { api, todayStr } from "../api.js";
import DateNav from "../components/DateNav.jsx";
import "./Overview2Page.css";

/* ================= 派生统计（纯函数，沿用原数据流） ================= */

function projectStats(items) {
  const total = items.length;
  const count = (s) => items.filter((p) => p.status === s).length;
  const stats = {
    total,
    normal: count("normal"),
    at_risk: count("at_risk"),
    review: count("review"),
    overdue: count("overdue"),
    done: count("done"),
    avgProgress: total ? Math.round(items.reduce((s, p) => s + (p.progress || 0), 0) / total) : 0,
  };
  const safe = stats.normal + stats.done;
  stats.healthyPct = total ? Math.round((safe / total) * 100) : 100;
  return stats;
}

function mailStats(emails) {
  const total = emails.length;
  const high = emails.filter((e) => e.importance === "high").length;
  return { total, high, normal: total - high };
}

function logStats(load) {
  const submitted = load?.summary?.submitted || 0;
  const notSubmitted = load?.summary?.notSubmitted || 0;
  const risk = load?.summary?.risk || 0;
  const total = submitted + notSubmitted;
  return { submitted, notSubmitted, risk, total, rate: total ? Math.round((submitted / total) * 100) : 0 };
}

function todoStats(items) {
  const total = items.length;
  const done = items.filter((t) => t.status === "done").length;
  const open = total - done;
  const p1Open = items.filter((t) => t.status !== "done" && t.priority === "P1").length;
  return { total, done, open, p1Open, rate: total ? Math.round((done / total) * 100) : 0 };
}

/* ================= 展示工具 ================= */

function nowHHMM() {
  return new Date().toTimeString().slice(0, 5);
}

function greeting() {
  const h = new Date().getHours();
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function fmtDateCn(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${y}年${m}月${d}日 ${WEEK[dt.getDay()]}`;
}

function meetingStatus(m, dateStr) {
  if (dateStr !== todayStr()) return "已排期";
  const toMin = (s) => {
    const [h, mm] = String(s).split(":").map(Number);
    return h * 60 + (mm || 0);
  };
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const s = toMin(m.start);
  const e = m.end ? toMin(m.end) : s + 60;
  if (nowMin > e) return "已结束";
  if (nowMin >= s) return "进行中";
  return "即将开始";
}

const STATUS_PILL = {
  已结束: "done",
  进行中: "live",
  即将开始: "soon",
  已排期: "sched",
};

/* ================= 小组件 ================= */

function Kpi({ label, icon, num, sub, subTone }) {
  return (
    <section className="oc-kpi">
      <div className="oc-kpi__top">
        <span className="oc-kpi__label">{label}</span>
        <span className="oc-kpi__ic">{icon}</span>
      </div>
      <div className="oc-kpi__num">{num}</div>
      <div className="oc-kpi__sub">
        <span className={`oc-dot oc-dot--${subTone}`} />
        {sub}
      </div>
    </section>
  );
}

// AI 建议：深色 dominant 区，带反馈与重新生成（数据来自 /overview/suggestion）
function SuggestionBand({ risks, p0 }) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    api.get("/overview/suggestion")
      .then((r) => active && setText(r.suggestion))
      .catch(() => active && setText(""))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);
  async function regenerate(fb) {
    setLoading(true);
    try {
      const r = await api.get(`/overview/suggestion?force=1${fb ? `&feedback=${fb}` : ""}`);
      setText(r.suggestion);
    } catch { /* 忽略 */ } finally { setLoading(false); }
  }
  const chips = [];
  if (risks.length) chips.push(`${risks.length} 个风险项目待跟进`);
  if (p0) chips.push(`优先处理 ${p0} 封 P0 邮件`);
  if (!chips.length) chips.push("今日节奏平稳");
  return (
    <section className="oc-ai">
      <div className="oc-ai__head">
        <div className="oc-ai__titlewrap">
          <span className="oc-ai__spark">AI</span>
          <span className="oc-ai__title">AI 今日工作建议</span>
        </div>
        <div className="oc-ai__actions">
          <button className="oc-ai__regen" title="这条建议不错" onClick={() => regenerate("good")} disabled={loading}>
            <IconThumbUp size={15} stroke={1.75} />
          </button>
          <button className="oc-ai__regen" title="换一条" onClick={() => regenerate("bad")} disabled={loading}>
            <IconThumbDown size={15} stroke={1.75} />
          </button>
          <button className="oc-ai__regen" title="重新生成" onClick={() => regenerate()} disabled={loading}>
            <IconRefresh size={15} stroke={1.75} className={loading ? "oc-spin" : ""} />
          </button>
        </div>
      </div>
      <p className="oc-ai__body">{loading ? "正在生成今日建议…" : text || "暂时无法生成建议。"}</p>
      <div className="oc-ai__tags">
        {chips.map((c, i) => <span className="oc-chip" key={i}>{c}</span>)}
        <span className="oc-ai__link" onClick={() => navigate("/review")}>查看完整建议 →</span>
      </div>
    </section>
  );
}

/* ================= 主页面 ================= */

export default function Overview2Page() {
  const [date, setDate] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncedAt, setSyncedAt] = useState("");
  const navigate = useNavigate();

  // 并行加载概览 / 项目 / 团队负载 / 待办四路数据
  useEffect(() => {
    let active = true;
    const q = date ? `?date=${date}` : "";
    Promise.all([
      api.get("/overview" + q),
      api.get("/projects"),
      api.get("/team/load" + q),
      api.get("/todos"),
    ])
      .then(([ov, proj, load, todos]) => {
        if (!active) return;
        setData({ ov, projects: proj.items, load, todos: todos.items, date: ov.date });
        if (!date) setDate(ov.date);
        setSyncedAt(nowHHMM());
      })
      .catch((e) => active && setErr(e.message));
    return () => { active = false; };
  }, [date, refreshKey]);

  if (err) return <div className="error">加载失败：{err}</div>;
  if (!data) return <div className="spinner">加载中…</div>;

  const { ov, projects, load, todos } = data;
  const proj = projectStats(projects);
  const mail = mailStats(ov.pendingEmails);
  const log = logStats(load);
  const todo = todoStats(todos);
  const risks = ov.riskProjects || [];
  const p0 = mail.high;

  // 勾选待办：本地乐观更新 + 写回后端
  async function toggleTodo(t) {
    const next = t.status === "done" ? "inbox" : "done";
    setData((d) => ({ ...d, todos: d.todos.map((x) => (x.id === t.id ? { ...x, status: next } : x)) }));
    try { await api.patch(`/todos/${t.id}`, { status: next }); } catch { /* 忽略 */ }
  }

  const meetingPills = ov.meetings.length
    ? ov.meetings.slice(0, 5).map((m) => {
        const st = meetingStatus(m, data.date);
        return (
          <div className="oc-meet-row" key={m.id}>
            <span className="oc-meet-time">{m.start}</span>
            <div className="oc-meet-main">
              <div className="oc-meet-title">{m.title}</div>
              <div className="oc-meet-sub">{[m.organizer, m.location].filter(Boolean).join(" · ") || "—"}</div>
            </div>
            <span className={`oc-pill oc-pill--${STATUS_PILL[st] || "sched"}`}>{st}</span>
          </div>
        );
      })
    : <div className="oc-empty"><IconCalendarEvent size={20} stroke={1.5} /> 当日无会议安排。</div>;

  const mailRows = ov.pendingEmails.length
    ? [...ov.pendingEmails]
        .sort((a, b) => (b.importance === "high") - (a.importance === "high"))
        .slice(0, 5)
        .map((e) => (
          <div className="oc-row" key={e.id} style={{ cursor: "pointer" }} onClick={() => navigate("/emails")}>
            <span className={`oc-tag ${e.importance === "high" ? "oc-tag--p0" : "oc-tag--p1"}`}>
              {e.importance === "high" ? "P0" : "P1"}
            </span>
            <div className="oc-row__main">
              <div className="oc-row__title">{e.subject}</div>
              <div className="oc-row__sub">{e.sender}</div>
            </div>
          </div>
        ))
    : <div className="oc-empty"><IconMail size={20} stroke={1.5} /> 收件箱已清空，无待处理邮件。</div>;

  const riskRows = risks.length
    ? risks.map((p) => {
        const danger = p.status === "overdue";
        const color = danger ? "var(--oc-danger)" : "var(--oc-warn)";
        return (
          <div className="oc-risk-row" key={p.id}>
            <span className="oc-risk-dot" style={{ background: color }} />
            <div className="oc-risk-main">
              <div className="oc-risk-name">{p.name}</div>
              <div className="oc-risk-sub">{p.owner} · 进度 {p.progress}%</div>
            </div>
            <span className="oc-risk-status" style={{ color }}>{p.statusLabel}</span>
          </div>
        );
      })
    : <div className="oc-empty"><IconAlertTriangle size={20} stroke={1.5} /> 所有项目状态健康，无风险信号。</div>;

  const todoRows = todos.length
    ? todos.slice(0, 5).map((t) => (
        <div className="oc-todo-row" key={t.id}>
          <span className={`oc-check ${t.status === "done" ? "oc-check--done" : ""}`} onClick={() => toggleTodo(t)}>
            {t.status === "done" ? "✓" : ""}
          </span>
          <span className={`oc-todo-txt ${t.status === "done" ? "oc-todo-txt--done" : ""}`}>{t.title}</span>
          {t.priority === "P0" && <span className="oc-tag oc-tag--p0">P0</span>}
          {t.priority === "P1" && t.status !== "done" && <span className="oc-tag oc-tag--p1">P1</span>}
        </div>
      ))
    : <div className="oc-empty">暂无待办事项。</div>;

  return (
    <div className="oc">
      <header className="oc-header">
        <div className="oc-header__left">
          <div className="oc-greet">{greeting()}，Charles</div>
          <div className="oc-date">{fmtDateCn(data.date)} · 今日团队态势一览</div>
        </div>
        <div className="oc-actions">
          <DateNav date={date} onChange={setDate} className="oc-datenav" />
          <span className="oc-syncchip"><span className="oc-syncdot" />已同步 {syncedAt || "—"}</span>
          <button className="oc-btn" onClick={() => setRefreshKey((k) => k + 1)}>
            <IconRefresh size={15} stroke={1.75} /> 立即同步
          </button>
          <span className="oc-avatar">Char</span>
        </div>
      </header>

      <div className="oc-kpis">
        <Kpi
          label="项目健康度"
          icon={<IconShieldCheck size={18} stroke={1.75} />}
          num={`${proj.healthyPct}%`}
          subTone="ok"
          sub={`${proj.normal} 正常 · ${proj.at_risk + proj.overdue} 风险`}
        />
        <Kpi
          label="邮件负载"
          icon={<IconMail size={18} stroke={1.75} />}
          num={`${mail.total}`}
          subTone={mail.high ? "danger" : "muted"}
          sub={mail.high ? `${mail.high} 封 P0 待处理` : "无高优先邮件"}
        />
        <Kpi
          label="日志提交率"
          icon={<IconUsers size={18} stroke={1.75} />}
          num={`${log.rate}%`}
          subTone={log.notSubmitted ? "warn" : "muted"}
          sub={`${log.notSubmitted} 人未提交`}
        />
        <Kpi
          label="待办完成率"
          icon={<IconListCheck size={18} stroke={1.75} />}
          num={`${todo.rate}%`}
          subTone="muted"
          sub={`${todo.done} / ${todo.total} 已完成`}
        />
      </div>

      <SuggestionBand risks={risks} p0={p0} />

      <div className="oc-grid">
        <div className="oc-col">
          <section className="oc-card">
            <div className="oc-card__head">
              <span className="oc-card__title">今日会议</span>
              <span className="oc-card__count">{ov.meetings.length} 场</span>
            </div>
            <div className="oc-meet-list">{meetingPills}</div>
            <button className="oc-card__link" style={{ marginTop: 12 }} onClick={() => navigate("/calendar")}>查看日历 →</button>
          </section>

          <section className="oc-card">
            <div className="oc-card__head">
              <span className="oc-card__title">待处理邮件</span>
              <button className="oc-card__link" onClick={() => navigate("/emails")}>查看全部 {mail.total} 封 →</button>
            </div>
            <div className="oc-list">{mailRows}</div>
          </section>
        </div>

        <div className="oc-col">
          <section className="oc-card">
            <div className="oc-card__head">
              <span className="oc-card__title">风险雷达</span>
              <button className="oc-card__link" onClick={() => navigate("/projects")}>全部项目 →</button>
            </div>
            <div className="oc-risk-list">{riskRows}</div>
          </section>

          <section className="oc-card">
            <div className="oc-card__head">
              <span className="oc-card__title">团队信号</span>
              <button className="oc-card__link" onClick={() => navigate("/team-load")}>负载详情 →</button>
            </div>
            <div className="oc-signals">
              <div className="oc-signal">
                <span className="oc-signal__num" style={{ color: "var(--oc-danger)" }}>{ov.teamBlockers.length}</span>
                <span className="oc-signal__lab">阻塞</span>
              </div>
              <div className="oc-signal">
                <span className="oc-signal__num" style={{ color: "var(--oc-warn)" }}>{ov.needReview.length}</span>
                <span className="oc-signal__lab">待审</span>
              </div>
              <div className="oc-signal">
                <span className="oc-signal__num" style={{ color: "var(--oc-muted)" }}>{ov.notSubmitted.length}</span>
                <span className="oc-signal__lab">未提交</span>
              </div>
            </div>
          </section>

          <section className="oc-card">
            <div className="oc-card__head">
              <span className="oc-card__title">今日待办</span>
              <button className="oc-card__link" onClick={() => navigate("/todos")}>去处理 →</button>
            </div>
            <div className="oc-todo-list">{todoRows}</div>
          </section>
        </div>
      </div>
    </div>
  );
}
