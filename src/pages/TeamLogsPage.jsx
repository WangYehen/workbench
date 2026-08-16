import { useEffect, useState } from "react";
import { IconUsersGroup, IconUserX, IconHistory, IconForms, IconRefresh } from "@tabler/icons-react";
import { api, teamApi, todayStr } from "../api.js";
import DateNav from "../components/DateNav.jsx";

export default function TeamLogsPage() {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [configured, setConfigured] = useState(false);

  const [tplOpen, setTplOpen] = useState(false);
  const [tplList, setTplList] = useState([]);
  const [tplSelected, setTplSelected] = useState([]);
  const [tplKnown, setTplKnown] = useState({});
  const [tplLoading, setTplLoading] = useState(false);
  const [tplSaving, setTplSaving] = useState(false);
  const [tplErr, setTplErr] = useState("");

  async function load() {
    try {
      const d = await api.get("/team/reports?date=" + date);
      setData(d);
      setConfigured(d.configured);
    } catch (e) {
      setErr(e.message);
    }
  }
  useEffect(() => { load(); }, [date]);

  useEffect(() => {
    (async () => {
      try {
        const c = await teamApi.templateConfig();
        setTplSelected(c.selected || []);
        const map = {};
        (c.known || []).forEach((t) => { map[t.template_id] = t.template_name; });
        setTplKnown(map);
      } catch (e) { /* 模板配置非必需 */ }
    })();
  }, []);

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
    setTplOpen(true);
    setTplErr("");
    setTplLoading(true);
    try {
      const r = await teamApi.dingtalkTemplates();
      setTplList(r.templates || []);
      setTplKnown((prev) => {
        const next = { ...prev };
        (r.templates || []).forEach((t) => { if (t.template_id) next[t.template_id] = t.template_name; });
        return next;
      });
    } catch (e) {
      setTplErr(e.message);
    }
    setTplLoading(false);
  }

  function toggleTpl(id) {
    setTplSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function saveTpl() {
    setTplSaving(true);
    setTplErr("");
    try {
      await teamApi.saveTemplateConfig(tplSelected);
    } catch (e) {
      setTplErr(e.message);
    }
    setTplSaving(false);
  }

  if (err) return <div className="error">错误：{err}</div>;
  if (!data) return <div className="spinner">加载中…</div>;

  const tplCount = tplSelected.length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>团队日志</h1>
          <div className="sub">拉取成员日志 · AI 分析阻塞与审核要点 · 区分已提交/未提交</div>
        </div>
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
          {!configured && <span className="pill gray">未配置钉钉（演示数据）</span>}
        </div>
      </div>

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
            勾选要拉取的日志模板，同步时将按选中的模板分别拉取当天日志；未勾选任何模板时，拉取全部日志。
          </div>
          {tplErr && <div className="error" style={{ marginBottom: 8 }}>错误：{tplErr}</div>}
          {tplLoading ? (
            <div className="spinner">加载模板中…</div>
          ) : (
            <div className="tpl-grid">
              {tplList.map((t) => (
                <label key={t.template_id} className="tpl-item">
                  <input
                    type="checkbox"
                    checked={tplSelected.includes(t.template_id)}
                    onChange={() => toggleTpl(t.template_id)}
                  />
                  <span className="tpl-item__name">{t.template_name || tplKnown[t.template_id] || "(未命名模板)"}</span>
                  <span className="tpl-item__id">{t.template_id}</span>
                </label>
              ))}
              {!tplList.length && (
                <div className="empty">
                  暂无可勾选的模板。请确认钉钉「服务器出口 IP 白名单」已配置，或在 .env 设置 DINGTALK_REPORT_TEMPLATE_ID 作为默认模板。
                </div>
              )}
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={saveTpl} disabled={tplSaving}>
              {tplSaving ? "保存中…" : "保存配置"}
            </button>
            <span className="meta">已选 {tplCount} 个模板</span>
            <button className="btn ghost" onClick={openTpl} disabled={tplLoading}>
              <IconRefresh size={15} stroke={1.75} /> 从钉钉刷新
            </button>
          </div>
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
