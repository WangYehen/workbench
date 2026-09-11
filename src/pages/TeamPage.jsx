import { useCallback, useEffect, useMemo, useState } from "react";
import { IconChevronDown, IconChevronRight, IconFileText, IconSearch, IconX, IconAlertTriangle, IconBell, IconCalendarEvent, IconUsers } from "@tabler/icons-react";
import DateNav from "../components/DateNav.jsx";
import { teamApi, todayStr, workbenchApi } from "../api.js";
import SyncButton from "../components/SyncButton.jsx";
import "./WorkspacePages.css";
import "./TeamPageEnhancements.css";

function yesterdayStr() {
  const value = new Date();
  value.setDate(value.getDate() - 1);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
function formatDay(date) { return date ? date.slice(5).replace("-", "/") : "—"; }
function memberStatus(member) { if (!member.submitted) return member.submissionState === "pending" ? "待提交" : "未提交"; return member.blockers.length || member.review.length ? "需关注" : "已提交"; }
function needsAttention(member) { return !member.submitted || member.blockers.length > 0 || member.review.length > 0; }
function statusClass(member) { const status = memberStatus(member); return status === "需关注" ? "attention" : status === "已提交" ? "submitted" : "missing"; }

function HistoryDots({ member, dates }) {
  if (!dates.length) return <span className="team-history-empty">暂无历史数据</span>;
  const submittedDates = new Set(member.submissionHistory?.submittedDates || []);
  return <span className="team-history-dots" aria-label={`近 ${dates.length} 个有效日报日已提交 ${member.submissionHistory?.submittedCount || 0} 次`}>
    {dates.slice().reverse().map((date) => <i key={date} className={submittedDates.has(date) ? "is-submitted" : "is-missing"} title={`${formatDay(date)}${submittedDates.has(date) ? " 已提交" : " 未提交"}`} />)}
  </span>;
}
function RiskList({ title, items, type }) {
  if (!items.length) return null;
  return <section className={`member-detail-section member-detail-section--${type}`}><h3>{title} <span>{items.length}</span></h3><ul>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></section>;
}
function MemberInspector({ member, report, dates, reportDate, onClose }) {
  if (!member) return <aside className="team-inspector"><div className="team-inspector__empty"><IconFileText size={24}/><strong>选择一位成员</strong><span>在名册中点击“查看”，即可阅读日报摘要、风险信号与原始日报。</span></div></aside>;
  const history = member.submissionHistory || {};
  const rawContents = report?.contents?.filter((item) => String(item.value || "").trim()) || [];
  return <aside className="team-inspector" aria-label={`${member.name}的只读详情`}>
    <header className="team-inspector__head"><div><span>查看 {reportDate} 日报 · 只读</span><h2>{member.name}</h2><p>{member.dept_name || "未设置部门"} · {memberStatus(member)}</p></div><button onClick={onClose} aria-label="关闭成员详情"><IconX size={18}/></button></header>
    <section className="member-detail-stats"><div><span>近 {history.totalDates || 0} 日提交</span><strong>{history.totalDates ? `${history.submittedCount}/${history.totalDates}` : "暂无"}</strong></div><div><span>连续缺交</span><strong>{history.missingStreak ? `${history.missingStreak} 日` : "—"}</strong></div><div><span>日报工作量</span><strong>{member.workload || 0}</strong></div></section>
    <section className="member-detail-section"><h3>提交趋势</h3><HistoryDots member={member} dates={dates}/><p className="member-detail-hint">仅按团队实际有日报记录的日期统计，不将节假日或全员未填计入缺交。</p></section>
    <section className="member-detail-section member-detail-section--summary"><h3>日报摘要</h3><p>{member.summary || (member.submitted ? "日报暂无可用摘要。" : "该成员当日未提交日报，暂无日报摘要。")}</p></section>
    <RiskList title="阻塞" items={member.blockers || []} type="blocker" /><RiskList title="待决策" items={member.review || []} type="review" />
    <section className="member-detail-section"><h3>原始日报</h3>{rawContents.length ? <div className="member-raw-report">{rawContents.map((item, index) => <div key={`${item.key}-${index}`}><strong>{item.key || "日志内容"}</strong><p>{item.value}</p></div>)}</div> : <p className="member-detail-muted">{member.submitted ? "暂无可展示的原始日报字段。" : "未提交日报，因此没有原始日报内容。"}</p>}</section>
  </aside>;
}
function SubmissionTrend({ trend, submitted, rosterTotal, blockers, reviews }) {
  const chart = { width: 1000, height: 180, left: 36, right: 964, baseline: 158 };
  const points = trend.map((item, index) => ({ ...item, x: trend.length > 1 ? chart.left + (index * (chart.right - chart.left)) / (trend.length - 1) : 500, y: chart.baseline - ((item.rate || 0) * 1.18) }));
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  return <section className="team-trend-panel"><div className="team-trend-chart"><header><div><h2>提交趋势</h2><p>最近 {trend.length || 0} 个有效日报日的团队提交率</p></div><span><i/> 团队提交率 <b>···</b> 目标值 80%</span></header>{trend.length ? <div className="team-chart-frame"><svg viewBox={`0 0 ${chart.width} ${chart.height}`} preserveAspectRatio="xMidYMid meet" aria-label="团队提交率趋势"><defs><linearGradient id="teamArea" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#1677ff" stopOpacity=".22"/><stop offset="1" stopColor="#1677ff" stopOpacity="0"/></linearGradient></defs>{[40, 64, 88, 112, 136].map((y) => <line key={y} x1={chart.left} y1={y} x2={chart.right} y2={y} className={y === 64 ? "team-goal" : "team-grid-line"}/>)}<polygon points={`${chart.left},${chart.baseline} ${line} ${chart.right},${chart.baseline}`} fill="url(#teamArea)"/><polyline points={line} className="team-line"/>{points.map((point, index) => <g key={point.date} className={index === points.length - 1 ? "team-data-point is-latest" : "team-data-point"}><title>{`${point.date}：${point.rate ?? "—"}%（${point.submitted} 人提交）`}</title><circle cx={point.x} cy={point.y} r="7" className="team-point-halo"/><circle cx={point.x} cy={point.y} r="3.4" className="team-point"/></g>)}</svg></div> : <div className="team-trend-empty">暂无可比较的历史日报</div>}<footer>{trend.map((item) => <span key={item.date}>{formatDay(item.date)}</span>)}</footer></div><div className="team-trend-metrics"><div><IconBell/><strong>{rosterTotal ? Math.round(submitted / rosterTotal * 100) : "—"}%</strong><span>今日提交率</span></div><div><IconUsers/><strong>{submitted} / {rosterTotal}</strong><span>已提交人数</span></div><div className={blockers ? "is-alert" : ""}><IconAlertTriangle/><strong>{blockers}</strong><span>阻塞事项</span></div><div className={reviews ? "is-warn" : ""}><IconAlertTriangle/><strong>{reviews}</strong><span>待决策</span></div></div></section>;
}
function monthBounds(date, offset = 0) {
  const [year, month] = date.split("-").map(Number);
  const value = new Date(year, month - 1 + offset, 1);
  const start = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-01`;
  const end = new Date(value.getFullYear(), value.getMonth() + 1, 0);
  return { start, end: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}` };
}

export default function TeamPage() {
  const [date, setDate] = useState(() => new URLSearchParams(window.location.search).get("date") || yesterdayStr());
  const [shortcutAnchorDate] = useState(todayStr);
  const [dashboard, setDashboard] = useState(null); const [reports, setReports] = useState([]);
  const [query, setQuery] = useState(""); const [department, setDepartment] = useState("all"); const [status, setStatus] = useState("all"); const [sortBy, setSortBy] = useState("attention");
  const [range, setRange] = useState("recent"); const [customDraft, setCustomDraft] = useState(null); const [customRange, setCustomRange] = useState(null);
  const [expandedDepartments, setExpandedDepartments] = useState(new Set()); const [selectedId, setSelectedId] = useState(null); const [syncing, setSyncing] = useState(false); const [error, setError] = useState("");
  const historyOptions = useMemo(() => {
    if (range === "month") return { historyFrom: monthBounds(shortcutAnchorDate).start, historyThrough: shortcutAnchorDate, historyLimit: 366 };
    if (range === "lastMonth") { const previousMonth = monthBounds(shortcutAnchorDate, -1); return { historyFrom: previousMonth.start, historyThrough: previousMonth.end, historyLimit: 366 }; }
    if (range === "custom" && customRange) return { historyFrom: customRange.start, historyThrough: customRange.end, historyLimit: 366 };
    return { historyThrough: shortcutAnchorDate, historyLimit: 10 };
  }, [customRange, range, shortcutAnchorDate]);
  const load = useCallback(async () => { setError(""); try { const next = await teamApi.dashboard(date, historyOptions); const details = await teamApi.reportDetails(next.date); setDashboard(next); setReports(details.reports || []); } catch (loadError) { setError(loadError.message); } }, [date, historyOptions]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 30000); return () => clearInterval(timer); }, [load]);
  useEffect(() => { if (!dashboard) return; setExpandedDepartments(new Set(dashboard.members.filter(needsAttention).map((member) => member.dept_name || "未设置部门"))); setSelectedId((current) => current && dashboard.members.some((member) => member.user_id === current) ? current : (dashboard.members.find(needsAttention) || dashboard.members[0])?.user_id || null); }, [dashboard?.date]);
  const reportByMember = useMemo(() => new Map(reports.map((report) => [report.user_id || report.user_name, report])), [reports]);
  const departments = useMemo(() => [...new Set((dashboard?.members || []).map((member) => member.dept_name || "未设置部门"))].sort((a, b) => a.localeCompare(b, "zh-CN")), [dashboard]);
  const scopedMembers = useMemo(() => (dashboard?.members || []).filter((member) => department === "all" || (member.dept_name || "未设置部门") === department), [dashboard, department]);
  const visibleMembers = useMemo(() => { const normalizedQuery = query.trim().toLocaleLowerCase(); return (dashboard?.members || []).filter((member) => { const memberDepartment = member.dept_name || "未设置部门"; if (department !== "all" && memberDepartment !== department) return false; if (status === "attention" && !needsAttention(member)) return false; if (status === "missing" && member.submitted) return false; if (status === "submitted" && !member.submitted) return false; return !normalizedQuery || `${member.name} ${memberDepartment}`.toLocaleLowerCase().includes(normalizedQuery); }).sort((a, b) => { if (sortBy === "trend") return (b.submissionHistory?.submissionRate ?? -1) - (a.submissionHistory?.submissionRate ?? -1) || b.attentionScore - a.attentionScore || a.name.localeCompare(b.name, "zh-CN"); if (sortBy === "workload") return b.workload - a.workload || b.attentionScore - a.attentionScore || a.name.localeCompare(b.name, "zh-CN"); if (sortBy === "name") return a.name.localeCompare(b.name, "zh-CN"); return b.attentionScore - a.attentionScore || b.workload - a.workload || a.name.localeCompare(b.name, "zh-CN"); }); }, [dashboard, department, query, sortBy, status]);
  const departmentGroups = useMemo(() => { const groups = new Map(); for (const member of visibleMembers) { const key = member.dept_name || "未设置部门"; groups.set(key, [...(groups.get(key) || []), member]); } return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "zh-CN")); }, [visibleMembers]);
  const allDepartmentsExpanded = departmentGroups.length > 0 && departmentGroups.every(([name]) => expandedDepartments.has(name));
  const selectedMember = dashboard?.members.find((member) => member.user_id === selectedId) || null;
  const scopedTrend = useMemo(() => (dashboard?.submissionTrend || []).map((item) => { const submitted = scopedMembers.filter((member) => member.submissionHistory?.submittedDates?.includes(item.date)).length; return { ...item, submitted, rate: scopedMembers.length ? Math.round(submitted / scopedMembers.length * 100) : null }; }), [dashboard, scopedMembers]);
  const submitted = scopedMembers.filter((member) => member.submitted).length;
  const blockers = scopedMembers.reduce((total, member) => total + member.blockers.length, 0); const reviews = scopedMembers.reduce((total, member) => total + member.review.length, 0);
  const syncNow = async () => { setSyncing(true); try { await workbenchApi.syncRun(date, ["dingtalk"]); await load(); } catch (syncError) { setError(syncError.message); } finally { setSyncing(false); } };
  const toggleDepartment = (name) => setExpandedDepartments((current) => { const next = new Set(current); next.has(name) ? next.delete(name) : next.add(name); return next; });
  const selectRange = (next) => { if (next === "custom") { const initial = customRange || { start: monthBounds(date).start, end: date }; setCustomDraft(initial); setCustomRange(initial); } setRange(next); };
  const applyCustomRange = () => { if (!customDraft?.start || !customDraft?.end || customDraft.start > customDraft.end) return setError("自定义范围的开始日期不能晚于结束日期。"); setError(""); setCustomRange(customDraft); setDate(customDraft.end); };
  useEffect(() => { if (department === "all" || !scopedMembers.length) return; if (!scopedMembers.some((member) => member.user_id === selectedId)) setSelectedId(scopedMembers[0].user_id); }, [department, scopedMembers, selectedId]);
  if (!dashboard && !error) return <div className="spinner">加载团队日报看板…</div>;
  if (!dashboard) return <div className="error">{error}</div>;
  return <div className="workspace-page team-page"><header className="workspace-head"><div><h1>团队日报</h1><p>掌握团队日报提交情况，及时发现风险，帮助团队更好地前进。</p></div><div className="team-head-actions"><DateNav date={date} onChange={setDate}/><SyncButton className="btn primary" onClick={syncNow} syncing={syncing}>立即同步团队日志</SyncButton></div></header>{error && <div className="error">{error}</div>}
    <section className="team-filter-bar"><span><IconCalendarEvent size={16}/>{dashboard.date}</span><button className={range === "recent" ? "is-active" : ""} onClick={() => selectRange("recent")}>近10天</button><button className={range === "month" ? "is-active" : ""} onClick={() => selectRange("month")}>本月</button><button className={range === "lastMonth" ? "is-active" : ""} onClick={() => selectRange("lastMonth")}>上月</button><button className={range === "custom" ? "is-active" : ""} onClick={() => selectRange("custom")}>自定义</button>{range === "custom" && customDraft && <span className="team-custom-range"><input type="date" value={customDraft.start} onChange={(event) => setCustomDraft((current) => ({ ...current, start: event.target.value }))}/><em>至</em><input type="date" value={customDraft.end} onChange={(event) => setCustomDraft((current) => ({ ...current, end: event.target.value }))}/><button onClick={applyCustomRange}>应用</button></span>}<div/><select value={department} onChange={(event) => setDepartment(event.target.value)} aria-label="部门筛选"><option value="all">全部部门</option>{departments.map((item) => <option key={item} value={item}>{item}</option>)}</select></section>
    <SubmissionTrend trend={scopedTrend} submitted={submitted} rosterTotal={scopedMembers.length} blockers={blockers} reviews={reviews}/>
    <div className="team-roster-layout"><section className="team-roster-panel"><div className="team-daily-sticky"><header className="team-roster-heading"><div><h2>部门成员</h2><p>显示 {visibleMembers.length}/{dashboard.members.length} 人 · 日报工作量 = 当日进行中事项 + 阻塞事项 + 待决策事项。</p></div></header>
      <div className="team-roster-filters"><label className="team-search"><IconSearch size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索成员姓名、工号或关键词…" aria-label="搜索成员或部门"/></label><label className="team-only-missing"><input type="checkbox" checked={status === "missing"} onChange={(event) => setStatus(event.target.checked ? "missing" : "all")}/> 仅看未提交</label><button className="team-expand-all" disabled={!departmentGroups.length} onClick={() => setExpandedDepartments(allDepartmentsExpanded ? new Set() : new Set(departmentGroups.map(([name]) => name)))}>{allDepartmentsExpanded ? "全部收起" : "全部展开"}</button><select value={sortBy} onChange={(event) => setSortBy(event.target.value)} aria-label="排序方式"><option value="attention">按部门排序</option><option value="trend">提交趋势</option><option value="workload">日报工作量</option><option value="name">姓名</option></select></div>
      <div className="team-column-head" aria-hidden="true"><span>成员</span><span>状态</span><span>提交趋势</span><span>连续缺交</span><span title="当日进行中事项、阻塞事项和待决策事项的数量之和">日报工作量</span><span>风险信号</span><span/></div>
      </div><div className="team-department-list">{departmentGroups.map(([name, members]) => { const open = expandedDepartments.has(name); const submitted = members.filter((member) => member.submitted).length; const riskCount = members.filter(needsAttention).length; return <section className="team-department" key={name}><button className="team-department__toggle" onClick={() => toggleDepartment(name)} aria-expanded={open}><span>{open ? <IconChevronDown size={18}/> : <IconChevronRight size={18}/>}<strong>{name}</strong></span><small>{members.length} 人 · 当日 {submitted}/{members.length} 已提交 · <b>{riskCount} 项关注</b></small></button>{open && <div className="team-member-rows">{members.map((member) => <div className="team-member-row" key={member.user_id}><div className="team-member-name"><strong>{member.name}</strong><small>{member.dept_name || "未设置部门"}</small></div><span className={`team-status team-status--${statusClass(member)}`}>{memberStatus(member)}</span><HistoryDots member={member} dates={dashboard.submissionHistoryDates || []}/><span className="team-member-number">{member.submissionHistory?.missingStreak ? `${member.submissionHistory.missingStreak} 日` : "—"}</span><span className="team-member-number">{member.workload || 0}</span><span className="team-risk-count">{member.blockers.length ? `${member.blockers.length} 阻塞` : ""}{member.blockers.length && member.review.length ? " · " : ""}{member.review.length ? `${member.review.length} 待决策` : ""}{!member.blockers.length && !member.review.length ? "—" : ""}</span><button className="team-view-button" onClick={() => setSelectedId(member.user_id)}>查看</button></div>)}</div>}</section>; })}{!departmentGroups.length && <div className="empty-state">没有匹配的成员。请调整搜索词或筛选条件。</div>}</div>
    </section><MemberInspector member={selectedMember} report={selectedMember ? reportByMember.get(selectedMember.user_id) : null} dates={dashboard.submissionHistoryDates || []} reportDate={dashboard.date} onClose={() => setSelectedId(null)}/></div>
  </div>;
}


