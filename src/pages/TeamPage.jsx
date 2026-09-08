import { useCallback, useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconFileText, IconX } from "@tabler/icons-react";
import DateNav from "../components/DateNav.jsx";
import { teamApi, todayStr, workbenchApi } from "../api.js";
import SyncButton from "../components/SyncButton.jsx";
import "./WorkspacePages.css";
import "./TeamPageEnhancements.css";

function formatTime(value){return value?new Date(value).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}):"尚未成功同步"}

function MemberDetail({member,report,onClose}){
  return <div className="member-detail-backdrop" role="presentation" onMouseDown={(event)=>event.target===event.currentTarget&&onClose()}><aside className="member-detail" role="dialog" aria-modal="true" aria-label={`${member.name}的日志详情`}><header><div><span className="member-detail__eyebrow">成员日志详情</span><h2>{member.name}</h2><p>{member.dept_name||"未设置部门"} · {member.submitted?`共提交 ${member.reportCount} 份日志`:"当日未提交"}</p></div><button className="member-detail__close" onClick={onClose} aria-label="关闭成员日志详情"><IconX size={20}/></button></header>{report?<><section className="member-summary"><strong>AI 小结</strong><p>{report.summary||"暂无小结，可直接查看下方原始日志字段。"}</p></section><div className="member-log-sections">{report.contents.filter((item)=>String(item.value||"").trim()&&!['[]','【】'].includes(String(item.value).trim())).map((item,index)=><section key={`${item.key}-${index}`}><h3>{item.key||"日志内容"}</h3><p>{item.value}</p></section>)}</div>{Boolean(report.blockers?.length)&&<section className="member-alert"><strong>阻塞</strong><ul>{report.blockers.map((item,index)=><li key={index}>{item}</li>)}</ul></section>}{Boolean(report.needs_review?.length)&&<section className="member-review"><strong>待主管决策</strong><ul>{report.needs_review.map((item,index)=><li key={index}>{item}</li>)}</ul></section>}</>:<div className="empty-state">该成员在所选日期没有可展示的日志明细。</div>}</aside></div>;
}

export default function TeamPage(){
  const [date,setDate]=useState(todayStr());
  const [pulse,setPulse]=useState(null);
  const [reports,setReports]=useState([]);
  const [availableDates,setAvailableDates]=useState([]);
  const [syncInfo,setSyncInfo]=useState(null);
  const [view,setView]=useState("attention");
  const [selected,setSelected]=useState(null);
  const [syncing,setSyncing]=useState(false);
  const [error,setError]=useState("");

  const load=useCallback(async()=>{
    setError("");
    try{
      const [nextPulse,nextReports,status,dates]=await Promise.all([workbenchApi.pulse(date),teamApi.reportDetails(date),workbenchApi.syncStatus(),teamApi.reportDates()]);
      setPulse(nextPulse);setReports(nextReports.reports||[]);setSyncInfo((status.items||[]).find((item)=>item.source==="dingtalk")||null);setAvailableDates(dates.dates||[]);
    }catch(e){setError(e.message)}
  },[date]);
  useEffect(()=>{load()},[load]);

  const reportByMember=useMemo(()=>new Map(reports.map((report)=>[report.user_id||report.user_name,report])),[reports]);
  const members=useMemo(()=>{const all=pulse?.members||[];if(view==="submitted")return all.filter((member)=>member.submitted);if(view==="all")return all;return all.filter((member)=>member.signalScore>0)},[pulse,view]);
  const syncNow=async()=>{setSyncing(true);setError("");try{await workbenchApi.syncRun(date,["dingtalk"]);await load()}catch(e){setError(e.message)}finally{setSyncing(false)}};

  if(!pulse&&!error)return <div className="spinner">加载中…</div>;
  return <div className="workspace-page"><header className="workspace-head"><div><h1>团队态势</h1><p>查看缺交、阻塞、待决策，并下钻阅读每位成员的完整日志</p></div><div className="team-head-actions"><DateNav date={date} onChange={setDate}/><SyncButton className="btn primary" onClick={syncNow} syncing={syncing}>立即同步团队日志</SyncButton></div></header>
    <section className="sync-banner"><span className={`sync-banner__dot sync-banner__dot--${syncInfo?.status||"waiting"}`}/><div><strong>钉钉日志每 15 分钟自动同步</strong><p>同步当天启用模板的日志 · 最近成功：{formatTime(syncInfo?.lastSuccessAt)}{syncInfo?.nextRunAt&&syncInfo.nextRunAt!=="on-startup"?` · 下次检查：${formatTime(syncInfo.nextRunAt)}`:""}</p>{syncInfo?.error&&<small>{syncInfo.error}</small>}</div></section>
    {!reports.length&&availableDates[0]&&availableDates[0]!==date&&<div className="recent-data-hint">所选日期暂无成员日志。最近有数据日期：<button onClick={()=>setDate(availableDates[0])}>{availableDates[0]}</button></div>}
    {error&&<div className="error">{error}</div>}{pulse&&<><div className="team-metrics"><div className="team-metric"><span>提交人数</span><strong>{pulse.submittedUnique}/{pulse.rosterTotal}</strong></div><div className="team-metric"><span>提交率</span><strong>{pulse.submissionRate==null?"—":`${pulse.submissionRate}%`}</strong></div><div className="team-metric"><span>阻塞</span><strong>{pulse.analysisStatus==="no_reports"?"—":pulse.blockers.length}</strong></div><div className="team-metric"><span>待决策</span><strong>{pulse.analysisStatus==="no_reports"?"—":pulse.reviewRequests.length}</strong></div></div>{pulse.analysisStatus==="no_reports"&&<div className="recent-data-hint">所选日期尚无成员日志，阻塞和待决策暂无法分析。</div>}
    <nav className="workspace-tabs" aria-label="团队成员筛选">{[["attention","需关注成员"],["submitted","已提交成员"],["all","完整名册"]].map(([key,label])=><button key={key} className={view===key?"is-active":""} onClick={()=>setView(key)}>{label}</button>)}</nav>
    <div className="member-grid">{members.map((member)=><article className={`member-card ${member.signalScore>0?"member-card--alert":""}`} key={member.user_id}><div className="member-card__head"><div><h3>{member.name}</h3><p>{member.dept_name||"未设置部门"}</p></div>{!member.submitted&&<span className="pill amber">{member.submissionState==="pending"?"待提交":"未提交"}</span>}</div><p>{member.submitted?`已提交 ${member.reportCount} 份`:member.submissionState==="pending"?"尚未提交，未到截止时间":"当日无日志"} · 阻塞 {member.submitted?member.blockers.length:"待分析"} · 待决策 {member.submitted?member.review.length:"待分析"}</p><button className="member-card__detail" onClick={()=>setSelected(member)}><IconFileText size={15}/>{member.submitted?"查看日志详情":"查看成员状态"}</button></article>)}{!members.length&&<div className="empty-state"><IconAlertTriangle size={20}/>{pulse.missingStatus==="pending"?"当前暂无需要关注成员，尚未提交的成员将在截止时间后纳入关注。":"当前筛选条件下没有成员。"}</div>}</div></>}
    {selected&&<MemberDetail member={selected} report={reportByMember.get(selected.user_id)||null} onClose={()=>setSelected(null)}/>}</div>;
}
