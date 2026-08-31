import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  IconMail,
  IconChevronDown,
  IconChevronRight,
  IconListCheck,
  IconExternalLink,
  IconAlertTriangle,
  IconClock,
  IconCircleDot,
  IconShieldLock,
  IconLink,
  IconTrash,
  IconDeviceMobile,
  IconCopy,
  IconMessage,
} from "@tabler/icons-react";
import { outlookApi, todayStr } from "../api.js";
import SyncButton from "../components/SyncButton.jsx";
import GenerateButton from "../components/GenerateButton.jsx";

const queueCopy = {
  action: { label: "需要行动", empty: "没有需要你立即处理的邮件" },
  informational: { label: "仅供知晓", empty: "暂无通知、抄送或系统消息" },
  uncertain: { label: "无法判断", empty: "暂无需要你确认的邮件" },
  archive: { label: "已归档", empty: "暂无已归档邮件" },
};
const actionTypeLabel = { reply: "回复", approval: "审批", confirmation: "确认", submission: "提交材料", deadline: "处理截止事项", other: "处理" };
const dueSourceLabel = { explicit: "邮件原文", inferred: "AI 推断", none: "未识别" };
const priorityLabel = { P0: "P0", P1: "P1", P2: "P2" };
const priorityClass = { P0: "p0", P1: "p1", P2: "p2" };
const confidenceLabel = (v) => (v >= 85 ? "高" : v >= 65 ? "中" : "低");

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
function dueDisplay(message) {
  if (!message.dueAt) return { tone: "none", primary: "—", secondary: "" };
  const due = new Date(message.dueAt);
  const now = new Date();
  const todayKey = todayStr();
  const dueKey = String(message.dueAt).slice(0, 10);
  if (dueKey < todayKey) {
    const diffDays = Math.ceil((now - due) / 86400000);
    return { tone: "overdue", primary: `已逾期 ${diffDays} 天`, secondary: fmtDateTime(message.dueAt) };
  }
  if (dueKey === todayKey) {
    return { tone: "today", primary: `今天 ${fmtTime(message.dueAt)}`, secondary: fmtDateTime(message.dueAt) };
  }
  const diffDays = Math.ceil((due - now) / 86400000);
  return { tone: "later", primary: `${diffDays} 天后`, secondary: fmtDateTime(message.dueAt) };
}

function SetupPanel({ status }) {
  return (
    <div className="panel outlook-setup">
      <div className="panel__head">
        <div className="panel__title">
          <span className="work-page-icon"><IconMail size={22} stroke={1.75} /></span>
          完成 Outlook 本地配置
        </div>
      </div>
      <p className="sub">在 <code>.env</code> 中配置 Microsoft Entra 应用和本地加密密钥后，重启服务即可启用行动收件箱。AI 来源可在设置页单独配置。</p>
      <div className="outlook-config-list">
        {(status?.missingConfiguration || []).map((item) => (
          <code key={item}>{item}</code>
        ))}
      </div>
      <p className="meta" style={{ marginTop: 10 }}>
        注册应用类型选「任何组织目录中的帐户（多租户）」，无需 Client Secret；回调地址填 <code>{status?.redirectUri || "OUTLOOK_OAUTH_REDIRECT_URI"}</code>，权限申请 <code>Mail.Read</code> + <code>offline_access</code>。
      </p>
    </div>
  );
}

