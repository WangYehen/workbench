import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconChartBar, IconCheck, IconEdit, IconFileText, IconArrowUpRight } from "@tabler/icons-react";
import { api, todayStr } from "../api.js";
import DateNav from "../components/DateNav.jsx";
import GenerateButton from "../components/GenerateButton.jsx";
import { PriorityBadge } from "../components/PriorityBadge.jsx";
import { groupSourceRefs, sourceRefTarget } from "../lib/report-sources.js";

// 五段式日报的分区定义（顺序即展示顺序）
// 文案消歧：assistance 是成员请主管拍板（待办状态），decisions 是主管已经定下的决策（既成事实），
// 两者都含「决策」但方向相反，标题必须区分，否则用户会困惑「这条『需决策』为何不在『关键决策』里」。
const SECTION_DEFS = [
  { key: "achievements", title: "关键成果" },
  { key: "risks", title: "风险与阻塞" },
  { key: "assistance", title: "需要协助 / 待我拍板" },
  { key: "tomorrow", title: "明日计划" },
  { key: "decisions", title: "已定决策（人工录入）" },
];

const EMPTY_HINT = {
  achievements: "当日暂无已确认的成果记录。",
  risks: "暂无风险或阻塞。",
  assistance: "暂无需要协助的事项。",
  tomorrow: "暂无明确的明日计划。",
  decisions: "尚未录入已定决策（人工录入），可在编辑中补充。",
};

// 向后兼容：历史日报可能只有 summary / teamBlockers / needManagerReview。
function resolveSections(content) {
  const raw = content && typeof content === "object" ? content : {};
  if (raw.sections && typeof raw.sections === "object") {
    return {
      achievements: Array.isArray(raw.sections.achievements) ? raw.sections.achievements : [],
      risks: Array.isArray(raw.sections.risks) ? raw.sections.risks : [],
      assistance: Array.isArray(raw.sections.assistance) ? raw.sections.assistance : [],
      tomorrow: Array.isArray(raw.sections.tomorrow) ? raw.sections.tomorrow : [],
      decisions: Array.isArray(raw.sections.decisions)
        ? raw.sections.decisions
        : Array.isArray(raw.manual?.decisions)
          ? raw.manual.decisions
          : [],
    };
  }
  return {
    achievements: [],
    risks: Array.isArray(raw.teamBlockers) ? raw.teamBlockers : [],
    assistance: Array.isArray(raw.needManagerReview) ? raw.needManagerReview : [],
    tomorrow: [],
    decisions: Array.isArray(raw.manual?.decisions) ? raw.manual.decisions : [],
  };
}

function resolveMetrics(content, sections) {
  const raw = content && typeof content === "object" ? content : {};
  if (raw.metrics && typeof raw.metrics === "object") {
    return {
      pendingEmails: Number(raw.metrics.pendingEmails) || 0,
      openTodos: Number(raw.metrics.openTodos) || 0,
      blockers: Number(raw.metrics.blockers) || 0,
      reviews: Number(raw.metrics.reviews) || 0,
      triagedEmails: Number(raw.metrics.triagedEmails) || 0,
    };
  }
  return {
    pendingEmails: Number(raw.pendingEmails) || 0,
    openTodos: Number(raw.openTodos) || 0,
    blockers: sections.risks.length,
    reviews: sections.assistance.length,
    triagedEmails: 0,
  };
}

function toLines(list) {
  return (Array.isArray(list) ? list : []).map((item) => String(item)).join("\n");
}

function fromLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function Metric({ label, value, tone, title }) {
  return (
    <div className={"daily-metric" + (tone === "warn" ? " is-warn" : "")} title={title}>
      <span className="daily-metric__value">{value}</span>
      <span className="daily-metric__label">{label}</span>
    </div>
  );
}

function JumpButton({ target, onJump }) {
  if (!target || typeof onJump !== "function") return null;
  return (
    <button type="button" className="btn sm daily-source-jump" onClick={() => onJump(target)}>
      前往 <IconArrowUpRight size={14} stroke={1.75} />
    </button>
  );
}

