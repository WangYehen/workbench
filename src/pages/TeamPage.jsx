import { useCallback, useEffect, useMemo, useState } from "react";
import { IconChevronDown, IconChevronRight, IconFileText, IconSearch, IconX } from "@tabler/icons-react";
import DateNav from "../components/DateNav.jsx";
import { teamApi, workbenchApi } from "../api.js";
import SyncButton from "../components/SyncButton.jsx";
import "./WorkspacePages.css";
import "./TeamPageEnhancements.css";

function yesterdayStr() {
  const value = new Date();
  value.setDate(value.getDate() - 1);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
function formatTime(value) { return value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "尚未成功同步"; }
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
function MemberInspector({ member, report, dates, onClose }) {
  if (!member) return <aside className="team-inspector"><div className="team-inspector__empty"><IconFileText size={24}/><strong>选择一位成员</strong><span>在名册中点击“查看”，即可阅读日报摘要、风险信号与原始日报。</span></div></aside>;
  const history = member.submissionHistory || {};
  const rawContents = report?.contents?.filter((item) => String(item.value || "").trim()) || [];
  return <aside className="team-inspector" aria-label={`${member.name}的只读详情`}>
    <header className="team-inspector__head"><div><span>成员详情 · 只读</span><h2>{member.name}</h2><p>{member.dept_name || "未设置部门"} · {memberStatus(member)}</p></div><button onClick={onClose} aria-label="关闭成员详情"><IconX size={18}/></button></header>
    <section className="member-detail-stats"><div><span>近 {history.totalDates || 0} 日提交</span><strong>{history.totalDates ? `${history.submittedCount}/${history.totalDates}` : "暂无"}</strong></div><div><span>连续缺交</span><strong>{history.missingStreak ? `${history.missingStreak} 日` : "—"}</strong></div><div><span>日报工作量</span><strong>{member.workload || 0}</strong></div></section>
    <section className="member-detail-section"><h3>提交趋势</h3><HistoryDots member={member} dates={dates}/><p className="member-detail-hint">仅按团队实际有日报记录的日期统计，不将节假日或全员未填计入缺交。</p></section>
    <section className="member-detail-section member-detail-section--summary"><h3>日报摘要</h3><p>{member.summary || (member.submitted ? "日报暂无可用摘要。" : "该成员当日未提交日报，暂无日报摘要。")}</p></section>
    <RiskList title="阻塞" items={member.blockers || []} type="blocker" /><RiskList title="待决策" items={member.review || []} type="review" />
    <section className="member-detail-section"><h3>原始日报</h3>{rawContents.length ? <div className="member-raw-report">{rawContents.map((item, index) => <div key={`${item.key}-${index}`}><strong>{item.key || "日志内容"}</strong><p>{item.value}</p></div>)}</div> : <p className="member-detail-muted">{member.submitted ? "暂无可展示的原始日报字段。" : "未提交日报，因此没有原始日报内容。"}</p>}</section>
  </aside>;
}
function SubmissionTrend({ trend }) {
  if (!trend.length) return <section className="team-trend-panel"><div><span className="team-panel-eyebrow">团队提交趋势</span><h2>暂无可比较的历史日报</h2><p>团队产生日报后，这里会展示最近 10 个有效日报日期的提交率变化。</p></div></section>;
  return <section className="team-trend-panel"><div className="team-trend-copy"><span className="team-panel-eyebrow">团队提交趋势</span><h2>最近 {trend.length} 个有效日报日期</h2><p>只统计团队实际有日报记录的日期。</p></div><div className="team-trend-bars" aria-label="团队提交率趋势">{trend.map((item) => <div className="team-trend-bar" key={item.date}><span>{item.rate ?? "—"}{item.rate !== null ? "%" : ""}</span><div><i style={{ height: `${Math.max(item.rate || 0, 4)}%` }}/></div><small>{formatDay(item.date)}</small></div>)}</div></section>;
}

export default function TeamPage() {
  const [date, setDate] = useState(() => new URLSearchParams(window.location.search).get("date") || yesterdayStr());
  const [dashboard, setDashboard] = useState(null); const [reports, setReports] = useState([]); const [syncInfo, setSyncInfo] = useState(null);
  const [query, setQuery] = useState(""); const [department, setDepartment] = useState("all"); const [status, setStatus] = useState("all"); const [sortBy, setSortBy] = useState("attention");
  const [expandedDepartments, setExpandedDepartments] = useState(new Set()); const [selectedId, setSelectedId] = useState(null); const [syncing, setSyncing] = useState(false); const [error, setError] = useState("");
  const load = useCallback(async () => { setError(""); try { const next = await teamApi.dashboard(date); const [details, syncStatus] = await Promise.all([teamApi.reportDetails(next.date), workbenchApi.syncStatus()]); setDashboard(next); setReports(details.reports || []); setSyncInfo((syncStatus.items || []).find((item) => item.source === "dingtalk") || null); } catch (loadError) { setError(loadError.message); } }, [date]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 30000); return () => clearInterval(timer); }, [load]);
  useEffect(() => { if (!dashboard) return; setExpandedDepartments(new Set(dashboard.members.filter(needsAttention).map((member) => member.dept_name || "未设置部门"))); setSelectedId((current) => current && dashboard.members.some((member) => member.user_id === current) ? current : (dashboard.members.find(needsAttention) || dashboard.members[0])?.user_id || null); }, [dashboard?.date]);
  const reportByMember = useMemo(() => new Map(reports.map((report) => [report.user_id || report.user_name, report])), [reports]);
  const departments = useMemo(() => [...new Set((dashboard?.members || []).map((member) => member.dept_name || "未设置部门"))].sort((a, b) => a.localeCompare(b, "zh-CN")), [dashboard]);
  const visibleMembers = useMemo(() => { const normalizedQuery = query.trim().toLocaleLowerCase(); return (dashboard?.members || []).filter((member) => { const memberDepartment = member.dept_name || "未设置部门"; if (department !== "all" && memberDepartment !== department) return false; if (status === "attention" && !needsAttention(member)) return false; if (status === "missing" && member.submitted) return false; if (status === "submitted" && !member.submitted) return false; return !normalizedQuery || `${member.name} ${memberDepartment}`.toLocaleLowerCase().includes(normalizedQuery); }).sort((a, b) => { if (sortBy === "trend") return (b.submissionHistory?.submissionRate ?? -1) - (a.submissionHistory?.submissionRate ?? -1) || b.attentionScore - a.attentionScore || a.name.localeCompare(b.name, "zh-CN"); if (sortBy === "workload") return b.workload - a.workload || b.attentionScore - a.attentionScore || a.name.localeCompare(b.name, "zh-CN"); if (sortBy === "name") return a.name.localeCompare(b.name, "zh-CN"); return b.attentionScore - a.attentionScore || b.workload - a.workload || a.name.localeCompare(b.name, "zh-CN"); }); }, [dashboard, department, query, sortBy, status]);
  const departmentGroups = useMemo(() => { const groups = new Map(); for (const member of visibleMembers) { const key = member.dept_name || "未设置部门"; groups.set(key, [...(groups.get(key) || []), member]); } return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "zh-CN")); }, [visibleMembers]);
  const selectedMember = dashboard?.members.find((member) => member.user_id === selectedId) || null;
  const submissionRate = dashboard?.rosterTotal ? Math.round((dashboard.submitted / dashboard.rosterTotal) * 100) : null;
  const blockers = dashboard?.interventions.filter((item) => item.type === "blocker").length || 0; const reviews = dashboard?.interventions.filter((item) => item.type === "review").length || 0;
  const syncNow = async () => { setSyncing(true); try { await workbenchApi.syncRun(date, ["dingtalk"]); await load(); } catch (syncError) { setError(syncError.message); } finally { setSyncing(false); } };
  const toggleDepartment = (name) => setExpandedDepartments((current) => { const next = new Set(current); next.has(name) ? next.delete(name) : next.add(name); return next; });
  if (!dashboard && !error) return <div className="spinner">加载团队日报看板…</div>;
  if (!dashboard) return <div className="error">{error}</div>;
  return <div className="workspace-page team-page"><header className="workspace-head"><div><h1>团队日报态势</h1><p>{dashboard.isFallbackDate ? `${dashboard.date} 是最近有日报的日期` : `${dashboard.date} 团队日报汇总`}</p></div><div className="team-head-actions"><DateNav date={date} onChange={setDate}/><SyncButton className="btn primary" onClick={syncNow} syncing={syncing}>立即同步团队日志</SyncButton></div></header>{error && <div className="error">{error}</div>}
    <section className="sync-banner"><span className={`sync-banner__dot sync-banner__dot--${syncInfo?.status || "waiting"}`}/><div><strong>钉钉日志每 15 分钟自动同步</strong><p>最近成功：{formatTime(syncInfo?.lastSuccessAt)} · 当前展示 {dashboard.submitted}/{dashboard.rosterTotal} 人提交</p></div></section>
    <div className="team-metrics"><div className="team-metric"><span>提交人数</span><strong>{dashboard.submitted}/{dashboard.rosterTotal}</strong></div><div className="team-metric"><span>提交率</span><strong>{submissionRate === null ? "—" : `${submissionRate}%`}</strong></div><div className="team-metric"><span>阻塞</span><strong>{blockers}</strong></div><div className="team-metric"><span>待决策</span><strong>{reviews}</strong></div></div>
    <SubmissionTrend trend={dashboard.submissionTrend || []}/>
    <div className="team-roster-layout"><section className="team-roster-panel"><header className="team-roster-heading"><div><span className="team-panel-eyebrow">成员名册</span><h2>按部门浏览团队日报</h2><p>显示 {visibleMembers.length}/{dashboard.members.length} 人 · 日报工作量仅统计日报内的进行中、阻塞和待决策事项。</p></div></header>
      <div className="team-roster-filters"><label className="team-search"><IconSearch size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索成员或部门" aria-label="搜索成员或部门"/></label><select value={department} onChange={(event) => setDepartment(event.target.value)} aria-label="部门筛选"><option value="all">全部部门</option>{departments.map((item) => <option key={item} value={item}>{item}</option>)}</select><select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="状态筛选"><option value="all">全部状态</option><option value="attention">需关注</option><option value="missing">未提交</option><option value="submitted">已提交</option></select><select value={sortBy} onChange={(event) => setSortBy(event.target.value)} aria-label="排序方式"><option value="attention">关注程度</option><option value="trend">提交趋势</option><option value="workload">日报工作量</option><option value="name">姓名</option></select></div>
      <div className="team-column-head" aria-hidden="true"><span>成员</span><span>状态</span><span>提交趋势</span><span>连续缺交</span><span>日报工作量</span><span>风险信号</span><span/></div>
      <div className="team-department-list">{departmentGroups.map(([name, members]) => { const open = expandedDepartments.has(name); const submitted = members.filter((member) => member.submitted).length; const riskCount = members.filter(needsAttention).length; return <section className="team-department" key={name}><button className="team-department__toggle" onClick={() => toggleDepartment(name)} aria-expanded={open}><span>{open ? <IconChevronDown size={18}/> : <IconChevronRight size={18}/>}<strong>{name}</strong></span><small>{members.length} 人 · 当日 {submitted}/{members.length} 已提交 · <b>{riskCount} 项关注</b></small></button>{open && <div className="team-member-rows">{members.map((member) => <div className="team-member-row" key={member.user_id}><div className="team-member-name"><strong>{member.name}</strong><small>{member.dept_name || "未设置部门"}</small></div><span className={`team-status team-status--${statusClass(member)}`}>{memberStatus(member)}</span><HistoryDots member={member} dates={dashboard.submissionHistoryDates || []}/><span className="team-member-number">{member.submissionHistory?.missingStreak ? `${member.submissionHistory.missingStreak} 日` : "—"}</span><span className="team-member-number">{member.workload || 0}</span><span className="team-risk-count">{member.blockers.length ? `${member.blockers.length} 阻塞` : ""}{member.blockers.length && member.review.length ? " · " : ""}{member.review.length ? `${member.review.length} 待决策` : ""}{!member.blockers.length && !member.review.length ? "—" : ""}</span><button className="team-view-button" onClick={() => setSelectedId(member.user_id)}>查看</button></div>)}</div>}</section>; })}{!departmentGroups.length && <div className="empty-state">没有匹配的成员。请调整搜索词或筛选条件。</div>}</div>
    </section><MemberInspector member={selectedMember} report={selectedMember ? reportByMember.get(selectedMember.user_id) : null} dates={dashboard.submissionHistoryDates || []} onClose={() => setSelectedId(null)}/></div>
  </div>;
}
