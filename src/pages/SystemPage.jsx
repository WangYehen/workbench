import { useEffect, useState } from "react";
import { IconBrain, IconRefresh, IconServer, IconSettings } from "@tabler/icons-react";
import { DeleteButton } from "../components/DeleteButton";
import { PageHeader } from "../components/PageHeader";
import { api, teamApi, todayStr, workbenchApi } from "../api.js";
import "./SystemPage.css";

const statusText = { success: "成功", error: "失败", running: "同步中", waiting: "等待配置", never: "等待首次同步" };
const aiProviderNames = { opencode: "OpenCode 免费模型", codex: "Codex CLI", ollama: "Ollama", deepseek: "DeepSeek API", openai: "OpenAI API", claude: "Claude API", local: "本地规则" };

function ConfigRow({ label, ok }) {
  return <div className="row spread" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}><span>{label}</span><span className={`pill ${ok ? "green" : "gray"}`}>{ok ? "已配置" : "未配置"}</span></div>;
}

function routeText(route = []) {
  return route.map((id) => aiProviderNames[id] || id).join(" → ");
}

function AiProviderCard({ provider }) {
  const ready = Boolean(provider.ready);
  return <div className={`settings-ai-provider ${ready ? "is-ready" : "is-unavailable"}`}>
    <div className="row spread settings-ai-provider__head">
      <strong>{provider.label || aiProviderNames[provider.id] || provider.id}</strong>
      <span className={`pill ${ready ? "green" : "gray"}`}>{ready ? "可用" : "不可用"}</span>
    </div>
    <div className="meta">{provider.version || provider.detail || "未检测到"}</div>
    {provider.version && provider.detail ? <div className="meta">{provider.detail}</div> : null}
    {provider.models?.length ? <div className="settings-ai-models" title={provider.models.join("\n")}>{provider.models.length} 个模型 · {provider.models.slice(0, 2).join("、")}{provider.models.length > 2 ? "…" : ""}</div> : null}
  </div>;
}

