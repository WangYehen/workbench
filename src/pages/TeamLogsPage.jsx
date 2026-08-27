import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { IconUsersGroup, IconUserX, IconHistory, IconForms, IconTrash, IconPencil, IconCheck, IconX } from "@tabler/icons-react";
import { api, teamApi, todayStr } from "../api.js";
import DateNav from "../components/DateNav.jsx";

// 最近同步时间展示：如 08/18 18:05
function fmtSyncTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function TeamLogsPage() {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState("");

  // 手动维护的日志模板（增删改/启停）
  const [tplOpen, setTplOpen] = useState(false);
  const [tpls, setTpls] = useState([]);
  const [tplNewName, setTplNewName] = useState("");
  const [tplEditId, setTplEditId] = useState(null);
  const [tplEditName, setTplEditName] = useState("");
  const [tplLoading, setTplLoading] = useState(false);
  const [tplErr, setTplErr] = useState("");

  async function load() {
    try {
      const d = await api.get("/team/reports?date=" + date);
      setData(d);
      setConfigured(d.configured);
      setLastSyncAt(d.lastSyncAt || "");
    } catch (e) {
      setErr(e.message);
    }
  }
  useEffect(() => { load(); }, [date]);

  async function loadTemplates() {
    setTplLoading(true);
    try {
      const r = await teamApi.templateList();
      setTpls(r.templates || []);
    } catch (e) {
      setTplErr(e.message);
    }
    setTplLoading(false);
  }
  useEffect(() => { loadTemplates(); }, []);

  async function sync() {
    setSyncing(true);
    setErr("");
    try {
      await teamApi.sync(date);
      await load();
    } catch (e) {
      setErr(e.message);
    }
    setSyncing(false);
  }

  async function openTpl() {
    setTplOpen((prev) => !prev);
    setTplErr("");
    await loadTemplates();
  }

  async function addTpl() {
    if (!tplNewName.trim()) return;
    setTplErr("");
    setTplLoading(true);
    try {
      await teamApi.templateCreate(tplNewName.trim());
      setTplNewName("");
      await loadTemplates();
    } catch (e) {
      setTplErr(e.message);
    }
    setTplLoading(false);
  }

  async function toggleTplEnabled(t, enabled) {
    setTplErr("");
    try {
      await teamApi.templateUpdate(t.id, { enabled });
      await loadTemplates();
    } catch (e) {
      setTplErr(e.message);
    }
  }

  function startEdit(t) {
    setTplEditId(t.id);
    setTplEditName(t.name);
    setTplErr("");
  }
  function cancelEdit() {
    setTplEditId(null);
    setTplEditName("");
  }

  async function saveEdit() {
    if (!tplEditName.trim() || tplEditId == null) return;
    setTplErr("");
    setTplLoading(true);
    try {
      await teamApi.templateUpdate(tplEditId, { name: tplEditName.trim() });
      cancelEdit();
      await loadTemplates();
    } catch (e) {
      setTplErr(e.message);
    }
    setTplLoading(false);
  }

  async function deleteTpl(t) {
    if (!window.confirm(`删除模板「${t.name}」？已同步的历史日志不会被删除，但后续同步将不再拉取该模板。`)) return;
    setTplErr("");
    setTplLoading(true);
    try {
      await teamApi.templateDelete(t.id);
      await loadTemplates();
    } catch (e) {
      setTplErr(e.message);
    }
    setTplLoading(false);
  }

  if (err) return <div className="error">错误：{err}</div>;
  if (!data) return <div className="spinner">加载中…</div>;

  const tplCount = tpls.length;

  return (
    <div>
      <PageHeader
        eyebrow="TEAM / LOGS"
        title="团队日志"
        description="拉取成员日志 · AI 分析阻塞与审核要点 · 区分已提交/未提交"
        actions={
          <div className="row">
            <DateNav date={date} onChange={setDate} />
            {configured && (
              <button className="btn ghost" onClick={openTpl}>
                <IconForms size={16} stroke={1.75} /> 日志模板（{tplCount}）
              </button>
            )}
            {configured && (
              <button className="btn primary" onClick={sync} disabled={syncing}>
                {syncing ? "同步中…" : "同步钉钉"}
              </button>
            )}
            {configured && lastSyncAt && (
              <span className="meta" style={{ alignSelf: "center" }} title={new Date(lastSyncAt).toLocaleString()}>
                最近同步：{fmtSyncTime(lastSyncAt)}
              </span>
            )}
            {!configured && <span className="pill gray">未配置钉钉（演示数据）</span>}
          </div>
        }
      />

      {tplOpen && (
        <div className="panel panel--hover" style={{ marginBottom: 16 }}>
          <div className="panel__head">
            <div className="panel__title">
              <span className="work-page-icon"><IconForms size={22} stroke={1.75} /></span>
              拉取哪些日志模板
            </div>
            <button className="btn ghost" onClick={() => setTplOpen(false)}>收起</button>
          </div>
          <div className="sub" style={{ marginBottom: 10 }}>
            手动添加要拉取的日志模板名称（钉钉后台的模板名），同步时将按名称分别拉取当天日志；停用的模板不参与拉取，没有启用模板时同步会跳过。
          </div>
          {tplErr && <div className="error" style={{ marginBottom: 8 }}>错误：{tplErr}</div>}

          <div className="row" style={{ marginBottom: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <input
                type="text"
                placeholder="输入日志模板名称，如 IT部门日报"
                value={tplNewName}
                onChange={(e) => setTplNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void addTpl(); }}
              />
            </div>
            <button className="btn primary" onClick={addTpl} disabled={tplLoading || !tplNewName.trim()}>
              {tplLoading ? "处理中…" : "添加模板"}
            </button>
          </div>

          {tplLoading ? (
            <div className="spinner">加载模板中…</div>
          ) : (
            <div className="tpl-grid">
              {tpls.map((t) => (
                <div key={t.id} className={`tpl-item${t.enabled ? "" : " is-disabled"}`}>
                  <input
                    type="checkbox"
                    checked={Boolean(t.enabled)}
                    onChange={(e) => toggleTplEnabled(t, e.target.checked)}
                    title={t.enabled ? "点击停用（不再拉取该模板）" : "点击启用（恢复拉取）"}
                  />
                  <div className="tpl-item__main">
                    {tplEditId === t.id ? (
                      <>
                        <input
                          type="text"
                          value={tplEditName}
                          onChange={(e) => setTplEditName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") void saveEdit(); if (e.key === "Escape") cancelEdit(); }}
                          autoFocus
                        />
                        <span className="row" style={{ marginTop: 2 }}>
                          <button className="tpl-item__act" onClick={saveEdit} title="保存" disabled={tplLoading || !tplEditName.trim()}>
                            <IconCheck size={14} stroke={2} />
                          </button>
                          <button className="tpl-item__act" onClick={cancelEdit} title="取消">
                            <IconX size={14} stroke={2} />
                          </button>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="tpl-item__name">{t.name}</span>
                        <span className="row" style={{ marginTop: 2 }}>
                          <button className="tpl-item__act" onClick={() => startEdit(t)} title="编辑名称">
                            <IconPencil size={13} stroke={2} />
                          </button>
                          <button className="tpl-item__act tpl-item__act--danger" onClick={() => deleteTpl(t)} title="删除模板">
                            <IconTrash size={13} stroke={2} />
                          </button>
                          <span className="tpl-item__state">{t.enabled ? "启用中" : "已停用"}</span>
                        </span>
                      </>
                    )}
                  </div>
                </div>
              ))}
              {!tpls.length && (
                <div className="empty">
                  暂无模板，请先手动添加要同步的日志模板名称（钉钉后台显示的模板名）。
                </div>
              )}
            </div>
          )}
          <span className="meta" style={{ display: "block", marginTop: 10 }}>已添加 {tplCount} 个模板</span>
        </div>
      )}

      <div className="grid grid-2">
        <div className="panel panel--hover">
          <div className="panel__head">
            <div className="panel__title">
              <span className="work-page-icon"><IconUsersGroup size={22} stroke={1.75} /></span>
              已提交（{data.submitted}）
            </div>
          </div>
          <div className="list">
            {data.reports.map((r) => (
              <div className="item" key={r.id} style={{ flexDirection: "column", alignItems: "stretch" }}>
                <div className="row spread">
                  <span className="title">{r.user_name}</span>
                  <span className="pill green">已提交</span>
                </div>
                {r.template_name && <div className="meta">模板：{r.template_name}</div>}
                {r.summary && <div className="sub">{r.summary}</div>}
                {(r.blockers || []).map((b, i) => (
                  <div key={i} className="pill red" style={{ marginTop: 4 }}>阻塞：{b}</div>
                ))}
                {(r.needs_review || []).map((b, i) => (
                  <div key={i} className="pill amber" style={{ marginTop: 4 }}>待审核：{b}</div>
                ))}
              </div>
            ))}
            {!data.reports.length && <div className="empty">暂无提交</div>}
          </div>
        </div>

        <div className="panel panel--hover">
          <div className="panel__head">
            <div className="panel__title">
              <span className="work-page-icon"><IconUserX size={22} stroke={1.75} /></span>
              未提交（{data.notSubmitted.length}）
            </div>
          </div>
          <div className="list">
            {data.notSubmitted.map((m) => (
              <div className="item" key={m.user_id}>
                <span className="pill gray">未提交</span>
                <div>
                  <div className="title">{m.name}</div>
                  <div className="sub">{m.dept_name}</div>
                </div>
              </div>
            ))}
            {!data.notSubmitted.length && <div className="empty">全部已提交 🎉</div>}
          </div>
          <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
            <div className="panel__title" style={{ fontSize: 15, marginBottom: 6 }}>
              <span className="work-page-icon" style={{ width: 34, height: 34 }}>
                <IconHistory size={18} stroke={1.75} />
              </span>
              历史查看
            </div>
            <div className="sub">切换上方日期即可查看历史某天的团队日志与提交情况。</div>
          </div>
        </div>
      </div>
    </div>
  );
}
