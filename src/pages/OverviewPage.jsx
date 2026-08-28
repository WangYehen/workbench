import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { useNavigate } from "react-router-dom";
import {
  IconMail,
  IconCalendarEvent,
  IconAlertTriangle,
  IconUserX,
  IconListCheck,
  IconMailForward,
  IconCalendarTime,
  IconClipboardCheck,
  IconShieldCheck,
  IconSparkles,
  IconRefresh,
  IconThumbUp,
  IconThumbDown,
} from "@tabler/icons-react";
import { api } from "../api.js";
import DateNav from "../components/DateNav.jsx";
import { StatusPill } from "../lib/project-status.jsx";
import MeetingSchedule from "../components/MeetingSchedule.jsx";
import GenerateButton from "../components/GenerateButton.jsx";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function greetingInfo() {
  const now = new Date();
  const hour = now.getHours();
  const greet =
    hour < 6 ? "凌晨好" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  const wd = WEEKDAYS[now.getDay()];
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  return { greet, wd, isWeekend };
}

export default function OverviewPage() {
  const [date, setDate] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const navigate = useNavigate();

  const [suggestion, setSuggestion] = useState("");
  const [sugLoading, setSugLoading] = useState(false);
  const [sugFeedback, setSugFeedback] = useState(null); // 'good' | 'bad' | null

  useEffect(() => {
    const q = date ? `?date=${date}` : "";
    api
      .get("/overview" + q)
      .then((d) => {
        setData(d);
        if (!date) setDate(d.date); // 首次加载用后端默认的最近数据日
      })
      .catch((e) => setErr(e.message));
  }, [date]);

  useEffect(() => {
    if (!data) return;
    let active = true;
    setSugLoading(true);
    api
      .get("/overview/suggestion")
      .then((r) => active && setSuggestion(r.suggestion))
      .catch(() => active && setSuggestion(""))
      .finally(() => active && setSugLoading(false));
    return () => { active = false; };
  }, [data]);

  async function regenerate(feedback) {
    setSugLoading(true);
    if (feedback) setSugFeedback(feedback);
    try {
      const r = await api.get(`/overview/suggestion?force=1${feedback ? `&feedback=${feedback}` : ""}`);
      setSuggestion(r.suggestion);
    } catch {
      /* 忽略 */
    } finally {
      setSugLoading(false);
    }
  }

  if (err) return <div className="error">加载失败：{err}</div>;
  if (!data) return <div className="spinner">加载中…</div>;

  const risks = data.riskProjects || [];
  const g = greetingInfo();
  const greeting = `${g.greet} 查尔斯${g.isWeekend ? "，周末，专注一件事就够了" : ""}。当日有 ${risks.length} 个风险项目 · ${data.pendingEmails.length} 封待处理邮件 · ${data.meetings.length} 场会议`;

  const metrics = [
    { label: "待处理邮件", value: data.pendingEmails.length, hint: "需主管亲自处理", accent: true, Icon: IconMail },
    { label: "当日会议", value: data.meetings.length, hint: "按时间排序", Icon: IconCalendarEvent },
    { label: "团队卡点", value: data.teamBlockers.length, hint: "需关注阻塞", color: "var(--danger)", Icon: IconAlertTriangle },
    { label: "未提交日志", value: data.notSubmitted.length, hint: "待催办", color: "var(--warn)", Icon: IconUserX },
    { label: "今日待办", value: data.openTodos || 0, hint: "个人事项", Icon: IconListCheck },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="OVERVIEW / WORKBENCH"
        title="概览面板"
        description={`${data.date} · 周${g.wd} · ${greeting}`}
        actions={<DateNav date={date} onChange={setDate} />}
      />

      <div className="metric-strip">
        {metrics.map((m) => (
          <div key={m.label} className={`metric ${m.accent ? "metric--accent" : ""}`}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span className="metric__label">{m.label}</span>
              <m.Icon size={18} stroke={1.75} style={{ color: m.color || "var(--accent-soft)" }} />
            </div>
            <div className="metric__value" style={m.color ? { color: m.color } : undefined}>{m.value}</div>
            <div className="metric__hint">{m.hint}</div>
          </div>
        ))}
      </div>

      <div className="panel risk-panel" style={{ marginBottom: 20, borderColor: risks.length ? "var(--danger)" : "var(--line)" }}>
        <div className="panel__head">
          <div className="panel__title">
            <span className="work-page-icon" style={risks.length ? { borderColor: "var(--danger)", background: "var(--danger-wash)", color: "var(--danger)" } : undefined}>
              {risks.length ? <IconAlertTriangle size={22} stroke={1.75} /> : <IconShieldCheck size={22} stroke={1.75} />}
            </span>
            {risks.length ? `风险项目预警（${risks.length}）` : "项目健康度"}
          </div>
          <button className="btn sm" onClick={() => navigate("/projects")}>查看项目</button>
        </div>
        {risks.length ? (
          <div className="list">
            {risks.map((r) => (
              <div className="item" key={r.id} style={{ cursor: "pointer" }} onClick={() => navigate("/projects")}>
                <StatusPill status={r.status} />
                <div style={{ flex: 1 }}>
                  <div className="title">{r.name}</div>
                  <div className="sub">{r.owner} · 进度 {r.progress}%</div>
                </div>
                <div className="progress" style={{ width: 120 }}>
                  <span style={{ width: `${r.progress}%` }} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty" style={{ padding: 18 }}>当前无风险项目，所有项目进度健康 ✓</div>
        )}
      </div>

      <div className="panel ai-suggestion">
        <div className="panel__head">
          <div className="panel__title">
            <span className="work-page-icon ai-suggestion__icon"><IconSparkles size={22} stroke={1.75} /></span>
            今日 AI 工作建议
          </div>
          <div className="ai-suggestion__actions">
            <button
              className={`ai-feedback ${sugFeedback === "good" ? "on" : ""}`}
              title="这条建议不错"
              onClick={() => regenerate("good")}
              disabled={sugLoading}
            >
              <IconThumbUp size={15} stroke={1.75} />
            </button>
            <button
              className={`ai-feedback ${sugFeedback === "bad" ? "on" : ""}`}
              title="换一条"
              onClick={() => regenerate("bad")}
              disabled={sugLoading}
            >
              <IconThumbDown size={15} stroke={1.75} />
            </button>
            <GenerateButton onClick={() => regenerate()} busy={sugLoading}>重新生成</GenerateButton>
          </div>
        </div>
        <div className="ai-suggestion__body">
          {sugLoading ? "正在为你生成今日建议…" : suggestion || "暂时无法生成建议。"}
        </div>
      </div>

      <div className="overview-grid">
        <div className="overview-stack">
          <div className="panel">
            <div className="panel__head">
              <div className="panel__title">
                <span className="work-page-icon"><IconMailForward size={22} stroke={1.75} /></span>
                今日待处理邮件
              </div>
            </div>
            <div className="list">
              {data.pendingEmails.map((e) => (
                <div className="item" key={e.id}>
                  <span className={`pill ${e.importance === "high" ? "red" : "blue"}`}>邮件</span>
                  <div>
                    <div className="title">{e.subject}</div>
                    <div className="sub">{e.sender}</div>
                  </div>
                </div>
              ))}
              {!data.pendingEmails.length && <div className="empty">暂无</div>}
            </div>
          </div>

          <div className="panel">
            <div className="panel__head">
              <div className="panel__title">
                <span className="work-page-icon"><IconCalendarTime size={22} stroke={1.75} /></span>
                今日会议日程
              </div>
              <button className="btn sm ghost" onClick={() => navigate("/calendar")}>查看日历</button>
            </div>
            <MeetingSchedule meetings={data.meetings} onViewCalendar={() => navigate("/calendar")} />
          </div>
        </div>

        <div className="overview-stack">
          <div className="panel">
            <div className="panel__head">
              <div className="panel__title">
                <span className="work-page-icon"><IconAlertTriangle size={22} stroke={1.75} /></span>
                团队阻塞点
              </div>
            </div>
            <div className="list">
              {data.teamBlockers.map((b, i) => (
                <div className="item" key={i}><span className="pill red">阻塞</span><div className="title">{b}</div></div>
              ))}
              {!data.teamBlockers.length && <div className="empty">无阻塞</div>}
            </div>
          </div>

          <div className="panel">
            <div className="panel__head">
              <div className="panel__title">
                <span className="work-page-icon"><IconClipboardCheck size={22} stroke={1.75} /></span>
                待审核 / 未提交
              </div>
            </div>
            <div className="list">
              {data.needReview.map((r, i) => (
                <div className="item" key={i}><span className="pill amber">审核</span><div className="title">{r}</div></div>
              ))}
              {data.notSubmitted.map((n, i) => (
                <div className="item" key={"ns" + i}><span className="pill gray">未提交</span><div className="title">{n}</div></div>
              ))}
              {!data.needReview.length && !data.notSubmitted.length && <div className="empty">全部就绪</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