function ConsentPanel({ accepted, onAccepted, onConnect, onDeviceConnect, device, deviceHint, pending, provider }) {
  return (
    <div className="panel outlook-consent">
      <div className="panel__head">
        <div className="panel__title"><span className="work-page-icon"><IconShieldLock size={22} stroke={1.75} /></span>连接 Outlook 前的隐私确认</div>
      </div>
      <p className="sub">授权后会读取近 7 天收件箱，并将清洗后的正文发送给 {provider || "已配置的 AI 来源"}，用于生成行动、截止时间及判断置信度。</p>
      <ul className="outlook-consent__list">
        <li>邮件正文不落盘，分类结果与你的纠正保存在本地加密状态中。</li>
        <li>仅申请 Mail.Read，不会修改 Outlook 邮箱。</li>
      </ul>
      <label className="outlook-consent__check">
        <input checked={accepted} onChange={(e) => onAccepted(e.target.checked)} type="checkbox" />
        我理解并同意上述处理方式。
      </label>
      <div className="outlook-consent__actions">
        <button className="btn primary" disabled={!accepted || pending} onClick={onConnect} type="button">
          <IconLink size={16} /> 同意并连接 Outlook
        </button>
        <button className="btn" disabled={!accepted || pending || Boolean(device)} onClick={onDeviceConnect} type="button">
          <IconDeviceMobile size={16} /> 用设备码连接
        </button>
      </div>
      <p className="meta">浏览器打不开 Microsoft 登录页（如 ERR_CONNECTION_CLOSED）时，用「设备码连接」：可在手机或任意设备完成授权，不依赖本机回跳。</p>
      {device ? (
        <div className="outlook-device">
          <div className="outlook-device__step">1 · 在任意设备打开 <a href={device.verificationUri} rel="noopener noreferrer" target="_blank">{device.verificationUri}</a></div>
          <div className="outlook-device__step">2 · 输入用户码 <code className="outlook-device__code">{device.userCode}</code></div>
          <div className="outlook-device__step">3 · 用 Outlook 账号登录并同意授权</div>
          <p className="meta">{deviceHint || "等待授权中，完成后本页会自动连接并开始拉取邮件…"}</p>
        </div>
      ) : null}
    </div>
  );
}

