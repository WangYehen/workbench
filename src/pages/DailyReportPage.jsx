import { useEffect, useState, useMemo } from "react";
import { PageHeader } from "../components/PageHeader";
import { IconFileText, IconCalendar, IconEdit, IconCheck, IconUser, IconFilter } from "@tabler/icons-react";
import { api, todayStr } from "../api.js";
import DateNav from "../components/DateNav.jsx";

/** 按 key 值映射展示样式 */
const KEY_META = {
  今日完成: { icon: "✅", label: "今日完成工作", color: "var(--ok, #16a34a)", bg: "#f0fdf4" },
  work_done: { icon: "✅", label: "今日完成工作", color: "var(--ok, #16a34a)", bg: "#f0fdf4" },
  遗留: { icon: "⏳", label: "今日遗留工作", color: "var(--warn, #d97706)", bg: "#fffbeb" },
  leftover: { icon: "⏳", label: "今日遗留工作", color: "var(--warn, #d97706)", bg: "#fffbeb" },
  明日: { icon: "📋", label: "明日工作计划", color: "var(--accent, #7c3aed)", bg: "var(--accent-wash, #f3effe)" },
  tomorrow: { icon: "📋", label: "明日工作计划", color: "var(--accent, #7c3aed)", bg: "var(--accent-wash, #f3effe)" },
  协作: { icon: "🤝", label: "需要协作工作", color: "#7c3aed", bg: "#f5f3ff" },
  collab: { icon: "🤝", label: "需要协作工作", color: "#7c3aed", bg: "#f5f3ff" },
  图片: { icon: "🖼️", label: "图片", color: "var(--ink-soft)", bg: "var(--surface-sunken)" },
  image: { icon: "🖼️", label: "图片", color: "var(--ink-soft)", bg: "var(--surface-sunken)" },
  附件: { icon: "📎", label: "附件", color: "var(--ink-soft)", bg: "var(--surface-sunken)" },
  attachment: { icon: "📎", label: "附件", color: "var(--ink-soft)", bg: "var(--surface-sunken)" },
};

/** 根据 key 名匹配展示元数据，未匹配则返回默认样式 */
function getKeyMeta(key) {
  if (!key) return { icon: "📝", label: key || "其他", color: "var(--ink-soft)", bg: "var(--surface-sunken)" };
  const lower = key.toLowerCase();
  for (const [pattern, meta] of Object.entries(KEY_META)) {
    if (lower.includes(pattern)) return meta;
  }
  return { icon: "📝", label: key, color: "var(--ink-soft)", bg: "var(--surface-sunken)" };
}

/** 判断一个 section 的内容是否为空 */
function isEmptySection(value) {
  if (!value) return true;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "[]" || trimmed === "【】";
}

/** 解析附件/图片 value（JSON 数组字符串） */
function parseFileList(value) {
  if (!value || value.trim() === "[]") return [];
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export default function DailyReportPage() {
  const [date, setDate] = useState(todayStr());
  const [availableDates, setAvailableDates] = useState([]);
  const [dingtalk, setDingtalk] = useState({ date, reports: [], departments: [], total: 0 });
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // 部门筛选：多选
  const [selectedDepts, setSelectedDepts] = useState(new Set());

  // 拉可用日志日期
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
      // 重置部门筛选为"全部"
      setSelectedDepts(new Set());
    } catch { /* 忽略 */ }
  }
  async function loadDaily() {
    try {
      const r = await api.get(`/reports/daily?date=${date}`);
      setReport(r.report);
    } catch { /* 忽略 */ }
  }
  useEffect(() => { loadDingtalk(); loadDaily(); }, [date]);

  // 按部门过滤后的报告列表
  const filteredReports = useMemo(() => {
    if (selectedDepts.size === 0) return dingtalk.reports;
    return dingtalk.reports.filter((r) => selectedDepts.has(r.dept_name));
  }, [dingtalk.reports, selectedDepts]);

  // 切换部门选中状态
  const toggleDept = (dept) => {
    setSelectedDepts((prev) => {
      const next = new Set(prev);
      if (next.has(dept)) next.delete(dept);
      else next.add(dept);
      return next;
    });
  };

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

  return (
    <div>
      <PageHeader
        eyebrow="DAILY / REPORT"
        title="日报"
        description="团队钉钉日报实时呈现，按 key 分区展示；支持部门多选筛选"
      />

      {/* 日期选择 */}
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

      {/* 部门筛选 */}
      {dingtalk.departments.length > 0 && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel__head">
            <div className="panel__title">
              <span className="work-page-icon"><IconFilter size={22} stroke={1.75} /></span>部门筛选
            </div>
            <span className="meta">
              {selectedDepts.size === 0 ? "全部" : `已选 ${selectedDepts.size} 个部门`}
              （{filteredReports.length}/{dingtalk.total} 人）
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <button
              className={"btn sm" + (selectedDepts.size === 0 ? " primary" : "")}
              onClick={() => setSelectedDepts(new Set())}
            >全部</button>
            {dingtalk.departments.map((dept) => (
              <button
                key={dept}
                className={"btn sm" + (selectedDepts.has(dept) ? " primary" : "")}
                onClick={() => toggleDept(dept)}
              >{dept}</button>
            ))}
          </div>
        </div>
      )}

      {/* 团队钉钉日报卡片 */}
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel__head">
          <div className="panel__title">
            <span className="work-page-icon"><IconFileText size={22} stroke={1.75} /></span>
            团队钉钉日报 · {dingtalk.date}
          </div>
        </div>
        {filteredReports.length > 0 ? (
          <div className="grid grid-2">
            {filteredReports.map((r) => (
              <ReportCard key={r.id} report={r} />
            ))}
          </div>
        ) : (
          <div className="empty">
            {dingtalk.reports.length > 0
              ? "当前筛选条件下暂无日志"
              : "该日期暂无钉钉日志（可在上方切换到有数据的日期）"}
          </div>
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
              <ul>{(c.teamBlockers || []).length ? c.teamBlockers.map((x, i) => <li key={i}>{x}</li>) : <div className="empty">无</div>}</ul>
              <div className="sub">需主管审核</div>
              <ul>{(c.needManagerReview || []).length ? c.needManagerReview.map((x, i) => <li key={i}>{x}</li>) : <div className="empty">无</div>}</ul>
            </div>
          </div>
        ) : (
          <div className="empty">该日期尚未生成 AI 日报，点击「生成 / 刷新」创建（基于当日邮件、待办与钉钉日志）</div>
        )}
      </div>
    </div>
  );
}

