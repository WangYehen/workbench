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

export function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

export function resolveDateKey(value, fallback = localDateString()) {
  if (value == null || value === "") return fallback;
  if (!isDateKey(value)) throw new Error("date must be YYYY-MM-DD");
  return String(value);
}
