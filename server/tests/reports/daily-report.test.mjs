import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildDailyReportContent, mergeDailyContent } from "../../domains/daily-report.mjs";
import { createAiScheduler } from "../../ai/ai-scheduler.mjs";
// 来源明细归一化是前端渲染的降级逻辑（纯函数、无框架依赖），此处直接测试其历史数据兼容性。
import { groupSourceRefs, normalizeSourceRefs, sourceRefTarget, kindFromRef } from "../../../src/lib/report-sources.js";

// 最小可用 schema：覆盖 buildDashboard / buildAttentionItems 读取的全部表与列。
function memoryDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE dingtalk_members(user_id TEXT PRIMARY KEY,name TEXT,dept_name TEXT,is_manager INTEGER DEFAULT 0,active INTEGER DEFAULT 1);
    CREATE TABLE dingtalk_reports(id TEXT PRIMARY KEY,user_id TEXT,user_name TEXT,dept_name TEXT,report_date TEXT,blockers TEXT,needs_review TEXT,template_name TEXT,content_json TEXT,summary TEXT,created_at TEXT);
    CREATE TABLE todos(id TEXT PRIMARY KEY,title TEXT,note TEXT,status TEXT,priority TEXT,due_date TEXT,completed_at TEXT,source_type TEXT,source_id TEXT,project_id TEXT);
    CREATE TABLE emails(id TEXT PRIMARY KEY,subject TEXT,sender TEXT,action TEXT,priority TEXT,importance TEXT,due_at TEXT,priority_reason TEXT,needs_action INTEGER,source TEXT,received_at TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,owner TEXT,progress INTEGER);
    CREATE TABLE project_phases(id TEXT PRIMARY KEY,project_id TEXT,phase TEXT,start_date TEXT,end_date TEXT);
    CREATE TABLE calendars(id TEXT PRIMARY KEY,source TEXT,title TEXT,start_at TEXT,end_at TEXT,location TEXT,organizer TEXT,day TEXT,attendee_count INTEGER,accepted_count INTEGER);
    CREATE TABLE daily_reports(id TEXT PRIMARY KEY,report_date TEXT UNIQUE,content_json TEXT,generated_at TEXT);
    CREATE TABLE weekly_reports(id TEXT PRIMARY KEY,week_start TEXT UNIQUE,week_end TEXT,content_json TEXT,generated_at TEXT);
    CREATE TABLE ai_artifacts(kind TEXT NOT NULL,scope TEXT NOT NULL,input_hash TEXT NOT NULL,status TEXT NOT NULL,payload_json TEXT,source_refs_json TEXT,ai_meta_json TEXT,prompt_version TEXT,generated_at TEXT,last_attempt_at TEXT,last_error TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(kind,scope));
    CREATE TABLE ai_tasks(id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,input_hash TEXT NOT NULL,status TEXT NOT NULL,priority INTEGER NOT NULL,trigger TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,last_error TEXT,next_attempt_at TEXT,max_attempts INTEGER NOT NULL DEFAULT 3,payload_json TEXT,input_tokens INTEGER,output_tokens INTEGER,prompt_version TEXT);
  `);
  return db;
}

test("日报与周报 Consumer 通过统一队列生成并持久化结果", async () => {
  const db = memoryDb(); const scheduler = createAiScheduler({ database: () => db, aiService: {
    async weeklySummary(items) { return { narrative: `已分析 ${items.length} 份日报`, aiMeta: { provider: "test" } }; },
  } });
  const daily = buildDailyReportContent(db, "2026-09-11");
  const dailyTask = scheduler.enqueue({ kind: "report.daily", scope: "2026-09-11", inputHash: "daily-hash", trigger: "manual" });
  await scheduler.wait(dailyTask.task.id);
  assert.equal(db.prepare("SELECT status FROM ai_tasks WHERE kind='report.daily'").get().status, "ready");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM daily_reports").get().count, 1);
  const weeklyTask = scheduler.enqueue({ kind: "report.weekly", scope: "2026-09-08..2026-09-14", inputHash: "weekly-hash", trigger: "manual" });
  await scheduler.wait(weeklyTask.task.id);
  assert.equal(db.prepare("SELECT status FROM ai_tasks WHERE kind='report.weekly'").get().status, "ready");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM weekly_reports").get().count, 1);
  assert.ok(daily);
  db.close();
});

// 预置一份「一天该有的全部信号」，供多个用例复用。
function seed(db, date) {
  db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    "td1", "完成方案评审", "", "done", "P1", date, `${date}T03:00:00.000Z`, null, null, null,
  );
  db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    "to1", "确认排期", "", "inbox", "P1", date, null, null, null, null,
  );
  db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    "to2", "跟进灰度", "", "inbox", "P2", "2026-09-03", null, null, null, null,
  );
  const email = db.prepare("INSERT INTO emails VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  email.run("e1", "客户升级", "客户", "回复客户", "high", "high", null, "客户投诉", 1, "outlook", `${date}T01:00:00.000Z`);
  email.run("e2", "预算确认", "财务", "确认口径", "medium", "normal", null, "需主管拍板", 1, "outlook", `${date}T02:00:00.000Z`);
  email.run("e3", "周会纪要", "同事", "", "low", "normal", null, "", 0, "outlook", `${date}T02:30:00.000Z`);
  db.prepare("INSERT INTO dingtalk_reports(id,user_id,user_name,dept_name,report_date,blockers,needs_review,content_json,summary,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    "r1", "u1", "小李", "研发", date, JSON.stringify(["接口依赖未就绪"]), JSON.stringify(["请主管确认上线窗口"]), "[]", "", `${date}T10:00:00.000Z`,
  );
  // 有风险项目：3 天内到期且进度 < 70%
  db.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("p1", "核心平台", "小李", 30);
  db.prepare("INSERT INTO project_phases VALUES(?,?,?,?,?)").run("ph1", "p1", "开发", "2026-08-20", "2026-09-04");
}

const DATE = "2026-09-01";
const NOW = new Date("2026-09-01T12:00:00+08:00");

test("五段式日报按成果/风险/协助/计划/决策生成，并保留旧字段", () => {
  const db = memoryDb();
  seed(db, DATE);
  const content = buildDailyReportContent(db, DATE, {}, NOW);

  assert.deepEqual(Object.keys(content.sections), ["achievements", "risks", "assistance", "tomorrow", "decisions"]);
  // 关键成果只含真正有成果语义的项；邮件「已分诊」数量不在此段，且不得出现「已处理」措辞
  assert.deepEqual(content.sections.achievements, ["完成待办：完成方案评审"]);
  assert.ok(!content.sections.achievements.some((item) => /已处理|处理邮件/.test(item)));
  assert.ok(content.sections.risks.includes("接口依赖未就绪"));
  assert.ok(content.sections.risks.includes("核心平台（风险 · 进度 30% · 负责人 小李）"));
  assert.deepEqual(content.sections.assistance, ["请主管确认上线窗口"]);
  assert.deepEqual(content.sections.tomorrow, ["跟进灰度（截止 2026-09-03）"]);
  assert.deepEqual(content.sections.decisions, []);

  assert.deepEqual(content.metrics, { pendingEmails: 2, openTodos: 1, blockers: 1, reviews: 1, triagedEmails: 1 });
  assert.match(content.headline, /今日需处理邮件 2 封/);

  // 向后兼容字段必须继续存在
  assert.equal(typeof content.summary, "string");
  assert.deepEqual(content.teamBlockers, ["接口依赖未就绪"]);
  assert.deepEqual(content.needManagerReview, ["请主管确认上线窗口"]);
  assert.equal(content.pendingEmails, 2);
  assert.equal(content.openTodos, 1);
  assert.equal(typeof content.generatedAt, "string");
  db.close();
});

test("sourceRefs 对象化后字段完整，不丢失 title/kind/priority/recommendedAction", () => {
  const db = memoryDb();
  seed(db, DATE);
  const content = buildDailyReportContent(db, DATE, {}, NOW);

  assert.ok(Array.isArray(content.sourceRefs) && content.sourceRefs.length > 0);
  const fields = ["ref", "kind", "title", "detail", "priority", "recommendedAction"];
  for (const item of content.sourceRefs) {
    assert.deepEqual(Object.keys(item), fields);
    assert.ok(item.ref && typeof item.ref === "string");
    assert.ok(["todo", "email", "blocker", "review", "project"].includes(item.kind));
    assert.ok(item.title && typeof item.title === "string");
    assert.ok(["P0", "P1", "P2"].includes(item.priority));
    assert.ok(item.recommendedAction && typeof item.recommendedAction === "string");
  }

  const emailItem = content.sourceRefs.find((item) => item.kind === "email");
  assert.equal(emailItem.ref, "outlook:e1");
  assert.equal(emailItem.title, "客户升级");
  assert.equal(emailItem.priority, "P0");
  assert.equal(emailItem.detail, "客户 · 客户投诉");

  const todoItem = content.sourceRefs.find((item) => item.kind === "todo");
  assert.equal(todoItem.ref, "todo:to1");
  assert.equal(todoItem.title, "确认排期");

  const projectItem = content.sourceRefs.find((item) => item.kind === "project");
  assert.equal(projectItem.ref, "project:p1");

  const blockerItem = content.sourceRefs.find((item) => item.kind === "blocker");
  assert.equal(blockerItem.ref, `dingtalk:u1:${DATE}`);
  db.close();
});

test("历史 string[] 来源引用可优雅降级，且不影响新格式生成", () => {
  // 前端降级：字符串引用不抛错、能推断分组与跳转
  const legacy = ["outlook:123", "todo:t9", "dingtalk:u1:2026-09-01", "project:p1"];
  const normalized = normalizeSourceRefs(legacy);
  assert.equal(normalized.length, 4);
  assert.equal(normalized[0].kind, "email");
  assert.equal(normalized[0].title, "123");
  assert.equal(normalized[2].kind, "blocker");
  assert.equal(kindFromRef("unknown:1"), "other");

  const groups = groupSourceRefs(legacy);
  assert.deepEqual(groups.map((group) => group.label), ["邮件", "待办", "团队日志", "项目"]);
  assert.deepEqual(sourceRefTarget(normalized[2]), "/team?date=2026-09-01");
  assert.deepEqual(sourceRefTarget(normalized[0]), "/mail");
  assert.deepEqual(sourceRefTarget({ kind: "review", ref: "dingtalk:u2:2026-09-01" }), "/team?date=2026-09-01");
  assert.equal(sourceRefTarget({ kind: "other", ref: "x:1" }), null);
  assert.deepEqual(normalizeSourceRefs(null), []);
  assert.deepEqual(groupSourceRefs(undefined), []);

  // 后端：旧日报（string sourceRefs）作为 existing 传入生成流程，不崩溃且升级为对象数组
  const db = memoryDb();
  seed(db, DATE);
  const legacyContent = {
    summary: "旧摘要",
    teamBlockers: ["旧阻塞"],
    needManagerReview: [],
    sourceRefs: legacy,
    manual: { decisions: ["旧决策"], notes: "旧备注" },
  };
  const upgraded = buildDailyReportContent(db, DATE, legacyContent, NOW);
  assert.ok(upgraded.sourceRefs.every((item) => item && typeof item === "object" && item.ref));
  assert.deepEqual(upgraded.manual.decisions, ["旧决策"]);

  // PUT 合并：历史 string[] 不会被破坏，其他字段保留
  const merged = mergeDailyContent(legacyContent, { sections: { tomorrow: ["补一条计划"] } });
  assert.deepEqual(merged.sourceRefs, legacy);
  assert.equal(merged.summary, "旧摘要");
  assert.deepEqual(merged.sections.tomorrow, ["补一条计划"]);
  db.close();
});

test("manual.decisions 不被 generate 覆盖，且 mergeDailyContent 不抹掉未提交字段", () => {
  const db = memoryDb();
  seed(db, DATE);
  const existing = {
    manual: { decisions: ["冻结新需求", "暂停非核心迭代"], notes: "主管手记" },
    sections: { decisions: ["不应作为来源"], achievements: ["历史成果"] },
  };
  const content = buildDailyReportContent(db, DATE, existing, NOW);

  // 关键决策只能来自 manual.decisions
  assert.deepEqual(content.manual.decisions, ["冻结新需求", "暂停非核心迭代"]);
  assert.equal(content.manual.notes, "主管手记");
  assert.deepEqual(content.sections.decisions, ["冻结新需求", "暂停非核心迭代"]);

  // 无人工决策时为空数组，AI 不编造
  const empty = buildDailyReportContent(db, DATE, {}, NOW);
  assert.deepEqual(empty.sections.decisions, []);
  assert.deepEqual(empty.manual.decisions, []);

  // 合并时只提交 manual.decisions，不应抹掉 manual.notes
  const base = { sections: { achievements: ["a"], risks: ["b"] }, manual: { decisions: ["d1"], notes: "note" }, headline: "H" };
  const merged = mergeDailyContent(base, { manual: { decisions: ["d2"] }, sections: { risks: ["b2"] } });
  assert.deepEqual(merged.manual, { decisions: ["d2"], notes: "note" });
  assert.deepEqual(merged.sections, { achievements: ["a"], risks: ["b2"] });
  assert.equal(merged.headline, "H");
  assert.deepEqual(mergeDailyContent(null, { headline: "x" }), { headline: "x" });
  db.close();
});

test("项目风险项带负责人，owner 为空时整段省略", () => {
  const db = memoryDb();
  seed(db, DATE);
  // 追加一个逾期且无 owner 的项目：应只显示「已逾期」，不出现「负责人」占位
  db.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("p2", "历史系统", "", 40);
  db.prepare("INSERT INTO project_phases VALUES(?,?,?,?,?)").run("ph2", "p2", "收尾", "2026-08-01", "2026-08-15");

  const content = buildDailyReportContent(db, DATE, {}, NOW);
  assert.ok(content.sections.risks.includes("核心平台（风险 · 进度 30% · 负责人 小李）"), "有 owner 的风险项应带负责人");
  assert.ok(content.sections.risks.includes("历史系统（已逾期）"), "无 owner 的逾期项应省略负责人段");
  assert.ok(!content.sections.risks.some((item) => item.includes("未设置")), "不得出现「未设置」占位措辞");
  assert.ok(!content.sections.risks.includes("历史系统（已逾期 · 负责人 ）"));
  db.close();
});

test("无成果信号时给出中性占位，且不虚构任何内容", () => {
  const db = memoryDb();
  const content = buildDailyReportContent(db, DATE, {}, NOW);

  assert.deepEqual(content.sections.achievements, ["当日暂无已确认的成果记录"]);
  assert.deepEqual(content.sections.risks, []);
  assert.deepEqual(content.sections.assistance, []);
  assert.deepEqual(content.sections.tomorrow, []);
  assert.deepEqual(content.sections.decisions, []);
  assert.deepEqual(content.metrics, { pendingEmails: 0, openTodos: 0, blockers: 0, reviews: 0, triagedEmails: 0 });
  assert.deepEqual(content.sourceRefs, []);
  db.close();
});