/** 单人日报卡片：按 key 分区展示 contents */
function ReportCard({ report }) {
  const { user_name, dept_name, template_name, contents, summary, blockers, needs_review } = report;

  // 按 sort 排序，过滤掉图片/附件空 section（保留有内容的）
  const sections = useMemo(() => {
    if (!contents || !contents.length) return [];
    return contents
      .slice()
      .sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0))
      .filter((c) => {
        // 图片/附件：value 为 "[]" 时不显示
        if (c.type === "8" || c.type === "9") return !isEmptySection(c.value);
        return !isEmptySection(c.value);
      });
  }, [contents]);

  return (
    <div className="panel" style={{ margin: 0 }}>
      {/* 卡片头部：姓名 + 部门 */}
      <div className="panel__head">
        <div className="panel__title">
          <span className="work-page-icon"><IconUser size={18} stroke={1.75} /></span>{user_name}
        </div>
        {dept_name && (
          <span className="pill gray" style={{ fontSize: 12 }}>{dept_name}</span>
        )}
      </div>

      {/* AI 一句话总结 */}
      {summary && (
        <div style={{
          padding: "8px 14px",
          margin: "0 0 8px",
          background: "var(--accent-wash, #f3effe)",
          borderRadius: 8,
          fontSize: 13,
          color: "var(--accent-strong, #6d28d9)",
          lineHeight: 1.5,
        }}>
          🤖 {summary}
        </div>
      )}

      {/* 按 key 分区展示 contents */}
      {sections.length > 0 ? (
        <div style={{ padding: "0 14px 12px" }}>
          {sections.map((section, idx) => {
            const meta = getKeyMeta(section.key);
            // 附件/图片特殊渲染
            if (section.type === "8" || section.type === "9") {
              const files = parseFileList(section.value);
              return (
                <div key={idx} style={{ marginTop: idx > 0 ? 10 : 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: meta.color, marginBottom: 4 }}>
                    {meta.icon} {meta.label}
                  </div>
                  {files.length > 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {files.map((f, fi) => (
                        <span key={fi} className="pill gray" style={{ fontSize: 12 }}>
                          {typeof f === "string" ? f.split("/").pop() : JSON.stringify(f)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            }
            // 普通文本内容
            return (
              <div key={idx} style={{
                marginTop: idx > 0 ? 10 : 0,
                padding: "8px 10px",
                background: meta.bg,
                borderRadius: 6,
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: meta.color, marginBottom: 4 }}>
                  {meta.icon} {meta.label}
                </div>
                <div style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {section.value}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty" style={{ padding: "12px 14px" }}>暂无日志内容</div>
      )}

      {/* 阻塞 & 需审核 */}
      {(blockers?.length > 0 || needs_review?.length > 0) && (
        <div style={{ padding: "0 14px 12px", display: "flex", gap: 12, flexWrap: "wrap" }}>
          {blockers?.length > 0 && (
            <div>
              <span className="pill red">🚫 阻塞</span>
              <span style={{ fontSize: 13, marginLeft: 6 }}>{blockers.join("；")}</span>
            </div>
          )}
          {needs_review?.length > 0 && (
            <div>
              <span className="pill amber">⚠️ 需主管审核</span>
              <span style={{ fontSize: 13, marginLeft: 6 }}>{needs_review.join("；")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
