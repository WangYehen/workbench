import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { IconRefresh } from "@tabler/icons-react";
import Emails2Page from "./Emails2Page.jsx";
import TodosPage from "./TodosPage.jsx";
import DateNav from "../components/DateNav.jsx";
import { todayStr, workbenchApi } from "../api.js";
import "./WorkspacePages.css";
import { PriorityBadge } from "../components/PriorityBadge";

export default function ActionsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "attention";
  const [date, setDate] = useState(todayStr());
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [outlookStatus, setOutlookStatus] = useState(null);
  const syncEmailRef = useRef(null);
  useEffect(() => { workbenchApi.attention(date).then((r) => setItems(r.items)).catch((e) => setError(e.message)); }, [date]);
  const setTab = (next) => setParams(next === "attention" ? {} : { tab: next });
  const setEmailSync = useCallback((sync) => { syncEmailRef.current = sync; }, []);
  const lastSuccess = outlookStatus?.lastSyncAt
    ? new Date(outlookStatus.lastSyncAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
    : "—";
  return <div className="workspace-page">
    <header className="workspace-head"><div><h1>行动中心</h1><p>从发现问题到分类、处理、转待办和跟踪的统一入口</p></div>{tab === "attention" && <DateNav date={date} onChange={setDate}/>} {tab === "email" && <div className="actions-mail-sync"><span><i />最近成功 {lastSuccess}</span><button className="btn primary" type="button" disabled={!syncEmailRef.current} onClick={() => syncEmailRef.current?.()}><IconRefresh size={16} />立即同步</button></div>}</header>
    <nav className="workspace-tabs" aria-label="行动中心视图">{[["attention","注意事项"],["email","邮件"],["tasks","待办"]].map(([key,label])=><button key={key} className={tab===key?"is-active":""} onClick={()=>setTab(key)}>{label}</button>)}</nav>
    {error && <div className="error">{error}</div>}
    {tab === "email" && <Emails2Page embedded onStatusChange={setOutlookStatus} onSyncReady={setEmailSync} />}
    {tab === "tasks" && <TodosPage embedded />}
    {tab === "attention" && <div className="attention-list">{items.map((item)=><article className="attention-item" key={item.id}><PriorityBadge priority={item.priority}/><div><h3>{item.title}</h3><p>{item.detail || ""}</p></div><span className="attention-item__action">{item.recommendedAction}</span></article>)}{!items.length&&<div className="empty-state">该日期没有待处理注意事项。</div>}</div>}
  </div>;
}