function CorrectionDialog({ message, onClose, onSave, pending }) {
  const [draft, setDraft] = useState(() => ({
    queue: message.queue || "action",
    actionType: message.actionType || "other",
    actionText: message.actionText || message.summary || "",
    dueAt: message.dueAt ? String(message.dueAt).slice(0, 16) : "",
    dueSource: message.dueSource || "none",
    priority: message.priority || "P1",
    priorityReason: message.priorityReason || "",
    confidence: 100,
  }));
  const set = (key, value) => setDraft((c) => ({ ...c, [key]: value }));
  return (
    <div className="daily-report-modal-backdrop">
      <form className="mail-correction-modal" onSubmit={(e) => { e.preventDefault(); onSave({ ...draft, dueAt: draft.dueAt || null }); }}>
        <header>
          <div><h2>纠正 AI 判断</h2><p>你的判断会被保留，后续同步不会覆盖。</p></div>
          <button aria-label="关闭" onClick={onClose} type="button">×</button>
        </header>
        <div className="mail-correction-grid">
          <label>队列
            <select value={draft.queue} onChange={(e) => set("queue", e.target.value)}>
              <option value="action">需要行动</option>
              <option value="informational">仅供知晓</option>
              <option value="uncertain">无法判断</option>
            </select>
          </label>
          <label>行动类型
            <select value={draft.actionType} onChange={(e) => set("actionType", e.target.value)}>
              {Object.entries(actionTypeLabel).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="is-wide">要做什么
            <input value={draft.actionText} onChange={(e) => set("actionText", e.target.value)} />
          </label>
          <label>最晚时间
            <input type="datetime-local" value={draft.dueAt} onChange={(e) => set("dueAt", e.target.value)} />
          </label>
          <label>截止来源
            <select value={draft.dueSource} onChange={(e) => set("dueSource", e.target.value)}>
              <option value="explicit">邮件原文</option>
              <option value="inferred">AI 推断</option>
              <option value="none">无截止</option>
            </select>
          </label>
          <label>优先级
            <select value={draft.priority} onChange={(e) => set("priority", e.target.value)} className="select-priority" data-priority={draft.priority}>
              <option value="P0">P0 — 紧急</option><option value="P1">P1 — 重要</option><option value="P2">P2 — 普通</option>
            </select>
          </label>
          <label className="is-wide">优先级原因
            <input value={draft.priorityReason} onChange={(e) => set("priorityReason", e.target.value)} />
          </label>
        </div>
        <footer>
          <button className="btn" onClick={onClose} type="button">取消</button>
          <button className="btn primary" disabled={pending} type="submit">保存纠正</button>
        </footer>
      </form>
    </div>
  );
}

function MailRow({ message, expanded, onExpand, onConvert, onCorrect, onIgnore, onRestore, onOpen, onDraft }) {
  const due = useMemo(() => dueDisplay(message), [message]);
  const confidence = Number(message.confidence || 0);
  const isAction = message.queue === "action" && message.status === "open";
  const subject = (
    <div className="email-subject">
      <span className="email-chevron">{expanded ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}</span>
      <div className="email-sender-block">
        <div className="email-sender-line">
          <span className="email-sender">{message.sender || "（未知）"}</span>
        </div>
        <div className="email-subject-text">{message.subject}</div>
      </div>
    </div>
  );
  return (
    <>
      <div className={`email-row email-row-tone-${due.tone}${expanded ? " is-open" : ""}`} onClick={() => onExpand()}>
        <div className="email-cell email-cell-sender">{subject}</div>

        <div className="email-cell email-cell-action">
          {isAction && message.actionText ? (
            <span className="email-action-tag"><IconListCheck size={14} stroke={2} /> {message.actionText}</span>
          ) : (
            <span className="meta">{actionTypeLabel[message.actionType] || "处理"}</span>
          )}
        </div>

        <div className="email-cell email-cell-due">
          <div className={`email-due-primary email-due-${due.tone}`}>
            {due.tone === "overdue" && <IconAlertTriangle size={14} stroke={2} />}
            {due.tone === "today" && <IconClock size={14} stroke={2} />}
            {due.tone === "later" && <IconCircleDot size={14} stroke={2} />}
            {due.primary}
          </div>
          {due.secondary && <div className="email-due-secondary">{due.secondary}</div>}
        </div>

        <div className="email-cell email-cell-priority">
          {message.priority ? (
            <>
              <span className={`pill ${priorityClass[message.priority] || "gray"}`}>{priorityLabel[message.priority] || message.priority}</span>
              {message.priorityReason && <div className="email-priority-reason">{message.priorityReason}</div>}
            </>
          ) : <span className="meta">—</span>}
        </div>

        <div className="email-cell email-cell-source">
          <span className="meta">{dueSourceLabel[message.dueSource] || "—"}</span>
        </div>

        <div className="email-cell email-cell-confidence">
          {confidence ? (
            <span className="email-confidence">
              {confidence}%
              <span className="email-confidence-bar"><span style={{ width: `${confidence}%` }} /></span>
            </span>
          ) : <span className="meta">—</span>}
        </div>

        <div className="email-cell email-cell-actions" onClick={(e) => e.stopPropagation()}>
          {isAction && (
            <button className="email-action-btn email-action-btn-primary" onClick={() => onConvert()}>
              <IconListCheck size={14} stroke={2} /><span>转为待办</span>
            </button>
          )}
          {isAction && (
            <button className="email-action-btn email-action-btn-primary" onClick={() => onDraft()}>
              <IconMessage size={14} stroke={2} /><span>回复草稿</span>
            </button>
          )}
          <button className="email-action-btn" onClick={() => onCorrect()}>纠正判断</button>
          {message.status === "open" && (
            <button className="email-action-btn email-action-btn-tertiary" onClick={() => onIgnore()}>
              {isAction ? "无需处理" : "标记已处理"}
            </button>
          )}
          {message.status !== "open" && (
            <button className="email-action-btn" onClick={() => onRestore()}>恢复</button>
          )}
          {message.webLink && (
            <button className="email-action-btn email-action-btn-link" onClick={() => onOpen()}>
              <IconExternalLink size={14} stroke={2} /><span>打开原邮件</span>
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="email-row-expansion">
          <div className="email-expansion-grid">
            <div className="email-expansion-block">
              <div className="email-expansion-title">邮件原文摘要</div>
              <div className="email-expansion-text">{message.bodyText || message.summary || "（无可展示的正文摘要）"}</div>
              {message.priorityReason && <div className="email-expansion-meta">AI 判断依据：{message.priorityReason}</div>}
            </div>
            <div className="email-expansion-block">
              <div className="email-expansion-title">快速操作</div>
              <div className="email-expansion-actions">
                {isAction && <button className="btn sm primary" onClick={() => onConvert()}>一键转为待办</button>}
                {isAction && <button className="btn sm primary" onClick={() => onDraft()}>生成回复草稿</button>}
                {message.webLink && (
                  <a className="btn sm" href={message.webLink} target="_blank" rel="noreferrer">
                    <IconExternalLink size={14} stroke={2} /> 在 Outlook 中打开
                  </a>
                )}
                <button className="btn sm" onClick={() => onCorrect()}>纠正判断</button>
                {message.status === "open" && (
                  <button className="btn sm" onClick={() => onIgnore()}>{isAction ? "标为无需处理" : "标记已处理"}</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function DraftDialog({ message, onClose, onFlash }) {
  const [tone, setTone] = useState("formal");
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState("");

  // 打开对话框时自动加载已缓存的草稿（不自动调 AI，避免意外消耗）
  useEffect(() => {
    let active = true;
    outlookApi
      .getDraft(message.id)
      .then((r) => {
        if (!active) return;
        if (r.draft) { setDraft(r.draft); setTone(r.tone || "formal"); }
      })
      .catch(() => { /* 忽略 */ })
      .finally(() => active && setLoaded(true));
    return () => { active = false; };
  }, [message.id]);

  // 生成草稿：换语气或重新生成时覆盖
  const generate = async (nextTone = tone) => {
    setGenerating(true); setErr("");
    try {
      const r = await outlookApi.draft(message.id, { tone: nextTone, force: draft ? true : undefined });
      setDraft(r.draft); setTone(r.tone || nextTone);
    } catch (e) {
      setErr(e.message || "草稿生成失败");
    } finally {
      setGenerating(false);
    }
  };

  // 复制草稿到剪贴板
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      onFlash({ type: "ok", msg: "回复草稿已复制，去 Outlook 粘贴发送吧。" });
    } catch {
      onFlash({ type: "err", msg: "复制失败，请手动选中草稿复制。" });
    }
  };

  return (
    <div className="daily-report-modal-backdrop">
      <div className="draft-modal">
        <header>
          <div>
            <h2>AI 回复草稿</h2>
            <p className="draft-modal__sub">
              {message.sender || "（未知）"} · {message.subject}
            </p>
          </div>
          <button aria-label="关闭" onClick={onClose} type="button">×</button>
        </header>

        <div className="draft-modal__tone">
          {[
            { value: "formal", label: "正式简洁" },
            { value: "friendly", label: "温和友好" },
            { value: "action", label: "直接行动" },
          ].map((t) => (
            <button
              key={t.value}
              className={`btn sm ${tone === t.value ? "primary" : ""}`}
              onClick={() => generate(t.value)}
              disabled={generating}
              type="button"
            >
              {t.label}
            </button>
          ))}
          <span className="meta">切换语气会重新生成</span>
        </div>

        {!loaded ? (
          <div className="spinner">加载中…</div>
        ) : (
          <>
            <textarea
              className="draft-modal__text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="点击「生成草稿」，AI 将基于邮件正文与你的待办起草回复。"
              disabled={generating}
            />
            {err && <div className="error">{err}</div>}
          </>
        )}

        <footer>
          <span className="meta draft-modal__privacy">
            正文仅发送给 AI 用于起草、不落库；草稿保存在本地。
          </span>
          <div className="draft-modal__actions">
            {message.webLink && (
              <a className="btn sm" href={message.webLink} target="_blank" rel="noreferrer">
                <IconExternalLink size={14} stroke={2} /> 打开原邮件
              </a>
            )}
            <GenerateButton variant="quiet" onClick={() => generate()} busy={generating} type="button">{draft ? "重新生成" : "生成草稿"}</GenerateButton>
            <button className="btn sm primary" onClick={copy} disabled={!draft || generating} type="button">
              <IconCopy size={14} stroke={2} /> 复制草稿
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default function EmailsPage() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [queues, setQueues] = useState({ action: [], informational: [], uncertain: [], archive: [] });
  const [view, setView] = useState("action");
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [device, setDevice] = useState(null);
  const [deviceHint, setDeviceHint] = useState("");
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [correcting, setCorrecting] = useState(null);
  const [drafting, setDrafting] = useState(null);
  const [flash, setFlash] = useState(searchParams.get("connected") ? { type: "ok", msg: "Outlook 连接成功，已开始拉取邮件。" } : null);

  const refresh = useCallback(async () => {
    const [nextStatus, action, informational, uncertain, archive] = await Promise.all([
      outlookApi.status(),
      outlookApi.todos(),
      outlookApi.informational(),
      outlookApi.uncertain(),
      outlookApi.archive(),
    ]);
    setStatus(nextStatus.data || nextStatus);
    setQueues({
      action: action.items || [],
      informational: informational.items || [],
      uncertain: uncertain.items || [],
      archive: archive.items || [],
    });
  }, []);

  useEffect(() => { refresh().catch((e) => setErr(e.message)); }, [refresh]);

  const run = async (op) => {
    setPending(true); setErr("");
    try { await op(); await refresh(); }
    catch (e) { setErr(e.message || "操作失败"); }
    finally { setPending(false); }
  };

  const connect = () => run(async () => {
    await outlookApi.consent();
    const result = await outlookApi.start();
    window.location.assign(result.authorizationUrl);
  });

  // 设备码授权：拿到用户码后展示，由下方 effect 自动轮询直至授权完成
  const deviceConnect = () => run(async () => {
    await outlookApi.consent();
    const result = await outlookApi.deviceStart();
    setDeviceHint("等待授权中，完成后本页会自动连接并开始拉取邮件…");
    setDevice({
      handle: result.handle,
      userCode: result.userCode,
      verificationUri: result.verificationUri,
      interval: result.interval || 5,
    });
  });

  useEffect(() => {
    if (!device?.handle) return undefined;
    let stopped = false;
    let timer = null;
    const tick = async () => {
      try {
        const result = await outlookApi.devicePoll(device.handle);
        if (stopped) return;
        if (result.pending) {
          timer = setTimeout(tick, (result.interval || device.interval || 5) * 1000);
          return;
        }
        setDevice(null);
        setDeviceHint("");
        setFlash({ type: "ok", msg: "Outlook 连接成功，已开始拉取邮件。" });
        await refresh();
      } catch (e) {
        if (stopped) return;
        setDevice(null);
        setDeviceHint("");
        setErr(e.message || "设备码授权失败，请重新获取设备码。");
      }
    };
    timer = setTimeout(tick, (device.interval || 5) * 1000);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [device, refresh]);

  const doSync = async () => {
    setSyncing(true); setErr("");
    try { await run(outlookApi.sync); }
    finally { setSyncing(false); }
  };

  const convertToTodo = (message) => run(async () => {
    const r = await outlookApi.convert(message.id);
    setFlash({ type: "ok", msg: `已创建待办：${r.title}（${r.priority}${r.due_date ? " · " + r.due_date : ""}）` });
    setTimeout(() => nav("/todos"), 700);
  });

  const openOutlook = (message) => {
    if (message.webLink) { window.open(message.webLink, "_blank", "noopener,noreferrer"); return; }
    const q = encodeURIComponent(`subject:${message.subject || ""}`);
    window.open(`https://outlook.office.com/mail/search/${q}`, "_blank", "noopener,noreferrer");
  };

  const doDisconnect = () => {
    if (window.confirm("断开 Outlook 后将停止同步，但会保留本地邮件归档。确认断开吗？")) {
      void run(outlookApi.disconnect);
    }
  };

  if (err && !status) return <div className="error">错误：{err}</div>;
  if (!status) return <div className="spinner">加载中…</div>;

  if (!status.configured) return <SetupPanel status={status} />;
  if (!status.consented || !status.connected) {
    return (
      <>
        {err ? <div className="error" style={{ marginBottom: 12 }}>错误：{err}</div> : null}
        <ConsentPanel
          accepted={accepted}
          device={device}
          deviceHint={deviceHint}
          onAccepted={setAccepted}
          onConnect={connect}
          onDeviceConnect={deviceConnect}
          pending={pending}
          provider={status.modelProvider}
        />
      </>
    );
  }

  const messages = queues[view] || [];
  const sorted = messages.slice().sort((a, b) => {
    const groupOrder = { overdue: 0, today: 1, later: 2, none: 3 };
    const da = dueDisplay(a).tone;
    const db = dueDisplay(b).tone;
    const ga = groupOrder[da] ?? 3;
    const gb = groupOrder[db] ?? 3;
    if (ga !== gb) return ga - gb;
    const pa = { P0: 0, P1: 1, P2: 2 }[a.priority || ""] ?? 3;
    const pb = { P0: 0, P1: 1, P2: 2 }[b.priority || ""] ?? 3;
    if (pa !== pb) return pa - pb;
    return new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0);
  });

  return (
    <div>
      <PageHeader
        eyebrow="EMAILS / INBOX"
        title="邮件处理"
        description="把邮件分为需要行动、仅供知晓和无法判断，所有 AI 判断都可以随时纠正。"
        actions={
          <div className="row">
            <SyncButton className="btn primary" onClick={doSync} syncing={syncing} disabled={pending}>立即同步</SyncButton>
            <button className="btn" onClick={doDisconnect} disabled={pending}>
              <IconTrash size={15} /> 断开连接
            </button>
          </div>
        }
      />

      <div className="email-sync-meta">
        <span>连接状态：<strong>已连接 Outlook</strong></span>
        <span>最近同步：{status.lastSyncAt ? fmtDateTime(status.lastSyncAt) : "尚未同步"}</span>
        <span>最后尝试：{status.lastAttemptAt ? fmtDateTime(status.lastAttemptAt) : "—"}</span>
        <span>自动同步：每 15 分钟</span>
        {status.lastError && <span className="email-sync-err">上次失败：{status.lastError}</span>}
      </div>

      {flash && (
        <div className={`email-flash email-flash-${flash.type}`} onAnimationEnd={() => setFlash(null)}>{flash.msg}</div>
      )}
      {err && <div className="error">{err}</div>}

      <div className="row" style={{ margin: "12px 0" }}>
        {Object.entries(queueCopy).map(([key, copy]) => (
          <button key={key} className={`btn ${view === key ? "primary" : ""}`} onClick={() => setView(key)}>
            {copy.label} {queues[key]?.length ? `(${queues[key].length})` : ""}
          </button>
        ))}
      </div>

      <div className="panel email-panel">
        <div className="panel__head">
          <div className="panel__title">
            <span className="work-page-icon"><IconMail size={22} stroke={1.75} /></span>
            {queueCopy[view].label}
          </div>
          <span className="meta">{messages.length} 封</span>
        </div>

        {view === "action" ? (
          <div className="email-table">
            <div className="email-table-head">
              <div className="email-cell email-cell-sender">发件人与主题</div>
              <div className="email-cell email-cell-action">要做什么</div>
              <div className="email-cell email-cell-due">最晚什么时候做</div>
              <div className="email-cell email-cell-priority">优先级和原因</div>
              <div className="email-cell email-cell-source">截止来源</div>
              <div className="email-cell email-cell-confidence">AI 置信度</div>
              <div className="email-cell email-cell-actions">操作</div>
            </div>

            {sorted.length === 0 && <div className="empty">{queueCopy[view].empty}</div>}

            {["overdue", "today", "later", "none"].map((tone) => {
              const group = sorted.filter((m) => dueDisplay(m).tone === tone);
              if (!group.length) return null;
              const label = { overdue: "已逾期", today: "今天截止", later: "稍后", none: "无明确截止" }[tone];
              return (
                <div key={tone}>
                  <div className={`email-group-head email-group-${tone}`}>
                    <span className="email-group-dot" />
                    <span className="email-group-label">{label}</span>
                    <span className="email-group-count">（{group.length}）</span>
                  </div>
                  {group.map((m) => (
                    <MailRow
                      key={m.id}
                      message={m}
                      expanded={expanded === m.id}
                      onExpand={() => setExpanded((c) => (c === m.id ? null : m.id))}
                      onConvert={() => convertToTodo(m)}
                      onCorrect={() => setCorrecting(m)}
                      onIgnore={() => run(() => outlookApi.setStatus(m.id, m.queue === "action" ? "ignored" : "processed"))}
                      onRestore={() => run(() => outlookApi.setStatus(m.id, "open"))}
                      onOpen={() => openOutlook(m)}
                      onDraft={() => setDrafting(m)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="list">
            {messages.map((m) => (
              <MailRow
                key={m.id}
                message={m}
                expanded={expanded === m.id}
                onExpand={() => setExpanded((c) => (c === m.id ? null : m.id))}
                onConvert={() => convertToTodo(m)}
                onCorrect={() => setCorrecting(m)}
                onIgnore={() => run(() => outlookApi.setStatus(m.id, m.queue === "action" ? "ignored" : "processed"))}
                onRestore={() => run(() => outlookApi.setStatus(m.id, "open"))}
                onOpen={() => openOutlook(m)}
                onDraft={() => setDrafting(m)}
              />
            ))}
            {!messages.length && <div className="empty">{queueCopy[view].empty}</div>}
          </div>
        )}
      </div>

      {correcting && (
        <CorrectionDialog
          message={correcting}
          onClose={() => setCorrecting(null)}
          onSave={(patch) => run(async () => { await outlookApi.correct(correcting.id, patch); setCorrecting(null); })}
          pending={pending}
        />
      )}

      {drafting && (
        <DraftDialog
          message={drafting}
          onClose={() => setDrafting(null)}
          onFlash={(f) => setFlash(f)}
        />
      )}
    </div>
  );
}
