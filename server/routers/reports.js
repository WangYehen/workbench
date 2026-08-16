import express from "express";
import { getDb } from "../db.mjs";
import { ai } from "../ai.mjs";

const router = express.Router();

function safeJson(v, fb) { try { return JSON.parse(v); } catch { return fb; } }

// 把钉钉日志 content_json 还原成可读的多行文本。
// 同步时存的是 `${label}：${value}` 用 \n 拼接的字符串（label 常为空，且 value 内部含 \r\n）。
// 未来若改为结构化数组则直接取字段。清洗规则：去掉每行行首孤立的冒号、清除 \r、合并空行。
function cleanContent(raw) {
  if (!raw) return "";
  let text = raw;
  // content_json 存的是 JSON.stringify(contents)，即带外层引号的 JSON 字符串；
  // 若已改为结构化数组（未来）则直接取字段。先解析解包一层。
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((it) => `${it && it.label ? it.label + "：" : ""}${it && (it.value ?? it.content ?? "")}`.trim())
        .filter(Boolean)
        .join("\n");
    }
    if (typeof parsed === "string") text = parsed; // 解包一层引号
  } catch { /* 非 JSON，按原文处理 */ }
  return text
    .replace(/\r/g, "") // 去掉回车
    .split("\n")
    .map((l) => l.replace(/^[:：]\s?/, "").trimEnd()) // 去掉行首孤立冒号
    .filter((l) => l.length > 0 && l !== "[]" && l !== "【】") // 去除空行/空段及空标记
    .join("\n");
}

router.get("/daily", (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT * FROM daily_reports WHERE report_date=?").get(date);
  res.json({ date, report: row ? { ...row, content_json: safeJson(row.content_json, {}) } : null });
});

// 可用日志日期列表（供前端默认选中最近有数据的一天）
router.get("/dingtalk/dates", (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT DISTINCT report_date d FROM dingtalk_reports ORDER BY d DESC").all();
  res.json({ dates: rows.map((r) => r.d) });
});

// 按日期返回真实钉钉日报（团队成员当日提交内容），为日报页提供真实数据源
router.get("/dingtalk", (req, res) => {
  const db = getDb();
  let date = req.query.date;
  if (!date) {
    const r = db.prepare("SELECT MAX(report_date) d FROM dingtalk_reports").get();
    date = r?.d || new Date().toISOString().slice(0, 10);
  }
  const rows = db
    .prepare("SELECT * FROM dingtalk_reports WHERE report_date=? ORDER BY user_name")
    .all(date);
  const reports = rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    user_name: r.user_name,
    template_name: r.template_name,
    content: cleanContent(r.content_json),
    blockers: safeJson(r.blockers, []),
    needs_review: safeJson(r.needs_review, []),
    summary: r.summary || "",
  }));
  res.json({ date, reports, total: reports.length });
});


router.post("/daily/generate", async (req, res) => {
  const db = getDb();
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const emails = db.prepare("SELECT COUNT(*) c FROM emails WHERE needs_action=1 AND date(received_at)=? AND source='outlook'").get(date).c;
  const todos = db.prepare("SELECT COUNT(*) c FROM todos WHERE status!='done' AND due_date=?").get(date).c;
  const reports = db.prepare("SELECT * FROM dingtalk_reports WHERE report_date=?").all(date);
  const blockers = reports.flatMap((r) => safeJson(r.blockers, []));
  const reviews = reports.flatMap((r) => safeJson(r.needs_review, []));
  const content = {
    date,
    pendingEmails: emails,
    openTodos: todos,
    teamBlockers: blockers,
    needManagerReview: reviews,
    summary: `今日需处理邮件 ${emails} 封，待办 ${todos} 项，团队阻塞 ${blockers.length} 项，需主管审核 ${reviews.length} 项。`,
  };
  let narrative = "";
  if (ai.available()) {
    try {
      const r = await ai.weeklySummary([{ report_date: date, content_json: JSON.stringify(content) }]);
      narrative = r.narrative || "";
      content.narrative = narrative;
    } catch { /* 忽略 AI */ }
  }
  db.prepare(
    "INSERT INTO daily_reports(id, report_date, content_json, generated_at) VALUES(?,?,?,?) ON CONFLICT(report_date) DO UPDATE SET content_json=excluded.content_json, generated_at=excluded.generated_at",
  ).run("d" + Math.random().toString(36).slice(2, 10), date, JSON.stringify(content), new Date().toISOString());
  res.json({ ok: true, content });
});

// 编辑某日日报（合并更新 content_json，便于人工润色小结）
router.put("/daily", (req, res) => {
  const db = getDb();
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT * FROM daily_reports WHERE report_date=?").get(date);
  if (!row) return res.status(404).json({ error: "该日期日报不存在，请先生成" });
  const base = safeJson(row.content_json, {});
  const patch = req.body.content && typeof req.body.content === "object" ? req.body.content : {};
  const content = { ...base, ...patch };
  db.prepare("UPDATE daily_reports SET content_json=? WHERE report_date=?").run(JSON.stringify(content), date);
  res.json({ ok: true, report: { ...row, content_json: content } });
});

router.get("/weekly", (req, res) => {
  const db = getDb();
  const weekStart = req.query.weekStart;
  const row = weekStart ? db.prepare("SELECT * FROM weekly_reports WHERE week_start=?").get(weekStart) : db.prepare("SELECT * FROM weekly_reports ORDER BY week_start DESC LIMIT 1").get();
  res.json({ report: row ? { ...row, content_json: safeJson(row.content_json, {}) } : null });
});

router.post("/weekly/generate", async (req, res) => {
  const db = getDb();
  const { weekStart, weekEnd } = req.body;
  const dailies = db.prepare("SELECT * FROM daily_reports WHERE report_date>=? AND report_date<=? ORDER BY report_date").all(weekStart, weekEnd);
  let content = { weekStart, weekEnd, note: `基于 ${dailies.length} 份日报汇总` };
  if (ai.available() && dailies.length) {
    try {
      const r = await ai.weeklySummary(dailies.map((d) => ({ report_date: d.report_date, content_json: safeJson(d.content_json, {}) })));
      content = { ...content, ...r };
    } catch { /* 忽略 */ }
  }
  db.prepare(
    "INSERT INTO weekly_reports(id, week_start, week_end, content_json, generated_at) VALUES(?,?,?,?,?) ON CONFLICT(week_start) DO UPDATE SET content_json=excluded.content_json, generated_at=excluded.generated_at, week_end=excluded.week_end",
  ).run("w" + Math.random().toString(36).slice(2, 10), weekStart, weekEnd, JSON.stringify(content), new Date().toISOString());
  res.json({ ok: true, content });
});

export default router;
