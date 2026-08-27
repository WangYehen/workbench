import { useSearchParams } from "react-router-dom";
import DailyReportPage from "./DailyReportPage.jsx";
import WeeklyReportPage from "./WeeklyReportPage.jsx";
import ReviewPage from "./ReviewPage.jsx";
import "./WorkspacePages.css";

export default function ReportsPage(){const [params,setParams]=useSearchParams();const tab=params.get("tab")||"daily";return <div className="workspace-page"><header className="workspace-head"><div><h1>汇报</h1><p>生成、编辑并追溯主管日报、周报与个人复盘</p></div></header><nav className="workspace-tabs">{[["daily","日报"],["weekly","周报"],["review","个人复盘"]].map(([k,l])=><button key={k} className={tab===k?"is-active":""} onClick={()=>setParams({tab:k})}>{l}</button>)}</nav>{tab==="daily"?<DailyReportPage embedded/>:tab==="weekly"?<WeeklyReportPage embedded/>:<ReviewPage embedded/>}</div>}
