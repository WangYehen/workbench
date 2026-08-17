import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { IconUsersGroup, IconUserCheck, IconAlertTriangle, IconFlame, IconInfoCircle } from "@tabler/icons-react";
import { api } from "../api.js";
import DateNav from "../components/DateNav.jsx";

function loadColor(load) {
  if (load >= 6) return "var(--danger)";
  if (load >= 4) return "var(--warn)";
  if (load >= 1) return "var(--accent)";
  return "var(--ok)";
}

export default function TeamLoadPage() {
  const [date, setDate] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const q = date ? `?date=${date}` : "";
    api
      .get("/team/load" + q)
      .then((d) => {
        setData(d);
        if (!date) setDate(d.date); // 首次加载用后端默认的最近数据日
      })
      .catch((e) => setErr(e.message));
  }, [date]);

  if (err) return <div className="error">加载失败：{err}</div>;
  if (!data) return <div className="spinner">加载中…</div>;

  const s = data.summary;

  const metrics = [
    { label: "团队成员", value: s.total, hint: "非管理层", Icon: IconUsersGroup },
    { label: "今日已提交", value: s.submitted, hint: "日志已上报", Icon: IconUserCheck },
    { label: "有阻塞", value: s.risk, hint: "存在卡点", color: "var(--danger)", Icon: IconAlertTriangle },
    { label: "高负载", value: s.overloaded, hint: "负载指数 ≥4", color: "var(--warn)", Icon: IconFlame },
  ];

  const maxLoad = Math.max(1, ...data.members.map((m) => m.load));

  return (
    <div>
      <PageHeader
        eyebrow="TEAM / LOAD"
        title="团队负载"
        description={`${data.date} · 谁在做什么、谁卡住了，一目了然`}
        actions={<DateNav date={date} onChange={setDate} />}
      />

      <div className="metric-strip">
        {metrics.map((m) => (
          <div key={m.label} className="metric">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span className="metric__label">{m.label}</span>
              <m.Icon size={18} stroke={1.75} style={{ color: m.color || "var(--accent-soft)" }} />
            </div>
            <div className="metric__value" style={m.color ? { color: m.color } : undefined}>{m.value}</div>
            <div className="metric__hint">{m.hint}</div>
          </div>
        ))}
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel__head">
          <div className="panel__title"><span className="work-page-icon"><IconInfoCircle size={22} stroke={1.75} /></span>负载定义（正式口径）</div>
        </div>
        <div className="sub">负载指数 Load Index</div>
        <p style={{ marginTop: 6 }}>负载指数 = 阻塞 × 2 + 待审 × 1 + 未提交 × 3</p>
        <ul>
          <li><b>阻塞</b>：该成员当日钉钉日志中被 AI 标记的卡点数（权重 2）</li>
          <li><b>待审</b>：需主管审核的要点数（权重 1）</li>
          <li><b>未提交</b>：当日未上报日志（罚分 3，避免漏报被忽略）</li>
        </ul>
        <div className="sub">档位与颜色</div>
        <ul>
          <li><span className="pill green">正常</span> 负载 0–3</li>
          <li><span className="pill amber">偏高</span> 负载 4–5（指标卡「高负载」阈值 = ≥4）</li>
          <li><span className="pill red">过载</span> 负载 ≥ 6（指标卡「有阻塞」单独计数）</li>
        </ul>
        <div className="meta">数据来源：钉钉日志（dingtalk_reports，report_date = 所选日期）按真实提交人聚合；负载指数 = 阻塞×2 + 待审。聚合接口 <code>/api/team/load?date=</code>。</div>
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel__head">
          <div className="panel__title"><span className="work-page-icon"><IconUsersGroup size={22} stroke={1.75} /></span>负载矩阵</div>
          <span className="meta">负载指数 = 阻塞×2 + 待审 + 未提交×3</span>
        </div>
        <div className="load-matrix">
          <div className="load-row load-head">
            <div className="load-name">成员</div>
            <div className="load-cell">今日提交</div>
            <div className="load-cell">阻塞</div>
            <div className="load-cell">待审</div>
            <div className="load-bar-cell">负载指数</div>
          </div>
          {data.members.map((m) => (
            <div className="load-row" key={m.user_id}>
              <div className="load-name"><strong>{m.name}</strong> <span className="meta">{m.dept_name}</span></div>
              <div className="load-cell">
                <span className={`pill ${m.submitted ? "green" : "red"}`}>{m.submitted ? "已提交" : "未提交"}</span>
              </div>
              <div className="load-cell"><span className="meta">{m.blockers.length}</span></div>
              <div className="load-cell"><span className="meta">{m.review.length}</span></div>
              <div className="load-bar-cell">
                <div className="progress"><span style={{ width: `${(m.load / maxLoad) * 100}%`, background: loadColor(m.load) }}></span></div>
                <span className="meta" style={{ marginLeft: 8 }}>{m.load}</span>
              </div>
            </div>
          ))}
          {!data.members.length && <div className="empty">暂无团队成员数据（需先同步钉钉）</div>}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel__head">
          <div className="panel__title"><span className="work-page-icon"><IconAlertTriangle size={22} stroke={1.75} /></span>成员明细 / 卡点</div>
        </div>
        <div className="list">
          {data.members.map((m) => (
            <div className="item" key={m.user_id}>
              <div className="title" style={{ minWidth: 90 }}>{m.name}</div>
              <div style={{ flex: 1 }}>
                {m.blockers.length ? (
                  m.blockers.map((b, i) => <div key={i} className="sub"><span className="pill red" style={{ marginRight: 6 }}>阻塞</span>{b}</div>)
                ) : m.review.length ? (
                  m.review.map((r, i) => <div key={i} className="sub"><span className="pill amber" style={{ marginRight: 6 }}>待审</span>{r}</div>)
                ) : (
                  <div className="sub">无阻塞、无待审，状态良好</div>
                )}
              </div>
              <div className="progress" style={{ width: 90 }}><span style={{ width: `${(m.load / maxLoad) * 100}%`, background: loadColor(m.load) }}></span></div>
            </div>
          ))}
          {!data.members.length && <div className="empty">暂无成员</div>}
        </div>
      </div>
    </div>
  );
}
