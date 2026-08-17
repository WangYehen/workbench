import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconMail,
  IconCalendarEvent,
  IconAlertTriangle,
  IconUserX,
  IconListCheck,
  IconSparkles,
  IconRefresh,
  IconThumbUp,
  IconThumbDown,
  IconShieldCheck,
  IconMapPin,
  IconVideo,
} from "@tabler/icons-react";
import { api } from "../api.js";
import DateNav from "../components/DateNav.jsx";

/* ================= 派生统计（纯函数） ================= */

// 项目状态分布统计：按状态分组计数，并计算健康占比与平均进度
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

// 邮件负载统计：高优先级 / 普通数量与占比
function mailStats(emails) {
  const total = emails.length;
  const high = emails.filter((e) => e.importance === "high").length;
  return { total, high, normal: total - high, highPct: total ? Math.round((high / total) * 100) : 0 };
}

// 日志提交统计：提交率、未提交人数、阻塞数
function logStats(load) {
  const submitted = load?.summary?.submitted || 0;
  const notSubmitted = load?.summary?.notSubmitted || 0;
  const risk = load?.summary?.risk || 0;
  const total = submitted + notSubmitted;
  return { submitted, notSubmitted, risk, total, rate: total ? Math.round((submitted / total) * 100) : 0 };
}

// 待办统计：完成率、进行中数量、P1 未完成数量
function todoStats(items) {
  const total = items.length;
  const done = items.filter((t) => t.status === "done").length;
  const open = total - done;
  const p1Open = items.filter((t) => t.status !== "done" && t.priority === "P1").length;
  return { total, done, open, p1Open, rate: total ? Math.round((done / total) * 100) : 0 };
}

/* ================= 通用可视化小组件 ================= */

// SVG 圆环：载入时描边从空到满平滑生长
function Ring({ pct, size = 96, stroke = 9, color = "var(--o2-teal)", children }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOn(true), 80);
    return () => clearTimeout(t);
  }, []);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="o2-ring">
      <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--o2-line)" strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none"
        strokeLinecap="round" strokeDasharray={c} strokeDashoffset={on ? off : c}
        transform={`rotate(-90 ${size / 2} ${size / 2})`} className="o2-ring__arc"
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" className="o2-ring__num">
        {children ?? `${Math.round(pct)}%`}
      </text>
    </svg>
  );
}

// 状态指示灯：LED 呼吸灯（正常绿 / 警示黄 / 危险红 / 信息紫）
function Led({ tone = "teal" }) {
  return <span className={`o2-led o2-led--${tone}`} aria-hidden="true" />;
}

// KPI 卡外壳：统一标签栏、右上角图标与载入动画
function KpiCard({ label, icon, tone = "teal", delay = 0, children }) {
  return (
    <section className="o2-kpi" style={{ animationDelay: `${delay}ms` }}>
      <div className="o2-kpi__bar">
        <span className="o2-kpi__label">{label}</span>
        <span className={`o2-kpi__icon o2-kpi__icon--${tone}`}>{icon}</span>
      </div>
      {children}
    </section>
  );
}

/* ================= 四个 KPI 卡片 ================= */

// 项目健康度：健康占比环 + 状态计数 + 平均进度条
function ProjectHealthCard({ stats, delay }) {
  const rows = [
    { label: "正常", n: stats.normal, tone: "teal" },
    { label: "有风险", n: stats.at_risk, tone: "amber" },
    { label: "已逾期", n: stats.overdue, tone: "rose" },
    { label: "待验收", n: stats.done + stats.review, tone: "violet" },
  ];
  return (
    <KpiCard label="PROJECT HEALTH / 项目健康度" icon={<IconShieldCheck size={18} stroke={1.75} />} tone="teal" delay={delay}>
      <div className="o2-kpi__body">
        <Ring pct={stats.healthyPct} size={92} color="var(--o2-teal)">{stats.healthyPct}%</Ring>
        <div className="o2-kpi__side">
          <div className="o2-kpi__stat">{stats.total}<span className="o2-kpi__unit">个项目</span></div>
          <div className="o2-kpi__leds">
            {rows.map((r) => (
              <span className="o2-kpi__led" key={r.label}>
                <Led tone={r.tone} />{r.label} {r.n}
              </span>
            ))}
          </div>
          <div className="o2-bar">
            <span className="o2-bar__label">平均进度</span>
            <span className="o2-bar__track"><span style={{ width: `${stats.avgProgress}%` }} /></span>
            <span className="o2-bar__num">{stats.avgProgress}%</span>
          </div>
        </div>
      </div>
    </KpiCard>
  );
}

