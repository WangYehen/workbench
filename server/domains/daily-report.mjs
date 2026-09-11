import { buildDashboard } from "./workbench-domain.mjs";

// 主管日报领域逻辑：把指挥台聚合结果转换成「五段式」可编辑日报。
// 全部为纯函数（依赖注入 db），便于在 server/tests/reports/ 下直接测试。

function safeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function asArray(value) {
  const parsed = safeJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

// 收敛成非空字符串数组：写库/展示前统一去掉空值，避免把对象或 null 带进列表。
function asStringArray(value) {
  return asArray(value)
    .map((item) => (item == null ? "" : String(item).trim()))
    .filter(Boolean);
}

function count(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  const value = row && typeof row.c === "number" ? row.c : 0;
  return value;
}

/**
 * 生成某一日的主管日报 content（五段式 + 来源明细）。
 * 会保留既有的人工录入内容（manual.decisions / manual.notes），生成过程绝不覆盖。
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} date 上海时区日期键 YYYY-MM-DD
 * @param {object} [existing] 该日已有日报 content_json（对象）
 * @param {Date} [now]
 * @returns {object} 完整 content 对象
 */
export function buildDailyReportContent(db, date, existing = {}, now = new Date()) {
  const dashboard = buildDashboard(db, date, now);
  const prev = existing && typeof existing === "object" ? existing : {};

  // —— 指标 ——
  const pendingEmails = count(
    db,
    "SELECT COUNT(*) c FROM emails WHERE needs_action=1 AND date(received_at)=? AND source='outlook'",
    date,
  );
  // 「已分诊邮件」= 当日收到且已判定为无需主管动作（needs_action=0）的邮件，与 pendingEmails 互补。
  // 措辞纪律：语义是「已分诊」，绝不等于「已处理完成」，因此只作为指标呈现，不写成成果文案。
  const triagedEmails = count(
    db,
    "SELECT COUNT(*) c FROM emails WHERE needs_action=0 AND date(received_at)=? AND source='outlook'",
    date,
  );
  const openTodos = count(db, "SELECT COUNT(*) c FROM todos WHERE status!='done' AND due_date=?", date);

  const reports = db.prepare("SELECT blockers, needs_review FROM dingtalk_reports WHERE report_date=?").all(date);
  const teamBlockers = reports.flatMap((row) => asStringArray(row.blockers));
  const needManagerReview = reports.flatMap((row) => asStringArray(row.needs_review));

  // —— 关键成果：只放具备成果语义的项（当日已完成待办）——
  // 邮件「已分诊」数量属于工作量而非成果，故不入 achievements，改由 metrics.triagedEmails 呈现。
  const completedTodos = db
    .prepare("SELECT title FROM todos WHERE status='done' AND completed_at IS NOT NULL AND date(completed_at)=? ORDER BY completed_at")
    .all(date)
    .map((row) => String(row.title || "").trim())
    .filter(Boolean);
  const achievements = completedTodos.map((title) => `完成待办：${title}`);
  if (!achievements.length) achievements.push("当日暂无已确认的成果记录");

  // —— 风险与阻塞：团队日志阻塞 + 项目风险（带负责人，便于主管直接找到人）——
  const projectRisks = (dashboard.projects || [])
    .filter((project) => project.status === "at_risk" || project.status === "overdue")
    .map((project) => {
      const segments = [project.status === "overdue" ? "已逾期" : `风险 · 进度 ${project.progress}%`];
      const owner = String(project.owner || "").trim();
      // owner 为空时整段省略，不显示「负责人 未设置」这类占位噪声
      if (owner) segments.push(`负责人 ${owner}`);
      return `${project.name}（${segments.join(" · ")}）`;
    });

  // —— 明日计划：未来若干天到期的未完成待办 ——
  const upcomingTodos = db
    .prepare("SELECT title, due_date FROM todos WHERE status!='done' AND due_date IS NOT NULL AND due_date!='' AND due_date>? ORDER BY due_date LIMIT 10")
    .all(date)
    .map((row) => `${String(row.title || "").trim()}（截止 ${row.due_date}）`);

  // —— 关键决策：只来自人工录入，AI 不得编造 ——
  const manualDecisions = asStringArray(prev.manual?.decisions);
  const manualNotes = typeof prev.manual?.notes === "string" ? prev.manual.notes : "";

  // —— 来源明细：完整保留指挥台注意事项的字段 ——
  const sourceRefs = (dashboard.attention || []).map((item) => ({
    ref: item.sourceRef,
    kind: item.kind,
    title: item.title,
    detail: item.detail,
    priority: item.priority,
    recommendedAction: item.recommendedAction,
  }));

  // —— 人工锁定层：先由源数据重建五段，再让用户改过的段落覆盖回来 ——
  const aiSections = {
    achievements,
    risks: [...teamBlockers, ...projectRisks],
    assistance: [...needManagerReview],
    tomorrow: [...upcomingTodos],
  };
  // 用户在界面上编辑过的段落（manual.sections）在重新生成时必须原样保留；
  // 未出现在 manual.sections 里的段落仍按最新源数据重建，
  // 避免「改了一段就永久冻结全部五段」的过度锁定。
  const prevManualSections =
    (prev.manual && typeof prev.manual.sections === "object" && prev.manual.sections) || {};
  const sections = { ...aiSections, decisions: [...manualDecisions] };
  for (const key of Object.keys(aiSections)) {
    const locked = prevManualSections[key];
    if (Array.isArray(locked)) sections[key] = [...locked];
  }

  // 导语沿用原 summary 语义，保证与旧版一致
  const summary = `今日需处理邮件 ${pendingEmails} 封，待办 ${openTodos} 项，团队阻塞 ${teamBlockers.length} 项，需主管审核 ${needManagerReview.length} 项。`;

  return {
    date,
    generatedAt: new Date().toISOString(),
    inputHash: dashboard.inputHash,
    headline: summary,
    sections,
    metrics: {
      pendingEmails,
      openTodos,
      blockers: teamBlockers.length,
      reviews: needManagerReview.length,
      triagedEmails,
    },
    // manual.sections 原样回填，保证 PUT 二次合并时不丢锁定信息
    manual: { decisions: [...manualDecisions], notes: manualNotes, sections: { ...prevManualSections } },
    sourceRefs,
    // —— 向后兼容：旧字段必须继续存在 ——
    summary,
    teamBlockers,
    needManagerReview,
    pendingEmails,
    openTodos,
  };
}

/**
 * 合并日报编辑补丁。
 * 顶层浅合并；`sections` 与 `manual` 额外做一层深合并，
 * 保证前端只提交部分字段时不会抹掉其余内容（如 manual.notes）。
 *
 * @param {object} base 现有 content
 * @param {object} patch 前端提交的 content 补丁
 * @returns {object} 合并后的 content
 */
export function mergeDailyContent(base, patch) {
  const current = base && typeof base === "object" ? base : {};
  const incoming = patch && typeof patch === "object" ? patch : {};
  const merged = { ...current, ...incoming };
  if (incoming.sections && typeof incoming.sections === "object") {
    merged.sections = { ...(current.sections || {}), ...incoming.sections };
  }
  if (incoming.manual && typeof incoming.manual === "object") {
    merged.manual = { ...(current.manual || {}), ...incoming.manual };
  }
  return merged;
}