function SourceDetail({ groups, onJump, generatedAt }) {
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  return (
    <section className="daily-sources">
      <div className="daily-sources__head">
        <div className="daily-sources__title">来源明细</div>
        <div className="meta">
          共 {total} 项
          {generatedAt ? ` · 生成于 ${new Date(generatedAt).toLocaleString("zh-CN")}` : ""}
        </div>
      </div>
      {total === 0 ? (
        <p className="daily-section__empty">暂无来源明细。</p>
      ) : (
        groups.map((group) => (
          <div className="daily-source-group" key={group.kind}>
            <div className="daily-source-group__head">
              <span className="daily-source-group__label">{group.label}</span>
              <span className="daily-source-group__count">{group.items.length}</span>
            </div>
            <ul className="daily-source-list">
              {group.items.map((item, index) => (
                <li className="daily-source-item" key={`${item.ref || item.title}-${index}`}>
                  <PriorityBadge priority={item.priority} />
                  <div className="daily-source-main">
                    <div className="daily-source-title" title={item.title}>{item.title || item.ref}</div>
                    {item.detail ? <div className="daily-source-detail" title={item.detail}>{item.detail}</div> : null}
                    {item.recommendedAction ? <div className="daily-source-action">{item.recommendedAction}</div> : null}
                  </div>
                  <JumpButton target={sourceRefTarget(item)} onJump={onJump} />
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

export default function DailyReportPage() {
  const navigate = useNavigate();
  const [date, setDate] = useState(todayStr());
  const [report, setReport] = useState(null);
  const [sources, setSources] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftHeadline, setDraftHeadline] = useState("");
  const [draftSections, setDraftSections] = useState({});
  const [draftNotes, setDraftNotes] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const daily = await api.get(`/reports/daily?date=${date}`);
      setReport(daily?.report || null);
    } catch (err) {
      setReport(null);
      setError(err?.message || "日报加载失败");
    }
    // 团队成员日志源独立降级：失败也不影响日报主体渲染。
    try {
      const raw = await api.get(`/reports/dingtalk?date=${date}`);
      setSources(raw || null);
    } catch {
      setSources(null);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const content = report?.content_json || null;
  const sections = resolveSections(content);
  const metrics = resolveMetrics(content, sections);
  const sourceGroups = groupSourceRefs(content?.sourceRefs);
  // 被人工编辑过（锁定）的段落集合：重新生成时这些段不会被 AI 覆盖，需要在只读态标出来。
  const lockedKeys = new Set(Object.keys(content?.manual?.sections || {}));

  async function generate() {
    setBusy(true);
    setError("");
    try {
      await api.post("/reports/daily/generate", { date });
      await load();
    } catch (err) {
      setError(err?.message || "生成失败");
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    setDraftHeadline(
      typeof content?.headline === "string"
        ? content.headline
        : typeof content?.summary === "string"
          ? content.summary
          : "",
    );
    // 五段全部可编辑：按 SECTION_DEFS 铺进草稿，编辑态与只读态共用同一份分区定义。
    setDraftSections(Object.fromEntries(SECTION_DEFS.map((def) => [def.key, toLines(sections[def.key])])));
    setDraftNotes(typeof content?.manual?.notes === "string" ? content.manual.notes : "");
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    setError("");
    const nextSections = Object.fromEntries(SECTION_DEFS.map((def) => [def.key, fromLines(draftSections[def.key])]));
    // 逐段 diff 出「人工锁定层」：只有真正被改动过的段落才登记为锁定，
    // 未改动的段落从锁定表里移除、交还给 AI，重新生成时仍会刷新为最新源数据。
    const baseManual =
      (content?.manual && typeof content.manual.sections === "object" && content.manual.sections) || {};
    const manualSections = { ...baseManual };
    for (const def of SECTION_DEFS) {
      if (def.key === "decisions") continue; // decisions 由 manual.decisions 承载，不参与段落锁定
      const changed = JSON.stringify(nextSections[def.key]) !== JSON.stringify(sections[def.key]);
      if (changed) manualSections[def.key] = nextSections[def.key];
      else delete manualSections[def.key];
    }
    try {
      await api.put("/reports/daily", {
        date,
        content: {
          headline: draftHeadline,
          summary: draftHeadline,
          // 用已解析的 sections（含历史降级结果）作为基底，避免编辑时丢失既有分区。
          sections: { ...sections, ...nextSections },
          // decisions 同时存在于 sections 与 manual，两处必须保持一致（后端校验的不变量）。
          // manual 后端是整体替换，故这里必须提交完整的 manualSections。
          manual: { decisions: nextSections.decisions, notes: draftNotes, sections: manualSections },
        },
      });
      await load();
      setEditing(false);
    } catch (err) {
      setError(err?.message || "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel__head">
          <div className="panel__title">
            <span className="work-page-icon"><IconFileText size={22} stroke={1.75} /></span>
            主管日报
          </div>
          <DateNav date={date} onChange={setDate} />
        </div>
        <p className="meta">
          本页汇总当日成果、风险、需协助与明日计划；{sources?.total ?? 0} 名成员的原始日志请在「团队」工作区按成员下钻。
        </p>
      </div>

      <div className="panel">
        <div className="panel__head">
          <div className="panel__title">
            <span className="work-page-icon"><IconChartBar size={22} stroke={1.75} /></span>
            {date} 汇报摘要
          </div>
          <div className="row">
            <GenerateButton onClick={generate} busy={busy} />
            {report && !editing ? (
              <button type="button" className="btn sm" onClick={startEdit}>
                <IconEdit size={15} /> 编辑
              </button>
            ) : null}
            {report && editing ? (
              <>
                <button type="button" className="btn sm" onClick={() => setEditing(false)} disabled={busy}>
                  取消
                </button>
                <button type="button" className="btn primary sm" onClick={save} disabled={busy}>
                  <IconCheck size={15} /> 保存
                </button>
              </>
            ) : null}
          </div>
        </div>

        {error ? <div className="error" style={{ marginBottom: 12 }}>{error}</div> : null}

        {!report ? (
          <div className="empty">该日期尚未生成主管日报。</div>
        ) : (
          <div className="daily-report">
            {editing ? (
              <div className="daily-edit">
                <label htmlFor="daily-headline">导语</label>
                <textarea
                  id="daily-headline"
                  rows={3}
                  value={draftHeadline}
                  onChange={(event) => setDraftHeadline(event.target.value)}
                />
                <p className="meta daily-edit__hint">
                  修改过的段落会在重新生成时保留；未修改的段落会按最新数据刷新。
                </p>
                {SECTION_DEFS.map((def) => (
                  <div key={def.key}>
                    <label htmlFor={`daily-section-${def.key}`}>{def.title}（每行一条）</label>
                    <textarea
                      id={`daily-section-${def.key}`}
                      rows={4}
                      value={draftSections[def.key] ?? ""}
                      onChange={(event) =>
                        setDraftSections((prev) => ({ ...prev, [def.key]: event.target.value }))
                      }
                    />
                  </div>
                ))}
                <label htmlFor="daily-notes">备注</label>
                <textarea
                  id="daily-notes"
                  rows={3}
                  value={draftNotes}
                  onChange={(event) => setDraftNotes(event.target.value)}
                />
                <p className="meta">关键决策仅取自人工录入，AI 生成不会覆盖。</p>
              </div>
            ) : (
              <p className="daily-headline">
                {typeof content?.headline === "string"
                  ? content.headline
                  : typeof content?.summary === "string"
                    ? content.summary
                    : "（摘要格式异常，请重新生成）"}
              </p>
            )}

            <div className="daily-metrics">
              <Metric label="待处理邮件" value={metrics.pendingEmails} />
              <Metric
                label="已分诊邮件"
                value={metrics.triagedEmails}
                title="当日收到且已判定为无需主管动作的邮件（needs_action=0），与「待处理邮件」互补"
              />
              <Metric label="当日待办" value={metrics.openTodos} />
              <Metric label="团队阻塞" value={metrics.blockers} tone="warn" />
              <Metric label="需主管审核" value={metrics.reviews} tone="warn" />
            </div>

            <div className="daily-sections">
              {SECTION_DEFS.map((def) => {
                const items = Array.isArray(sections[def.key]) ? sections[def.key] : [];
                return (
                  <section className="daily-section" key={def.key}>
                    <div className="daily-section__title">
                      {def.title}
                      {lockedKeys.has(def.key) ? (
                        <span className="daily-section__badge" title="该段已被人工编辑，重新生成时不会被覆盖">
                          已人工编辑
                        </span>
                      ) : null}
                    </div>
                    {items.length ? (
                      <ul className="daily-section__list">
                        {items.map((item, index) => (
                          <li key={index}>{String(item)}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="daily-section__empty">{EMPTY_HINT[def.key]}</p>
                    )}
                  </section>
                );
              })}
            </div>

            <SourceDetail
              groups={sourceGroups}
              onJump={navigate}
              generatedAt={content?.generatedAt || report?.generated_at}
            />
          </div>
        )}
      </div>
    </div>
  );
}
