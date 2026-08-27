import { localDateString } from "./local-date.mjs";

// 项目进度 / 状态机：派生逻辑集中在此，projects 与 overview 复用
export const STATUS = {
  normal:  { label: "正常",   pill: "green",  rank: 0 },
  at_risk: { label: "有风险", pill: "amber",  rank: 1 },
  review:  { label: "审核中", pill: "blue",   rank: 2 },
  overdue: { label: "已逾期", pill: "red",    rank: 3 },
  done:    { label: "待验收", pill: "gray",   rank: 4 },
};

function toDate(s) {
  return new Date(s + "T00:00:00");
}
function daysBetween(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}
function todayStr() {
  return localDateString();
}

// 进度：优先用存储值；未设置时按阶段时间跨度自动估算（0~100）
export function deriveProgress(project, phases, asOf = todayStr()) {
  if (project.progress != null && !Number.isNaN(Number(project.progress))) {
    return Math.max(0, Math.min(100, Number(project.progress)));
  }
  if (!phases || !phases.length) return 0;
  const starts = phases.map((p) => p.start_date).sort();
  const ends = phases.map((p) => p.end_date).sort();
  const first = starts[0];
  const last = ends[ends.length - 1];
  const total = daysBetween(first, last) || 1;
  const elapsed = daysBetween(first, asOf);
  return Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
}

// 状态机：根据进度 + 阶段截止日 + 当前日期自动推导
export function deriveStatus(project, phases, asOf = todayStr()) {
  const progress = deriveProgress(project, phases, asOf);
  const today = asOf;
  if (!phases || !phases.length) return "normal";
  const ends = phases.map((p) => p.end_date).sort();
  const lastEnd = ends[ends.length - 1];

  // 超过最终截止未完成 → 已逾期
  if (lastEnd < today && progress < 100) return "overdue";
  // 进度拉满 → 待验收
  if (progress >= 100) return "done";
  // 当前处于测试 / 上线阶段 → 审核中
  const active = phases.find((p) => p.start_date <= today && p.end_date >= today);
  if (active && (active.phase === "测试" || active.phase === "上线")) return "review";
  // 7 天内有关键节点但未达 70% → 有风险
  const soonDue = phases.some((p) => p.end_date >= today && daysBetween(today, p.end_date) <= 7);
  if (soonDue && progress < 70) return "at_risk";
  return "normal";
}

export function enrichProject(project, phases, asOf = todayStr()) {
  const progress = deriveProgress(project, phases, asOf);
  const status = deriveStatus(project, phases, asOf);
  return { ...project, phases, progress, status, statusLabel: STATUS[status].label };
}
