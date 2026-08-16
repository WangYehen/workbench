// 与 server/project-status.mjs 的 STATUS 保持一致的纯前端映射
export const STATUS_META = {
  normal:  { label: "正常",   pill: "green" },
  at_risk: { label: "有风险", pill: "amber" },
  review:  { label: "审核中", pill: "blue" },
  overdue: { label: "已逾期", pill: "red" },
  done:    { label: "待验收", pill: "gray" },
};

export function statusMeta(s) {
  return STATUS_META[s] || STATUS_META.normal;
}

export function StatusPill({ status }) {
  const m = statusMeta(status);
  return <span className={`pill ${m.pill}`}>{m.label}</span>;
}
