import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { IconSettings, IconServer } from "@tabler/icons-react";
import { api } from "../api.js";

export default function SystemPage() {
  const [sys, setSys] = useState(null);

  useEffect(() => {
    api.get("/system").then(setSys).catch(() => setSys({ error: true }));
  }, []);

  if (!sys) return <div className="spinner">加载中…</div>;

  const c = sys.configured || {};
  const Row = ({ label, ok }) => (
    <div className="row spread" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
      <span>{label}</span>
      <span className={`pill ${ok ? "green" : "gray"}`}>{ok ? "已配置" : "未配置"}</span>
    </div>
  );

  return (
    <div>
      <PageHeader
        eyebrow="SYSTEM / INTEGRATIONS"
        title="系统 / 接入"
        description="配置数据源连接，未配置时使用演示数据"
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
            {!c.outlook && <a className="btn primary" href="/emails">连接 Outlook</a>}
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
            2. 在 Azure Entra 注册「多租户」应用（无需 Secret），权限 Mail.Read + offline_access，并登记回调 <code>http://127.0.0.1:8787/api/outlook/oauth/callback</code>；<br />
            3. 填入 OUTLOOK_ENTRA_CLIENT_ID、OUTLOOK_OAUTH_REDIRECT_URI、OUTLOOK_TOKEN_ENCRYPTION_KEY（openssl rand -base64 32 生成）与 DEEPSEEK_API_KEY；<br />
            4. 重启服务，进入「邮件处理」页完成隐私同意并连接 Outlook。
          </div>
        </div>
      </div>
    </div>
  );
}
