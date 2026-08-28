export function PriorityBadge({ priority = "P2", className = "" }) {
  const value = ["P0", "P1", "P2"].includes(priority) ? priority : "P2";
  return <span className={`priority-badge priority-badge--${value.toLowerCase()} ${className}`.trim()} aria-label={`优先级 ${value}`}>{value}</span>;
}
