export const WORKBENCH_TIME_ZONE = process.env.WORKBENCH_TIME_ZONE || "Asia/Shanghai";

export function localDateString(value = new Date(), timeZone = WORKBENCH_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function localTimeString(value, timeZone = WORKBENCH_TIME_ZONE) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function teamMetricDate(selectedDate, now = new Date(), timeZone = WORKBENCH_TIME_ZONE) {
  const today = localDateString(now, timeZone);
  if (selectedDate !== today) return { date: selectedDate, isFallbackDate: false, ruleLabel: "按所选日期统计" };
  const time = localTimeString(now, timeZone);
  if (time < "17:40") {
    const previous = new Date(`${today}T00:00:00+08:00`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    return { date: localDateString(previous, timeZone), isFallbackDate: true, ruleLabel: "17:40 前默认展示昨日数据" };
  }
  return { date: today, isFallbackDate: false, ruleLabel: "17:40 后展示今日数据" };
}

export function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

export function resolveDateKey(value, fallback = localDateString()) {
  if (value == null || value === "") return fallback;
  if (!isDateKey(value)) throw new Error("date must be YYYY-MM-DD");
  return String(value);
}
