import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import {
  IconCalendar,
  IconCalendarEvent,
  IconListCheck,
  IconMail,
  IconClipboardCheck,
  IconChevronLeft,
  IconChevronRight,
  IconLayoutGrid,
  IconLayoutList,
  IconRefresh,
} from "@tabler/icons-react";
import { api } from "../api.js";
import MeetingSchedule from "../components/MeetingSchedule.jsx";

// 本地日期字符串（YYYY-MM-DD），避免 toISOString 在东八区把当天算成前一天
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthMatrix(year, month) {
  const first = new Date(year, month, 1);
  const startDay = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const dow = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dow);
  return x;
}

function fmtWeekRange(start) {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const sy = start.getFullYear();
  const ey = end.getFullYear();
  const sm = start.getMonth() + 1;
  const em = end.getMonth() + 1;
  if (sy !== ey) return `${sy}年${sm}月${start.getDate()}日 — ${ey}年${em}月${end.getDate()}日`;
  if (sm !== em) return `${sy}年${sm}月${start.getDate()}日 — ${em}月${end.getDate()}日`;
  return `${sy}年${sm}月${start.getDate()}日 — ${end.getDate()}日`;
}

function fmtMonth(y, m) {
  return `${y} 年 ${m + 1} 月`;
}

const WEEK_DAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export default function CalendarPage() {
  const now = new Date();
  const [viewMode, setViewMode] = useState("week");
  const [weekStartDate, setWeekStartDate] = useState(() => startOfWeek(now));
  const [weekData, setWeekData] = useState([]);
  const [month, setMonth] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [selected, setSelected] = useState(ymd(now));
  const [day, setDay] = useState(null);
  const [monthData, setMonthData] = useState([]);
  const [err, setErr] = useState("");
  const [syncError, setSyncError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [syncNonce, setSyncNonce] = useState(0); // 手动同步后强制各视图重新加载

  async function loadDay(date) {
    try {
      const d = await api.get(`/calendar/day/${date}`);
      setDay(d);
      setConfigured(!!d.configured);
      setSyncError(d.syncError || "");
    } catch (e) {
      setErr(e.message);
    }
  }
  useEffect(() => { loadDay(selected); }, [selected, syncNonce]);

  // 周数据加载
  useEffect(() => {
    const ds = ymd(weekStartDate);
    api.get(`/calendar/week?start=${ds}`)
      .then((r) => { setWeekData(r.days || []); setConfigured(!!r.configured); if (r.syncError) setSyncError(r.syncError); })
      .catch(() => setWeekData([]));
  }, [weekStartDate, syncNonce]);

  // 月数据加载
  useEffect(() => {
    if (viewMode !== "month") return;
    api.get(`/calendar/month?year=${month.y}&month=${month.m}`)
      .then((r) => { setMonthData(r.days || []); setConfigured(!!r.configured); if (r.syncError) setSyncError(r.syncError); })
      .catch(() => setMonthData([]));
  }, [viewMode, month, syncNonce]);

  async function syncNow() {
    if (!configured) {
      setSyncError("钉钉未配置：请先在「系统」页连接钉钉，并在 .env 配置 DINGTALK_MANAGER_USER_ID");
      return;
    }
    setSyncing(true);
    try {
      const start = viewMode === "month" ? ymd(new Date(month.y, month.m, 1)) : ymd(weekStartDate);
      const end = viewMode === "month" ? ymd(new Date(month.y, month.m + 1, 0)) : ymd(new Date(weekStartDate.getTime() + 6 * 24 * 3600 * 1000));
      await api.post("/calendar/sync", { start, end });
      setSyncError("");
      setSyncNonce((n) => n + 1); // 触发当日/周/月重新加载
    } catch (e) {
      setSyncError(e.message || "同步失败");
    } finally {
      setSyncing(false);
    }
  }

  function shiftWeek(delta) {
    const d = new Date(weekStartDate);
    d.setDate(d.getDate() + delta * 7);
    setWeekStartDate(d);
  }
  function jumpToToday() {
    setWeekStartDate(startOfWeek(new Date()));
    setSelected(ymd(new Date()));
  }

  function selectDay(dateStr) {
    setSelected(dateStr);
    const d = new Date(dateStr + "T00:00:00");
    setWeekStartDate(startOfWeek(d));
    setMonth({ y: d.getFullYear(), m: d.getMonth() });
  }

  const prevMonth = () => setMonth({ y: month.m === 0 ? month.y - 1 : month.y, m: month.m === 0 ? 11 : month.m - 1 });
  const nextMonth = () => setMonth({ y: month.m === 11 ? month.y + 1 : month.y, m: month.m === 11 ? 0 : month.m + 1 });

  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStartDate);
    d.setDate(d.getDate() + i);
    return d;
  });
  const t = ymd(new Date());

  const cells = monthMatrix(month.y, month.m);

  return (
    <div>
      <PageHeader
        eyebrow="CALENDAR / SCHEDULE"
        title="日历 / 日详情"
        description={viewMode === "week" ? "周视图 · 默认展示本周，可左右切换或展开月份" : "月视图 · 点击任意一天查看当日邮件 / 待办 / 会议 / 日志 / 复盘"}
        actions={
          <div className="row">
            <span className={`pill ${configured ? "green" : "gray"}`}>
              {configured ? "钉钉日程已接入" : "演示数据（未接入钉钉）"}
            </span>
            <button className="btn sm" onClick={syncNow} disabled={syncing} title="从钉钉拉取最新日程">
              <IconRefresh size={14} stroke={2} /> {syncing ? "同步中…" : "同步钉钉日程"}
            </button>
            <button className={`btn sm ${viewMode === "week" ? "primary" : ""}`} onClick={() => setViewMode("week")}>
              <IconLayoutList size={14} stroke={2} /> 周视图
            </button>
            <button className={`btn sm ${viewMode === "month" ? "primary" : ""}`} onClick={() => setViewMode("month")}>
              <IconLayoutGrid size={14} stroke={2} /> 月视图
            </button>
          </div>
        }
      />

      {err && <div className="error">{err}</div>}
      {syncError && <div className="error">钉钉日程同步未成功（仍可查看已有/演示数据）：{syncError}</div>}

      {viewMode === "week" ? (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel__head">
            <div className="panel__title">
              <span className="work-page-icon"><IconCalendar size={22} stroke={1.75} /></span>
              {fmtWeekRange(weekStartDate)}
            </div>
            <div className="row">
              <button className="btn sm" onClick={() => shiftWeek(-1)} title="上一周">
                <IconChevronLeft size={14} stroke={2} />
              </button>
              <button className="btn sm" onClick={jumpToToday}>今天</button>
              <button className="btn sm" onClick={() => shiftWeek(1)} title="下一周">
                <IconChevronRight size={14} stroke={2} />
              </button>
            </div>
          </div>
          <div className="week-grid">
            {WEEK_DAY_LABELS.map((label, i) => {
              const d = weekDays[i];
              const ds = ymd(d);
              const info = weekData.find((x) => x.date === ds);
              const meetings = info?.meetings || [];
              const todoCount = info?.todos || 0;
              const emailCount = info?.emails || 0;
              const isToday = ds === t;
              const isSel = ds === selected;
              return (
                <button
                  type="button"
                  key={ds}
                  className={`week-day ${isToday ? "is-today" : ""} ${isSel ? "is-selected" : ""}`}
                  onClick={() => selectDay(ds)}
                >
                  <div className="week-day__head">
                    <span className="week-day__label">{label}</span>
                    <span className="week-day__date">{d.getDate()}</span>
                  </div>
                  <div className="week-day__events">
                    {meetings.slice(0, 2).map((m) => (
                      <span key={m.id} className="week-day__pill">
                        <span className="dot" /> {(m.title || "").slice(0, 14)}
                      </span>
                    ))}
                    {meetings.length > 2 && (
                      <span className="week-day__more">+{meetings.length - 2}</span>
                    )}
                    {!meetings.length && !todoCount && !emailCount && (
                      <span className="week-day__empty">无安排</span>
                    )}
                  </div>
                  <div className="week-day__counts">
                    {todoCount > 0 && <span className="week-day__count amber">{todoCount} 待办</span>}
                    {emailCount > 0 && <span className="week-day__count red">{emailCount} 邮件</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel__head">
            <div className="panel__title">
              <span className="work-page-icon"><IconCalendar size={22} stroke={1.75} /></span>
              月度视图
            </div>
            <div className="row">
              <button className="btn sm" onClick={prevMonth}>‹</button>
              <span style={{ fontWeight: 600 }}>{fmtMonth(month.y, month.m)}</span>
              <button className="btn sm" onClick={nextMonth}>›</button>
              <button className="btn sm" onClick={jumpToToday}>今天</button>
              <button className="btn sm" onClick={() => setViewMode("week")}>
                <IconLayoutList size={14} stroke={2} /> 收起为周
              </button>
            </div>
          </div>
          <div className="calendar-grid">
            {WEEK_DAY_LABELS.map((d) => (
              <div key={d} style={{ textAlign: "center", color: "var(--ink-faint)", fontSize: 12, fontWeight: 600 }}>{d}</div>
            ))}
            {cells.map((c, i) => {
              if (!c) return <div key={i} className="cal-cell dim" />;
              const ds = ymd(c);
              const isToday = ds === t;
              const isSel = ds === selected;
              const info = monthData.find((x) => x.date === ds);
              const meetings = info?.meetings || [];
              const todoCount = info?.todos || 0;
              const emailCount = info?.emails || 0;
              return (
                <div
                  key={i}
                  className={`cal-cell ${isToday ? "today" : ""} ${isSel ? "is-selected" : ""}`}
                  onClick={() => selectDay(ds)}
                >
                  <div className="cal-cell__head">
                    <span className="dnum">{c.getDate()}</span>
                    <div className="cal-cell__counts">
                      {todoCount > 0 && <span className="cal-cell__count amber" title={`${todoCount} 待办`}>{todoCount}</span>}
                      {emailCount > 0 && <span className="cal-cell__count red" title={`${emailCount} 邮件`}>{emailCount}</span>}
                    </div>
                  </div>
                  <div className="cal-cell__events">
                    {meetings.slice(0, 2).map((m) => (
                      <span key={m.id} className="cal-cell__pill">
                        <span className="dot" /> {(m.title || "").slice(0, 10)}
                      </span>
                    ))}
                    {meetings.length > 2 && (
                      <span className="cal-cell__more">+{meetings.length - 2}</span>
                    )}
                    {!meetings.length && !todoCount && !emailCount && (
                      <span className="cal-cell__empty">无安排</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {day && (
        <div className="grid grid-2">
          <div className="panel">
            <div className="panel__head">
              <div className="panel__title">
                <span className="work-page-icon"><IconCalendarEvent size={22} stroke={1.75} /></span>
                当日会议（{day.meetings.length}）
              </div>
            </div>
            <MeetingSchedule meetings={day.meetings} live={day.date === ymd(new Date())} />
          </div>

          <div className="panel">
            <div className="panel__head">
              <div className="panel__title">
                <span className="work-page-icon"><IconListCheck size={22} stroke={1.75} /></span>
                待办（{day.todos.length}）
              </div>
            </div>
            <div className="list">
              {day.todos.map((t) => (
                <div className="item" key={t.id}><span className={`pill ${t.status === "done" ? "green" : { P0: "p0", P1: "p1", P2: "p2" }[t.priority] || "p2"}`}>{t.priority}</span><div className="title">{t.title}</div></div>
              ))}
              {!day.todos.length && <div className="empty">无</div>}
            </div>
          </div>

          <div className="panel">
            <div className="panel__head">
              <div className="panel__title">
                <span className="work-page-icon"><IconMail size={22} stroke={1.75} /></span>
                需处理邮件（{day.emails.filter((e) => e.needs_action).length}）
              </div>
            </div>
            <div className="list">
              {day.emails.filter((e) => e.needs_action).map((e) => (
                <div className="item" key={e.id}><span className="pill red">邮件</span><div className="title">{e.subject}</div></div>
              ))}
              {!day.emails.filter((e) => e.needs_action).length && <div className="empty">无</div>}
            </div>
          </div>

          <div className="panel">
            <div className="panel__head">
              <div className="panel__title">
                <span className="work-page-icon"><IconClipboardCheck size={22} stroke={1.75} /></span>
                团队日志 / 复盘
              </div>
            </div>
            <div className="list">
              {day.reports.map((r) => (
                <div className="item" key={r.id}>
                  <span className="pill green">日志</span>
                  <div style={{ flex: 1 }}>
                    <div className="title">{r.user_name}{r.template_name ? ` · ${r.template_name}` : ""}</div>
                    {r.summary && <div className="sub">{r.summary}</div>}
                    {Array.isArray(r.blockers) && r.blockers.length > 0 && (
                      <div className="sub">
                        {r.blockers.map((b, i) => <span key={"b" + i} className="pill red" style={{ marginRight: 6 }}>{b}</span>)}
                      </div>
                    )}
                    {Array.isArray(r.needs_review) && r.needs_review.length > 0 && (
                      <div className="sub">
                        {r.needs_review.map((rv, i) => <span key={"r" + i} className="pill amber" style={{ marginRight: 6 }}>待审：{rv}</span>)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {day.review && <div className="item"><span className="pill blue">复盘</span><div className="title">已写复盘</div></div>}
              {!day.reports.length && !day.review && <div className="empty">无记录</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}