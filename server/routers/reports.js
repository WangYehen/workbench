import express from "express";
import { getDb } from "../db.mjs";
import { ai } from "../ai.mjs";

const router = express.Router();

function safeJson(v, fb) { try { return JSON.parse(v); } catch { return fb; } }

// 解析 content_json 为结构化 contents 数组，兼容新旧两种格式
// 新格式：[{sort, type, key, value}] - 钉钉 API 原始结构
// 旧格式：JSON.stringify("今日完成工作：xxx\n明日工作计划：yyy") - 扁平字符串
function parseContents(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    // 新格式：数组且元素有 key 字段
    if (Array.isArray(parsed) && parsed.length && parsed[0]?.key) {
      return parsed.map((c) => ({
        sort: String(c.sort || ""),
        type: String(c.type || "1"),
        key: c.key || "",
        value: (c.value || "").replace(/\r/g, ""),
      }));
    }
    // 旧格式：字符串，可能是 "今日完成工作：xxx\n明日工作计划：yyy"
    if (typeof parsed === "string") {
      return parseFlatContent(parsed);
    }
    if (Array.isArray(parsed)) {
      const text = parsed.map((it) => `${it?.label || ""}：${it?.value ?? it?.content ?? ""}`).filter(Boolean).join("\n");
      return text ? parseFlatContent(text) : [];
    }
  } catch { /* 非 JSON，按纯文本处理 */ }
  return raw ? parseFlatContent(raw) : [];
}

// 将旧的扁平字符串格式（"key：value\nkey：value"）拆分为结构化数组
// 旧格式中 key 和 value 在同一行，如 "今日完成工作：1、TMS-xxx\r\n2、工作台xxx"
// 若旧数据无 key（如 "：value\n：value"），则整段作为"今日完成工作"
function parseFlatContent(text) {
  if (!text) return [];
  const cleaned = text.replace(/\r/g, "").split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== "[]" && l !== "【】");
  if (cleaned.length === 0) return [];

  // 已知的 key 名称，用于按 "key：" 分割
  const KNOWN_KEYS = ["今日完成工作", "今日遗留工作", "明日工作计划", "需要协作工作", "图片", "附件"];
  const keyPattern = new RegExp(`^(${KNOWN_KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[：:]`);

  // 检测是否有已知 key 存在
  const hasKnownKey = cleaned.some((l) => keyPattern.test(l));
  if (!hasKnownKey) {
    // 旧数据无 key（label 为空），整段作为"今日完成工作"
    const content = cleaned.map((l) => l.replace(/^[:：]\s?/, "")).join("\n");
    return content ? [{ sort: "1", type: "1", key: "今日完成工作", value: content }] : [];
  }

  // 有已知 key，按 key 分割
  const sections = [];
  let currentKey = KNOWN_KEYS[0];
  let currentValue = [];

  for (const line of cleaned) {
    if (keyPattern.test(line)) {
      // 保存上一个 section
      sections.push({ sort: String(sections.length + 1), type: "1", key: currentKey, value: currentValue.join("\n") });
      // 提取新 key
      const m = line.match(keyPattern);
      currentKey = m ? m[1] : line.split(/[：:]/)[0];
      // 同行的 value 部分（key：之后的内容）
      const afterKey = line.replace(keyPattern, "").trim();
      currentValue = afterKey ? [afterKey] : [];
    } else {
      currentValue.push(line);
    }
  }
  // 最后一个 section
  sections.push({ sort: String(sections.length + 1), type: "1", key: currentKey, value: currentValue.join("\n") });
  // 过滤掉空 section（key 不在已知列表中的跳过）
  return sections.filter((s) => KNOWN_KEYS.includes(s.key));
}

// 把钉钉日志 content_json 还原成可读的多行文本（向后兼容旧接口）。
function cleanContent(raw) {
  return parseContents(raw)
    .map((c) => c.key ? `${c.key}：${c.value}` : c.value)
    .filter(Boolean)
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
// 返回结构化 contents 数组 + 部门列表，支持前端按 key 分区展示和部门筛选
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
  // 解析 contents 为结构化数组
  const reports = rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    user_name: r.user_name,
    dept_name: r.dept_name || "",
    template_name: r.template_name,
    contents: parseContents(r.content_json),
    blockers: safeJson(r.blockers, []),
    needs_review: safeJson(r.needs_review, []),
    summary: r.summary || "",
  }));
  // 提取去重的部门列表，供前端筛选
  const departments = [...new Set(reports.map((r) => r.dept_name).filter(Boolean))].sort();
  res.json({ date, reports, departments, total: reports.length });
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