export default function SystemPage() {
  const [sys, setSys] = useState(null);
  const [sync, setSync] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [templateName, setTemplateName] = useState("");
  const [templateError, setTemplateError] = useState("");
  const [syncing, setSyncing] = useState("");
  const [deletingTemplateId, setDeletingTemplateId] = useState(null);
  const [refreshingAi, setRefreshingAi] = useState(false);
  const [aiError, setAiError] = useState("");

  const loadSync = () => workbenchApi.syncStatus().then((status) => setSync(status.items || []));

  useEffect(() => {
    Promise.all([api.get("/system"), api.get("/sync/status"), teamApi.templateList()])
      .then(([system, status, templateResult]) => {
        setSys(system);
        setSync(status.items || []);
        setTemplates(templateResult.templates || []);
      })
      .catch(() => setSys({ error: true }));
  }, []);

  async function syncNow(source) {
    setSyncing(source);
    try { await workbenchApi.syncRun(todayStr(), [source]); } catch { /* 状态接口会返回具体错误。 */ }
    await loadSync();
    setSyncing("");
  }

  async function refreshAi() {
    setRefreshingAi(true);
    setAiError("");
    try {
      const aiRouting = await api.post("/system/ai/refresh");
      setSys((current) => ({ ...current, aiRouting, aiProvider: aiRouting.modeLabel }));
    } catch (error) {
      setAiError(error.message || "AI 来源检测失败");
    } finally {
      setRefreshingAi(false);
    }
  }

  async function addTemplate() {
    const name = templateName.trim();
    if (!name) return;
    setTemplateError("");
    try {
      const result = await teamApi.templateCreate(name);
      setTemplates((current) => [...current, result.template]);
      setTemplateName("");
    } catch (error) { setTemplateError(error.message || "添加模板失败"); }
  }

  async function toggleTemplate(template) {
    setTemplateError("");
    try {
      await teamApi.templateUpdate(template.id, { enabled: !template.enabled });
      setTemplates((current) => current.map((item) => item.id === template.id ? { ...item, enabled: item.enabled ? 0 : 1 } : item));
    } catch (error) { setTemplateError(error.message || "更新模板失败"); }
  }

  async function deleteTemplate(template) {
    if (!window.confirm(`删除模板「${template.name}」？已同步的历史日志会保留，但后续将不再同步此模板。`)) return;
    setTemplateError("");
    setDeletingTemplateId(template.id);
    try {
      await teamApi.templateDelete(template.id);
      setTemplates((current) => current.filter((item) => item.id !== template.id));
    } catch (error) {
      setTemplateError(error.message || "删除模板失败");
    } finally {
      setDeletingTemplateId(null);
    }
  }

  if (!sys) return <div className="spinner">加载中…</div>;
  const configured = sys.configured || {};

  return <div>
    <PageHeader eyebrow="SYSTEM / INTEGRATIONS" title="设置" description="管理连接器、同步状态、日志模板与本地配置" />

    <div className="grid grid-2">
      <div className="panel">
        <div className="panel__head"><div className="panel__title"><span className="work-page-icon"><IconSettings size={22} stroke={1.75} /></span>数据源连接</div></div>
        <ConfigRow label="Outlook（Microsoft Graph）" ok={configured.outlook} />
        <ConfigRow label="钉钉（企业内部应用）" ok={configured.dingtalk} />
        <ConfigRow label="AI 模型" ok={configured.ai} />
        <ConfigRow label="AI 热点" ok={configured.aiHot} />
        <div className="row" style={{ marginTop: 14 }}>
          {!configured.outlook && <a className="btn primary" href="/mail-setup">连接 Outlook</a>}
          {!configured.dingtalk && <a className="btn primary" href="/oauth/dingtalk">连接钉钉</a>}
        </div>
        {configured.outlook && configured.dingtalk && <div className="pill green" style={{ marginTop: 10 }}>已全部接入</div>}
      </div>

      <div className="panel">
        <div className="panel__head"><div className="panel__title"><span className="work-page-icon"><IconServer size={22} stroke={1.75} /></span>运行信息</div></div>
        <div className="meta">AI 提供方：{sys.aiProvider}</div>
        <div className="meta">演示数据兜底：{sys.useDemoData ? "开启" : "关闭"}</div>
        <div className="meta">数据库：.local/workbench.sqlite（数据库仅保存在本机；AI 输入按下方路由策略处理）</div>
        <div className="panel__title" style={{ fontSize: 15, marginTop: 16 }}><div className="sub">如何接入真实数据</div></div>
        <div className="meta">
          1. 复制 .env.example 为 .env；<br />
          2. 在 Azure Entra 注册「多租户」应用（无需 Secret），权限 Mail.Read + offline_access，并登记回调 <code>{sys.publicBaseUrl}/api/outlook/oauth/callback</code>；<br />
          3. 填入 OUTLOOK_ENTRA_CLIENT_ID、OUTLOOK_OAUTH_REDIRECT_URI、OUTLOOK_TOKEN_ENCRYPTION_KEY（openssl rand -base64 32 生成）；<br />
          4. 重启服务，进入「邮件处理」页完成隐私同意并连接 Outlook。AI 来源可独立配置，不影响邮箱连接。
        </div>
      </div>
    </div>

    <section className="panel settings-ai-panel">
      <div className="panel__head">
        <div>
          <div className="panel__title"><span className="work-page-icon"><IconBrain size={22} stroke={1.75} /></span>AI 内容生成来源</div>
          <div className="meta settings-ai-subtitle">当前策略：{sys.aiRouting?.modeLabel || sys.aiProvider || "未检测"}</div>
        </div>
        <button className="btn sm" type="button" disabled={refreshingAi} onClick={refreshAi}><IconRefresh size={14} />{refreshingAi ? "检测中…" : "刷新检测"}</button>
      </div>
      {sys.aiRouting ? <>
        <div className="settings-ai-routes">
          <div><span>普通内容</span><strong>{routeText(sys.aiRouting.routes?.general)}</strong></div>
          <div><span>邮件内容</span><strong>{routeText(sys.aiRouting.routes?.sensitive)}</strong></div>
        </div>
        {sys.aiRouting.codex ? <div className="meta settings-ai-codex-config">Codex CLI 实际调用：<strong>{sys.aiRouting.codex.model}</strong> · 推理强度 <strong>{sys.aiRouting.codex.reasoningEffort}</strong></div> : null}
        <div className="settings-ai-provider-grid">
          {sys.aiRouting.providers?.map((provider) => <AiProviderCard key={provider.id} provider={provider} />)}
        </div>
        <div className="settings-ai-privacy" role="note">
          <strong>隐私边界：</strong>{sys.aiRouting.privacy} 普通内容使用 OpenCode 免费模型时会发送给对应模型服务；通过 <code>AI_ROUTING_MODE=smart</code> 明确启用。
        </div>
        <div className="settings-ai-privacy" role="status">
          <strong>本地 AI 队列：</strong>排队 {sys.aiQueue?.queued || 0} · 运行中 {sys.aiQueue?.running || 0} · 已完成 {sys.aiQueue?.ready || 0} · 失败 {sys.aiQueue?.failed || 0}
          {sys.aiQueue?.averageDurationMs != null ? <> · 平均耗时 {(sys.aiQueue.averageDurationMs / 1000).toFixed(1)} 秒</> : null}
          {sys.aiQueue?.recentSuccess ? <> · 最近真实生成：{new Date(sys.aiQueue.recentSuccess.finished_at).toLocaleString("zh-CN")}</> : null}
          {sys.aiQueue?.recentFailure ? <> · 最近失败：{sys.aiQueue.recentFailure.kind}</> : null}
        </div>
      </> : <div className="meta">AI 来源状态暂不可用，请点击“刷新检测”。</div>}
      {aiError ? <div className="settings-template-error" role="alert">{aiError}</div> : null}
    </section>

    <div className="grid grid-2" style={{ marginTop: 14 }}>
      <div className="panel">
        <div className="panel__head"><div><div className="panel__title">自动同步</div><div className="meta" style={{ marginTop: 4 }}>服务启动后自动运行，无需停留在页面</div></div><button className="btn sm" onClick={loadSync}><IconRefresh size={14} />刷新状态</button></div>
        {sync.map((item) => <section key={item.source} style={{ padding: "13px 0", borderBottom: "1px solid var(--line)" }}>
          <div className="row spread"><div><strong>{item.label}</strong><div className="meta">每 {item.intervalMinutes} 分钟 · {item.scope}</div></div><span className={`pill ${item.status === "success" ? "green" : item.status === "error" ? "red" : "gray"}`}>{statusText[item.status] || item.status}</span></div>
          <div className="meta" style={{ marginTop: 7 }}>
            最近尝试：{item.lastAttemptAt ? new Date(item.lastAttemptAt).toLocaleString("zh-CN") : "—"}<br />
            最近成功：{item.lastSuccessAt ? new Date(item.lastSuccessAt).toLocaleString("zh-CN") : "—"}
            {item.nextRunAt && item.nextRunAt !== "on-startup" ? <><br />下次检查：{new Date(item.nextRunAt).toLocaleString("zh-CN")}</> : null}
            {item.recordCount != null ? <><br />最近变更：{item.recordCount} 条</> : null}
          </div>
          {item.error && <div className="meta" style={{ color: "var(--danger,#c2413b)", marginTop: 5 }}>{item.error}</div>}
          <button className="btn sm" style={{ marginTop: 8 }} disabled={!item.ready || syncing === item.source} onClick={() => syncNow(item.source)}>{syncing === item.source ? "同步中…" : "立即同步此数据源"}</button>
        </section>)}
      </div>

      <div className="panel">
        <div className="panel__head"><div className="panel__title">钉钉日志模板</div></div>
        <div className="row"><input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="模板名称" /><button className="btn primary sm" onClick={addTemplate}>添加</button></div>
        {templateError && <div className="settings-template-error" role="alert">{templateError}</div>}
        {templates.map((template) => <div className="row spread settings-template-row" key={template.id}>
          <span>{template.name}</span>
          <div className="settings-template-actions">
            <button className={`btn sm settings-template-toggle ${template.enabled ? "is-enabled" : "is-disabled"}`} onClick={() => toggleTemplate(template)}>{template.enabled ? "已启用" : "已停用"}</button>
            <DeleteButton className="settings-template-delete" aria-label={`删除模板 ${template.name}`} title="删除模板" disabled={deletingTemplateId === template.id} onClick={() => deleteTemplate(template)}>{deletingTemplateId === template.id ? "删除中" : "删除"}</DeleteButton>
          </div>
        </div>)}
      </div>
    </div>
  </div>;
}
