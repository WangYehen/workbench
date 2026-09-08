import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { IconCalendarWeek } from "@tabler/icons-react";
import { api } from "../api.js";
import GenerateButton from "../components/GenerateButton.jsx";

function fmtDate(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function weekRange() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // 周一=0
  const mon = new Date(d); mon.setDate(d.getDate() - day);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return { weekStart: fmtDate(mon), weekEnd: fmtDate(sun) };
}
// 周维度「前后」导航：基于 weekStart 平移整周（本地时区，避免 UTC 偏移）。
function addWeeks(weekStart, n) {
  const [y, m, d] = weekStart.split("-").map(Number);
  const mon = new Date(y, m - 1, d); mon.setDate(mon.getDate() + n * 7);
  const sun = new Date(y, m - 1, d); sun.setDate(sun.getDate() + n * 7 + 6);
  return { weekStart: fmtDate(mon), weekEnd: fmtDate(sun) };
}

export default function WeeklyReportPage() {
  const [week, setWeek] = useState(weekRange());
  const [weekly, setWeekly] = useState(null);
  const [busy, setBusy] = useState(false);

  async function loadWeekly() {
    const r = await api.get(`/reports/weekly?weekStart=${week.weekStart}`);
    setWeekly(r.report);
  }
  useEffect(() => { loadWeekly(); }, [week.weekStart]);

  async function genWeekly() {
    setBusy(true);
    try {
      await api.post("/reports/weekly/generate", week);
      await loadWeekly();
    } finally {
      setBusy(false);
    }
  }

  const list = (arr) => (arr || []).map((x, i) => <li key={i}>{x}</li>);

  return (
    <div>
      <PageHeader
        eyebrow="WEEKLY / REPORT"
        title="周报"
        description="每周基于日报汇总生成；单日详情请在「日报」页查看，全部持久化于本地 SQLite 可回溯"
        actions={
          <div className="row">
            <button className="btn sm" onClick={() => setWeek(addWeeks(week.weekStart, -1))}>上一周</button>
            <button className="btn sm" onClick={() => setWeek(weekRange())}>本周</button>
            <button className="btn sm" onClick={() => setWeek(addWeeks(week.weekStart, 1))}>下一周</button>
          </div>
        }
      />

      <div className="panel">
        <div className="panel__head">
          <div className="panel__title"><span className="work-page-icon"><IconCalendarWeek size={22} stroke={1.75} /></span>本周周报</div>
          <GenerateButton onClick={genWeekly} busy={busy} />
        </div>
        <div className="meta" style={{ marginBottom: 12 }}>{week.weekStart} ~ {week.weekEnd}</div>
        {weekly ? (
          <div>
            {weekly.content_json.aiMeta && <div className="meta" style={{ marginBottom: 12 }}>
              {weekly.content_json.aiMeta.provider === "local" ? "本地规则汇总（AI 未成功返回）" : `AI 生成 · ${weekly.content_json.aiMeta.providerLabel || weekly.content_json.aiMeta.provider}`}
            </div>}
            {weekly.content_json.narrative && <p>{weekly.content_json.narrative}</p>}
            {weekly.content_json.highlights?.length > 0 && <><div className="sub">关键进展</div><ul>{list(weekly.content_json.highlights)}</ul></>}
            {weekly.content_json.risks?.length > 0 && <><div className="sub">风险与阻塞</div><ul>{list(weekly.content_json.risks)}</ul></>}
            {weekly.content_json.nextWeek?.length > 0 && <><div className="sub">下周重点</div><ul>{list(weekly.content_json.nextWeek)}</ul></>}
            {!weekly.content_json.narrative && !weekly.content_json.highlights && <div className="empty">已生成周报，暂无可展示内容</div>}
          </div>
        ) : <div className="empty">尚未生成，点击「生成 / 刷新」创建本周周报</div>}
      </div>
    </div>
  );
}
