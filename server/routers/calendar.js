import express from "express";
import { getDb } from "../db.mjs";
import { dingtalk } from "../dingtalk.mjs";

const router = express.Router();

function fmt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 本地日期字符串（YYYY-MM-DD），避免 toISOString 在东八区把当天算成前一天
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---- 钉钉日程自动同步：按天做 30 分钟 TTL 缓存，避免每次请求都打钉钉 ----
const SYNC_TTL = 30 * 60 * 1000;
const syncedDays = new Map();
let lastSyncError = null;

// 读取最近一次日程成功同步时间（由 dingtalk.syncCalendarForRange 写入）
function lastCalendarSyncAt(db) {
  const row = db.prepare("SELECT value_json FROM sync_state WHERE key='calendar_last_sync_at'").get();
  return row ? (JSON.parse(row.value_json)?.at || "") : "";
}

async function ensureSynced(startStr, endStr) {
  if (!dingtalk.calendarReady()) return; // 未配置钉钉（或缺主管 userid）：依赖演示/已有数据，不阻塞请求
  const days = [];
  const s = new Date(startStr + "T00:00:00");
  const e = new Date(endStr + "T00:00:00");
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) days.push(ymd(d));
  const now = Date.now();
  const need = days.filter((dd) => !(syncedDays.get(dd) && now - syncedDays.get(dd) < SYNC_TTL));
  if (!need.length) return;
  try {
    await dingtalk.syncCalendarForRange(startStr, endStr);
    for (const dd of days) syncedDays.set(dd, now);
    lastSyncError = null;
  } catch (err) {
    lastSyncError = err.message;
    for (const dd of need) syncedDays.set(dd, now); // 标记已尝试，TTL 内不再重试轰炸
    console.error("[calendar] 钉钉日程同步失败：", err.message);
  }
}

router.get("/meetings", async (req, res) => {
  const db = getDb();
  const date = req.query.date || ymd(new Date());
  await ensureSynced(date, date);
  const rows = db.prepare("SELECT * FROM calendars WHERE day=? ORDER BY start_at").all(date);
  res.json({
    date,
    meetings: rows.map((m) => ({ ...m, start: fmt(m.start_at), end: m.end_at ? fmt(m.end_at) : "" })),
    configured: dingtalk.calendarReady(),
    syncError: lastSyncError,
    lastSyncAt: lastCalendarSyncAt(db),
  });
});

// 一周摘要：用于日历周视图，显示每天的会议/待办/邮件数量
router.get("/week", async (req, res) => {
  const db = getDb();
  const start = req.query.start;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return res.status(400).json({ error: "start must be YYYY-MM-DD" });
  const startDate = new Date(start + "T00:00:00");
  const endDs = ymd(new Date(startDate.getTime() + 6 * 24 * 3600 * 1000));
  await ensureSynced(start, endDs);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const ds = ymd(d);
    const meetings = db.prepare("SELECT id, title, start_at, end_at, location, organizer, source FROM calendars WHERE day=? ORDER BY start_at").all(ds);
    const todos = db.prepare("SELECT COUNT(*) c FROM todos WHERE due_date=?").get(ds).c;
    const emails = db.prepare("SELECT COUNT(*) c FROM emails WHERE date(received_at)=? AND needs_action=1 AND source='outlook'").get(ds).c;
    days.push({ date: ds, meetings, todos, emails });
  }
  res.json({ start, days, configured: dingtalk.calendarReady(), syncError: lastSyncError, lastSyncAt: lastCalendarSyncAt(db) });
});

// 一月摘要：用于日历月视图，显示每天的会议/待办/邮件数量
router.get("/month", async (req, res) => {
  const db = getDb();
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 0 || month > 11) {
    return res.status(400).json({ error: "year and month are required (month 0-11)" });
  }
  const startDs = ymd(new Date(year, month, 1));
  const endDs = ymd(new Date(year, month + 1, 0));
  await ensureSynced(startDs, endDs);
  const days = [];
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = ymd(new Date(year, month, d));
    const meetings = db.prepare("SELECT id, title, start_at, end_at, location, organizer, source FROM calendars WHERE day=? ORDER BY start_at").all(ds);
    const todos = db.prepare("SELECT COUNT(*) c FROM todos WHERE due_date=?").get(ds).c;
    const emails = db.prepare("SELECT COUNT(*) c FROM emails WHERE date(received_at)=? AND needs_action=1 AND source='outlook'").get(ds).c;
    days.push({ date: ds, meetings, todos, emails });
  }
  res.json({ year, month, days, configured: dingtalk.calendarReady(), syncError: lastSyncError, lastSyncAt: lastCalendarSyncAt(db) });
});

// 点击某一天，聚合这一天所有数据
router.get("/day/:date", async (req, res) => {
  const db = getDb();
  const date = req.params.date;
  await ensureSynced(date, date);
  const emails = db.prepare("SELECT * FROM emails WHERE date(received_at)=? AND source='outlook' ORDER BY received_at DESC").all(date);
  const todos = db.prepare("SELECT * FROM todos WHERE due_date=? ORDER BY priority").all(date);
  const meetings = db.prepare("SELECT * FROM calendars WHERE day=? ORDER BY start_at").all(date);
  const reports = db.prepare("SELECT * FROM dingtalk_reports WHERE report_date=?").all(date);
  const review = db.prepare("SELECT * FROM daily_reviews WHERE review_date=?").get(date) || null;
  const daily = db.prepare("SELECT * FROM daily_reports WHERE report_date=?").get(date) || null;
  res.json({
    date,
    emails,
    todos,
    meetings: meetings.map((m) => ({ ...m, start: fmt(m.start_at) })),
    reports: reports.map((r) => ({ ...r, blockers: safeJson(r.blockers), needs_review: safeJson(r.needs_review) })),
    review,
    dailyReport: daily,
    configured: dingtalk.calendarReady(),
    syncError: lastSyncError,
    lastSyncAt: lastCalendarSyncAt(db),
  });
});

// 手动触发钉钉日程同步（默认同步今天；可传 start/end 覆盖范围，YYYY-MM-DD）
router.post("/sync", async (req, res) => {
  if (!dingtalk.calendarReady()) {
    return res.status(400).json({ error: "钉钉日历未就绪：请确认已配置 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET / DINGTALK_MANAGER_USER_ID" });
  }
  try {
    const start = req.body?.start || ymd(new Date());
    const end = req.body?.end || start;
    const count = await dingtalk.syncCalendarForRange(start, end);
    lastSyncError = null;
    res.json({ ok: true, count, start, end });
  } catch (err) {
    lastSyncError = err.message;
    res.status(502).json({ error: err.message });
  }
});

function safeJson(v) {
  try { return JSON.parse(v); } catch { return []; }
}

export default router;