// 邮件负载：高优先级大字 + 优先级堆积条
function MailLoadCard({ stats, delay }) {
  const highPct = stats.highPct;
  return (
    <KpiCard label="MAIL LOAD / 邮件负载" icon={<IconMail size={18} stroke={1.75} />} tone="amber" delay={delay}>
      <div className="o2-kpi__body o2-kpi__body--stack">
        <div className="o2-kpi__big">{stats.high}<span className="o2-kpi__unit">封高优先</span></div>
        <div className="o2-kpi__sub">共 {stats.total} 封待处理 · {stats.normal} 封普通</div>
        <div className="o2-stackbar" aria-label={`高优先级占比 ${highPct}%`}>
          <span className="o2-stackbar__high" style={{ width: `${highPct}%` }} />
          <span className="o2-stackbar__normal" style={{ width: `${100 - highPct}%` }} />
        </div>
        <div className="o2-stackbar__legend">
          <span><Led tone="amber" />高优先 {stats.high}</span>
          <span><Led tone="slate" />普通 {stats.normal}</span>
        </div>
      </div>
    </KpiCard>
  );
}

// 日志提交：提交率环 + 未提交 / 阻塞计数
function LogSubmitCard({ stats, delay }) {
  return (
    <KpiCard label="LOG SUBMIT / 日志提交" icon={<IconUserX size={18} stroke={1.75} />} tone="violet" delay={delay}>
      <div className="o2-kpi__body">
        <Ring pct={stats.rate} size={92} color="var(--o2-violet)">{stats.rate}%</Ring>
        <div className="o2-kpi__side">
          <div className="o2-kpi__stat">{stats.submitted}<span className="o2-kpi__unit">/ {stats.total} 已提交</span></div>
          <div className="o2-kpi__leds">
            <span className="o2-kpi__led"><Led tone="rose" />未提交 {stats.notSubmitted}</span>
            <span className="o2-kpi__led"><Led tone="amber" />有阻塞 {stats.risk}</span>
          </div>
          <div className="o2-bar">
            <span className="o2-bar__label">提交率</span>
            <span className="o2-bar__track"><span style={{ width: `${stats.rate}%` }} /></span>
            <span className="o2-bar__num">{stats.rate}%</span>
          </div>
        </div>
      </div>
    </KpiCard>
  );
}

// 今日待办：完成率环 + 进行中 / P1 计数
function TodoCard({ stats, delay }) {
  return (
    <KpiCard label="TODOS / 今日待办" icon={<IconListCheck size={18} stroke={1.75} />} tone="cyan" delay={delay}>
      <div className="o2-kpi__body">
        <Ring pct={stats.rate} size={92} color="var(--o2-cyan)">{stats.rate}%</Ring>
        <div className="o2-kpi__side">
          <div className="o2-kpi__stat">{stats.open}<span className="o2-kpi__unit">项未完成</span></div>
          <div className="o2-kpi__leds">
            <span className="o2-kpi__led"><Led tone="amber" />P1 {stats.p1Open}</span>
            <span className="o2-kpi__led"><Led tone="teal" />已完成 {stats.done}</span>
          </div>
          <div className="o2-bar">
            <span className="o2-bar__label">完成率</span>
            <span className="o2-bar__track"><span style={{ width: `${stats.rate}%` }} /></span>
            <span className="o2-bar__num">{stats.rate}%</span>
          </div>
        </div>
      </div>
    </KpiCard>
  );
}

/* ================= 第二行面板 ================= */

// 风险雷达：风险 / 逾期项目清单，带进度条与状态灯
function RiskPanel({ projects, delay, onViewAll }) {
  return (
    <section className="o2-panel" style={{ animationDelay: `${delay}ms` }}>
      <div className="o2-panel__head">
        <span className="o2-panel__title"><IconAlertTriangle size={16} stroke={1.75} />风险雷达 RADAR</span>
        <span className="o2-panel__tag o2-panel__tag--danger">{projects.length}</span>
      </div>
      {projects.length ? (
        <div className="o2-list">
          {projects.map((p) => (
            <div className="o2-row" key={p.id}>
              <Led tone={p.status === "overdue" ? "rose" : "amber"} />
              <div className="o2-row__main">
                <div className="o2-row__title">{p.name}</div>
                <div className="o2-row__sub">{p.owner} · {p.statusLabel}</div>
                <div className="o2-bar">
                  <span className="o2-bar__track"><span style={{ width: `${p.progress}%` }} /></span>
                  <span className="o2-bar__num">{p.progress}%</span>
                </div>
              </div>
            </div>
          ))}
          <button className="o2-link" onClick={onViewAll}>查看全部项目 →</button>
        </div>
      ) : (
        <div className="o2-empty">
          <IconShieldCheck size={22} stroke={1.5} />
          所有项目状态健康，无风险信号。
        </div>
      )}
    </section>
  );
}

