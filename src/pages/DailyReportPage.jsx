import { useEffect, useState } from "react";
import { IconFileText, IconCalendar, IconEdit, IconCheck, IconUser } from "@tabler/icons-react";
import { api, todayStr } from "../api.js";
import DateNav from "../components/DateNav.jsx";

export default function DailyReportPage() {
  const [date, setDate] = useState(todayStr());
  const [availableDates, setAvailableDates] = useState([]);
  const [dingtalk, setDingtalk] = useState({ date, reports: [], total: 0 });
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // 先拉可用日志日期，默认选中最近有数据的一天
  useEffect(() => {
    (async () => {
      try {
        const d = await api.get("/reports/dingtalk/dates");
        setAvailableDates(d.dates || []);
        if (d.dates && d.dates.length) setDate(d.dates[0]);
      } catch { /* 忽略 */ }
    })();
  }, []);

  async function loadDingtalk() {
    try {
      const d = await api.get(`/reports/dingtalk?date=${date}`);
      setDingtalk(d);
    } catch { /* 忽略 */ }
  }
  async function loadDaily() {
    try {
      const r = await api.get(`/reports/daily?date=${date}`);
      setReport(r.report);
    } catch { /* 忽略 */ }
  }
  useEffect(() => { loadDingtalk(); loadDaily(); }, [date]);

  async function gen() {
    setBusy(true);
    await api.post("/reports/daily/generate", { date });
    await loadDaily();
    setBusy(false);
  }
  function startEdit() {
    setDraft(report?.content_json?.summary || "");
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    await api.put("/reports/daily", { date, content: { summary: draft } });
    await loadDaily();
    setEditing(false);
    setBusy(false);
  }

  const c = report?.content_json || {};
  const list = (arr) =>
    arr && arr.length ? arr.map((x, i) => <li key={i}>{x}</li>) : <div className="empty">无</div>;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>日报</h1>
          <div className="sub">团队钉钉日报实时呈现，可回溯任意日期；亦可基于邮件 / 待办生成 AI 智能日报</div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel__head">
          <div className="panel__title">
            <span className="work-page-icon"><IconCalendar size={22} stroke={1.75} /></span>选择日期
          </div>
          <DateNav date={date} onChange={setDate} />
        </div>
        {availableDates.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            <span className="sub" style={{ alignSelf: "center" }}>有日志的日期：</span>
            {availableDates.map((d) => (
              <button
                key={d}
                className={"btn sm" + (d === date ? " primary" : "")}
                onClick={() => setDate(d)}
              >{d}</button>
            ))}
          </div>
        )}
      </div>

      {/* 真实钉钉日报 */}
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel__head">
          <div className="panel__title">
            <span className="work-page-icon"><IconFileText size={22} stroke={1.75} /></span>
            团队钉钉日报（真实数据）· {dingtalk.date} · 共 {dingtalk.total} 人
          </div>
        </div>
        {dingtalk.reports.length ? (
          <div className="grid grid-2">
            {dingtalk.reports.map((r) => (
              <div className="panel" key={r.id} style={{ margin: 0 }}>
                <div className="panel__head">
                  <div className="panel__title">
                    <span className="work-page-icon"><IconUser size={18} stroke={1.75} /></span>{r.user_name}
                  </div>
                  <div className="sub">{r.template_name}</div>
                </div>
                {r.summary && <p style={{ color: "var(--purple, #7C3AED)", fontWeight: 600 }}>{r.summary}</p>}
                <pre style={{
                  whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0,
                  font: "inherit", lineHeight: 1.6, background: "var(--bg-soft, #f6f7fb)",
                  padding: "10px 12px", borderRadius: 8,
                }}>{r.content}</pre>
                {r.needs_review.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <span className="pill amber">需主管审核</span> {r.needs_review.join("；")}
                  </div>
                )}
                {r.blockers.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <span className="pill red">阻塞</span> {r.blockers.join("；")}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">该日期暂无钉钉日志（可在上方切换到有数据的日期）</div>
        )}
      </div>

      {/* AI 智能日报（可选增强） */}
      <div className="panel">
        <div className="panel__head">
          <div className="panel__title">
            <span className="work-page-icon"><IconFileText size={22} stroke={1.75} /></span>AI 智能日报 · {date}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary sm" onClick={gen} disabled={busy}>生成 / 刷新</button>
            {report && !editing && (
              <button className="btn sm" onClick={startEdit}><IconEdit size={16} /> 编辑小结</button>
            )}
            {report && editing && (
              <button className="btn primary sm" onClick={save} disabled={busy}><IconCheck size={16} /> 保存</button>
            )}
          </div>
        </div>
        {report ? (
          <div className="grid grid-2">
            <div>
              {editing ? (
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={6}
                  style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid var(--border, #d8dce3)", font: "inherit", resize: "vertical" }}
                />
              ) : (
                <p>{c.summary || "（暂无内容）"}</p>
              )}
              <div className="meta" style={{ marginTop: 8 }}>
                待处理邮件 {c.pendingEmails ?? "-"} 封 · 未完成待办 {c.openTodos ?? "-"} 项
              </div>
            </div>
            <div>
              <div className="sub">团队阻塞</div>
              <ul>{list(c.teamBlockers)}</ul>
              <div className="sub">需主管审核</div>
              <ul>{list(c.needManagerReview)}</ul>
            </div>
          </div>
        ) : (
          <div className="empty">该日期尚未生成 AI 日报，点击「生成 / 刷新」创建（基于当日邮件、待办与钉钉日志）</div>
        )}
      </div>
    </div>
  );
}
