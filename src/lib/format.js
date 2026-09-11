export function formatCompactDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `今天 ${hm}`;
  if (d.getFullYear() === now.getFullYear())
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatFullDate(iso) {
  if (!iso) return "等待首次刷新";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "等待首次刷新";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

// 将 YYYY-MM-DD 格式化为中文日期，如「2026年9月11日 周五」
export function fmtDateCn(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}年${m}月${d}日 ${WEEK[new Date(y, m - 1, d).getDay()]}`;
}

// 按当前时间段返回问候语
export function greeting() {
  const h = new Date().getHours();
  return h < 11 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
}