// 时间轴工具：解析 "HH:MM" 为分钟数
function toMin(s) {
  if (!s) return 0;
  const [h, m] = String(s).split(":").map(Number);
  return h * 60 + (m || 0);
}

// 会议时间轴：横向 7:00–22:00 轨道，会议按时间定位为色块
function TimelinePanel({ meetings, delay, onViewCalendar }) {
  const DAY_START = 7 * 60;
  const DAY_END = 22 * 60;
  const RANGE = DAY_END - DAY_START;
  const hours = [8, 10, 12, 14, 16, 18, 20];
  const blocks = meetings.map((m) => {
    const start = toMin(m.start);
    const end = toMin(m.end) || start + 60;
    const left = Math.max(0, ((start - DAY_START) / RANGE) * 100);
    const width = Math.max(1.6, Math.min(((end - start) / RANGE) * 100, 100 - left));
    return { ...m, start, end, left, width };
  });
  return (
    <section className="o2-panel" style={{ animationDelay: `${delay}ms` }}>
      <div className="o2-panel__head">
        <span className="o2-panel__title"><IconCalendarEvent size={16} stroke={1.75} />会议时间轴 SCHEDULE</span>
        <span className="o2-panel__tag">{meetings.length} 场</span>
      </div>
      {meetings.length ? (
        <>
          <div className="o2-timeline">
            <div className="o2-timeline__ticks">
              {hours.map((h) => (
                <span key={h} style={{ left: `${((h * 60 - DAY_START) / RANGE) * 100}%` }}>{h}:00</span>
              ))}
            </div>
            <div className="o2-timeline__track">
              {blocks.map((m, i) => (
                <span
                  key={m.id || i}
                  className="o2-timeline__block"
                  style={{ left: `${m.left}%`, width: `${m.width}%` }}
                  title={`${m.start}–${m.end} ${m.title}`}
                />
              ))}
            </div>
          </div>
          <div className="o2-list o2-list--tight">
            {meetings.slice(0, 5).map((m, i) => (
              <div className="o2-row" key={m.id || i}>
                <span className="o2-row__time">{m.start}–{m.end}</span>
                <div className="o2-row__main">
                  <div className="o2-row__title">{m.title}</div>
                  {m.location && (
                    <div className="o2-row__sub">
                      {/^https?:\/\//i.test(m.location)
                        ? <><IconVideo size={12} stroke={1.75} /> 线上会议</>
                        : <><IconMapPin size={12} stroke={1.75} /> {m.location}</>}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <button className="o2-link" onClick={onViewCalendar}>查看日历 →</button>
        </>
      ) : (
        <div className="o2-empty">
          <IconCalendarEvent size={22} stroke={1.5} />
          当日无会议，可深度推进要事。
        </div>
      )}
    </section>
  );
}

// AI 建议：终端风输出面板，带反馈与重新生成
function SuggestionPanel({ delay }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState(null);
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
    if (fb) setFeedback(fb);
    try {
      const r = await api.get(`/overview/suggestion?force=1${fb ? `&feedback=${fb}` : ""}`);
      setText(r.suggestion);
    } catch { /* 忽略 */ } finally { setLoading(false); }
  }
  return (
    <section className="o2-panel o2-panel--term" style={{ animationDelay: `${delay}ms` }}>
      <div className="o2-panel__head">
        <span className="o2-panel__title"><IconSparkles size={16} stroke={1.75} />AI 建议 BRIEFING</span>
        <div className="o2-panel__actions">
          <button className="o2-ico-btn" title="这条建议不错" onClick={() => regenerate("good")} disabled={loading}>
            <IconThumbUp size={14} stroke={1.75} className={feedback === "good" ? "o2-on" : ""} />
          </button>
          <button className="o2-ico-btn" title="换一条" onClick={() => regenerate("bad")} disabled={loading}>
            <IconThumbDown size={14} stroke={1.75} className={feedback === "bad" ? "o2-on" : ""} />
          </button>
          <button className="o2-ico-btn" title="重新生成" onClick={() => regenerate()} disabled={loading}>
            <IconRefresh size={14} stroke={1.75} className={loading ? "o2-spin" : ""} />
          </button>
        </div>
      </div>
      <div className="o2-term">
        <span className="o2-term__prompt">❯</span>
        <span className="o2-term__text">{loading ? "正在生成今日建议…" : text || "暂时无法生成建议。"}</span>
        <span className="o2-term__cursor" aria-hidden="true" />
      </div>
    </section>
  );
}

/* ================= 第三行面板 ================= */

// 待处理邮件流：高优先置顶突出
function MailStreamPanel({ emails, delay, onViewAll }) {
  const items = [...emails].sort((a, b) => (b.importance === "high") - (a.importance === "high"));
  return (
    <section className="o2-panel" style={{ animationDelay: `${delay}ms` }}>
      <div className="o2-panel__head">
        <span className="o2-panel__title"><IconMail size={16} stroke={1.75} />待处理邮件 INBOX</span>
        <button className="o2-link" onClick={onViewAll}>全部 →</button>
      </div>
      <div className="o2-list">
        {items.map((e) => (
          <div className="o2-row" key={e.id}>
            <Led tone={e.importance === "high" ? "amber" : "slate"} />
            <div className="o2-row__main">
              <div className="o2-row__title">{e.subject}</div>
              <div className="o2-row__sub">{e.sender}</div>
            </div>
            {e.importance === "high" && <span className="o2-chip o2-chip--danger">高优</span>}
          </div>
        ))}
        {!items.length && <div className="o2-empty">收件箱已清空，无待处理邮件。</div>}
      </div>
    </section>
  );
}

// 团队信号：阻塞点 + 待审核 / 未提交
function TeamSignalsPanel({ blockers, needReview, notSubmitted, delay }) {
  return (
    <section className="o2-panel" style={{ animationDelay: `${delay}ms` }}>
      <div className="o2-panel__head">
        <span className="o2-panel__title"><IconAlertTriangle size={16} stroke={1.75} />团队信号 SIGNALS</span>
        <span className="o2-panel__tag">阻塞 {blockers.length} · 未提交 {notSubmitted.length}</span>
      </div>
      <div className="o2-signal">
        <div className="o2-signal__label">阻塞点</div>
        <div className="o2-list o2-list--tight">
          {blockers.map((b, i) => (
            <div className="o2-row" key={i}><Led tone="rose" /><div className="o2-row__title">{b}</div></div>
          ))}
          {!blockers.length && <div className="o2-muted">无阻塞 ✓</div>}
        </div>
        <div className="o2-signal__label">待审核</div>
        <div className="o2-list o2-list--tight">
          {needReview.map((r, i) => (
            <div className="o2-row" key={i}><Led tone="amber" /><div className="o2-row__title">{r}</div></div>
          ))}
          {!needReview.length && <div className="o2-muted">无待审核 ✓</div>}
        </div>
        <div className="o2-signal__label">未提交日志</div>
        <div className="o2-list o2-list--tight">
          {notSubmitted.map((n, i) => (
            <div className="o2-row" key={i}><Led tone="violet" /><div className="o2-row__title">{n}</div></div>
          ))}
          {!notSubmitted.length && <div className="o2-muted">全员已提交 ✓</div>}
        </div>
      </div>
    </section>
  );
}

/* ================= 主页面 ================= */

export default function Overview2Page() {
  const [date, setDate] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
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
      })
      .catch((e) => active && setErr(e.message));
    return () => { active = false; };
  }, [date]);

  if (err) return <div className="error">加载失败：{err}</div>;
  if (!data) return <div className="spinner">加载中…</div>;

  const { ov, projects, load, todos } = data;
  const proj = projectStats(projects);
  const mail = mailStats(ov.pendingEmails);
  const log = logStats(load);
  const todo = todoStats(todos);
  const risks = ov.riskProjects || [];
  const riskCount = risks.length;

  return (
    <div className="o2">
      <header className="o2-commandbar">
        <div className="o2-commandbar__left">
          <span className="o2-commandbar__dot" aria-hidden="true" />
          <div>
            <div className="o2-commandbar__title">WORKBENCH // 指挥台</div>
            <div className="o2-commandbar__sub">
              {data.date} · {riskCount ? `⚠ ${riskCount} 个风险信号` : "状态正常"} · 邮件 {mail.total} · 会议 {ov.meetings.length} · 未提交 {log.notSubmitted}
            </div>
          </div>
        </div>
        <DateNav date={date} onChange={setDate} className="o2-datenav" />
      </header>

      <div className="o2-kpis">
        <ProjectHealthCard stats={proj} delay={0} />
        <MailLoadCard stats={mail} delay={60} />
        <LogSubmitCard stats={log} delay={120} />
        <TodoCard stats={todo} delay={180} />
      </div>

      <div className="o2-grid">
        <RiskPanel projects={risks} delay={240} onViewAll={() => navigate("/projects")} />
        <TimelinePanel meetings={ov.meetings} delay={300} onViewCalendar={() => navigate("/calendar")} />
        <SuggestionPanel delay={360} />
      </div>

      <div className="o2-grid o2-grid--bottom">
        <MailStreamPanel emails={ov.pendingEmails} delay={420} onViewAll={() => navigate("/emails")} />
        <TeamSignalsPanel
          blockers={ov.teamBlockers}
          needReview={ov.needReview}
          notSubmitted={ov.notSubmitted}
          delay={480}
        />
      </div>
    </div>
  );
}