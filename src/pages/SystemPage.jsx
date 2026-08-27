import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { IconRefresh, IconSettings, IconServer } from "@tabler/icons-react";
import { api, todayStr, workbenchApi } from "../api.js";

export default function SystemPage() {
  const [sys, setSys] = useState(null);
  const [sync, setSync] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [templateName, setTemplateName] = useState("");
  const [syncing, setSyncing] = useState("");

  const loadSync = () => workbenchApi.syncStatus().then((status) => setSync(status.items || []));

  useEffect(() => {
    Promise.all([api.get("/system"), api.get("/sync/status"), api.get("/team/report-templates")]).then(([system,status,tpl])=>{setSys(system);setSync(status.items||[]);setTemplates(tpl.templates||[])}).catch(() => setSys({ error: true }));
  }, []);

  if (!sys) return <div className="spinner">加载中…</div>;

  const c = sys.configured || {};
  const Row = ({ label, ok }) => (
    <div className="row spread" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
      <span>{label}</span>
      <span className={`pill ${ok ? "green" : "gray"}`}>{ok ? "已配置" : "未配置"}</span>
    </div>
  );

  async function syncNow(source) {
    setSyncing(source);
    try { await workbenchApi.syncRun(todayStr(), [source]); } catch { /* 状态接口会返回具体错误 */ }
    await loadSync();
    setSyncing("");
  }

  const statusText = { success: "成功", error: "失败", running: "同步中", waiting: "等待配置", never: "等待首次同步" };

  return (
    <div>
      <PageHeader
        eyebrow="SYSTEM / INTEGRATIONS"
        title="设置"
        description="管理连接器、同步状态、日志模板与本地配置"
      />

      <div className="grid grid-2">
        <div className="panel">
          <div className="panel__head">
            <div className="panel__title"><span className="work-page-icon"><IconSettings size={22} stroke={1.75} /></span>数据源连接</div>
          </div>
          <Row label="Outlook（Microsoft Graph）" ok={c.outlook} />
          <Row label="钉钉（企业内部应用）" ok={c.dingtalk} />
          <Row label="AI 模型" ok={c.ai} />
          <Row label="AI 热点" ok={c.aiHot} />
          <div className="row" style={{ marginTop: 14 }}>
            {!c.outlook && <a className="btn primary" href="/mail-setup">连接 Outlook</a>}
            {!c.dingtalk && <a className="btn primary" href="/oauth/dingtalk">连接钉钉</a>}
          </div>
          {c.outlook && c.dingtalk && <div className="pill green" style={{ marginTop: 10 }}>已全部接入</div>}
        </div>

        <div className="panel">
          <div className="panel__head">
            <div className="panel__title"><span className="work-page-icon"><IconServer size={22} stroke={1.75} /></span>运行信息</div>
          </div>
          <div className="meta">AI 提供方：{sys.aiProvider}</div>
          <div className="meta">演示数据兜底：{sys.useDemoData ? "开启" : "关闭"}</div>
          <div className="meta">数据库：.local/workbench.sqlite（本地优先，数据不出本机）</div>
          <div className="panel__title" style={{ fontSize: 15, marginTop: 16 }}><div className="sub">如何接入真实数据</div></div>
          <div className="meta">
            1. 复制 .env.example 为 .env；<br />
            2. 在 Azure Entra 注册「多租户」应用（无需 Secret），权限 Mail.Read + offline_access，并登记回调 <code>{sys.publicBaseUrl}/api/outlook/oauth/callback</code>；<br />
            3. 填入 OUTLOOK_ENTRA_CLIENT_ID、OUTLOOK_OAUTH_REDIRECT_URI、OUTLOOK_TOKEN_ENCRYPTION_KEY（openssl rand -base64 32 生成）与 DEEPSEEK_API_KEY；<br />
            4. 重启服务，进入「邮件处理」页完成隐私同意并连接 Outlook。
          </div>
        </div>
      </div>
      <div className="grid grid-2" style={{marginTop:14}}><div className="panel"><div className="panel__head"><div><div className="panel__title">自动同步</div><div className="meta" style={{marginTop:4}}>服务启动后自动运行，无需停留在页面</div></div><button className="btn sm" onClick={loadSync}><IconRefresh size={14}/>刷新状态</button></div>{sync.map((item)=><section key={item.source} style={{padding:"13px 0",borderBottom:"1px solid var(--line)"}}><div className="row spread"><div><strong>{item.label}</strong><div className="meta">每 {item.intervalMinutes} 分钟 · {item.scope}</div></div><span className={`pill ${item.status==="success"?"green":item.status==="error"?"red":"gray"}`}>{statusText[item.status]||item.status}</span></div><div className="meta" style={{marginTop:7}}>最近尝试：{item.lastAttemptAt?new Date(item.lastAttemptAt).toLocaleString("zh-CN"):"—"}<br/>最近成功：{item.lastSuccessAt?new Date(item.lastSuccessAt).toLocaleString("zh-CN"):"—"}{item.nextRunAt&&item.nextRunAt!=="on-startup"?<><br/>下次检查：{new Date(item.nextRunAt).toLocaleString("zh-CN")}</>:null}{item.recordCount!=null?<><br/>最近变更：{item.recordCount} 条</>:null}</div>{item.error&&<div className="meta" style={{color:"var(--danger,#c2413b)",marginTop:5}}>{item.error}</div>}{item.warning&&<div className="meta" style={{color:"#9a6700",marginTop:5}}>{item.warning}</div>}<button className="btn sm" style={{marginTop:8}} disabled={!item.ready||syncing===item.source} onClick={()=>syncNow(item.source)}>{syncing===item.source?"同步中…":"立即同步此数据源"}</button></section>)}</div><div className="panel"><div className="panel__head"><div className="panel__title">钉钉日志模板</div></div><div className="row"><input value={templateName} onChange={(e)=>setTemplateName(e.target.value)} placeholder="模板名称"/><button className="btn primary sm" onClick={async()=>{if(!templateName.trim())return;const r=await api.post("/team/report-templates",{name:templateName});setTemplates((x)=>[...x,r.template]);setTemplateName("")}}>添加</button></div>{templates.map((t)=><div className="row spread" key={t.id} style={{padding:"8px 0",borderBottom:"1px solid var(--line)"}}><span>{t.name}</span><button className="btn sm" onClick={async()=>{await api.put(`/team/report-templates/${t.id}`,{enabled:!t.enabled});setTemplates((x)=>x.map((v)=>v.id===t.id?{...v,enabled:v.enabled?0:1}:v))}}>{t.enabled?"已启用":"已停用"}</button></div>)}</div></div>
    </div>
  );
}
