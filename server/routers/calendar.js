import express from "express";
import { getDb } from "../db.mjs";
import { dingtalk } from "../dingtalk.mjs";

const router = express.Router();

function fmt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

router.get("/meetings", async (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  let rows = db.prepare("SELECT * FROM calendars WHERE day=? ORDER BY start_at").all(date);
  if (rows.length === 0 && dingtalk.isConfigured()) {
    try {
      const events = await dingtalk.fetchCalendar(date);
      const now = new Date().toISOString();
      const db2 = getDb();
      const ins = db2.prepare(
        "INSERT OR IGNORE INTO calendars(id, source, title, start_at, end_at, location, organizer, day, raw_json, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      );
      const tx = db2.transaction((evs) => evs.forEach((e) => ins.run(e.id, e.source, e.title, e.start_at, e.end_at, e.location, e.organizer, e.day, JSON.stringify(e), now)));
      tx(events);
      rows = db.prepare("SELECT * FROM calendars WHERE day=? ORDER BY start_at").all(date);
    } catch {
      /* 忽略，返回空 */
    }
  }
  res.json({
    date,
    meetings: rows.map((m) => ({ ...m, start: fmt(m.start_at), end: m.end_at ? fmt(m.end_at) : "" })),
    configured: dingtalk.isConfigured(),
  });
});

// 一周摘要：用于日历周视图，显示每天的会议/待办/邮件数量
router.get("/week", (req, res) => {
  const db = getDb();
  const start = req.query.start;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return res.status(400).json({ error: "start must be YYYY-MM-DD" });
  const startDate = new Date(start + "T00:00:00");
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const ds = d.toISOString().slice(0, 10);
    const meetings = db.prepare("SELECT id, title, start_at, end_at, location, organizer FROM calendars WHERE day=? ORDER BY start_at").all(ds);
    const todos = db.prepare("SELECT COUNT(*) c FROM todos WHERE due_date=? OR (status!='done' AND due_date IS NULL)").get(ds).c;
    const emails = db.prepare("SELECT COUNT(*) c FROM emails WHERE date(received_at)=? AND needs_action=1 AND source='outlook'").get(ds).c;
    days.push({ date: ds, meetings, todos, emails });
  }
  res.json({ start, days });
});

// 点击某一天，聚合这一天所有数据
router.get("/day/:date", (req, res) => {
  const db = getDb();
  const date = req.params.date;
  const emails = db.prepare("SELECT * FROM emails WHERE date(received_at)=? AND source='outlook' ORDER BY received_at DESC").all(date);
  const todos = db.prepare("SELECT * FROM todos WHERE due_date=? OR status!='done' ORDER BY priority").all(date);
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
  });
});

function safeJson(v) {
  try { return JSON.parse(v); } catch { return []; }
}

export default router;
