import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildDailyReportContent } from "../../domains/daily-report.mjs";

// 覆盖「人工编辑段落锁定层」：用户在界面上改过的段落，重新生成时不得被源数据静默覆盖；
// 未改动的段落仍必须按最新源数据重建（逐段 diff，而不是一改就锁全部）。
// 独立于 daily-report.test.mjs（该文件由项目所有者并行维护，保持不动）。

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
  `);
  return db;
}

/** 预置一天的全部信号，使五段都有可重建的源数据。 */
function seed(db, date) {
  db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    "td1", "完成方案评审", "", "done", "P1", date, `${date}T03:00:00.000Z`, null, null, null,
  );
  db.prepare("INSERT INTO todos VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    "to2", "跟进灰度", "", "inbox", "P2", "2026-09-03", null, null, null, null,
  );
  db.prepare("INSERT INTO dingtalk_reports(id,user_id,user_name,dept_name,report_date,blockers,needs_review,content_json,summary,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    "r1", "u1", "小李", "研发", date, JSON.stringify(["接口依赖未就绪"]), JSON.stringify(["请主管确认上线窗口"]), "[]", "", `${date}T10:00:00.000Z`,
  );
}

const DATE = "2026-09-01";
const NOW = new Date("2026-09-01T12:00:00+08:00");

test("人工编辑过的段落（risks）在重新生成时不被源数据覆盖", () => {
  const db = memoryDb();
  seed(db, DATE);
  const existing = { manual: { sections: { risks: ["人工改过的风险"] } } };

  const content = buildDailyReportContent(db, DATE, existing, NOW);

  assert.deepEqual(content.sections.risks, ["人工改过的风险"]);
  // 源数据里本有「接口依赖未就绪」，必须确认它没有被重建回来
  assert.ok(!content.sections.risks.includes("接口依赖未就绪"));
  db.close();
});

test("未锁定的段落仍按最新源数据重建（逐段 diff，而非一改锁全部）", () => {
  const db = memoryDb();
  seed(db, DATE);
  const existing = { manual: { sections: { risks: ["人工改过的风险"] } } };

  const content = buildDailyReportContent(db, DATE, existing, NOW);

  assert.deepEqual(content.sections.achievements, ["完成待办：完成方案评审"]);
  assert.deepEqual(content.sections.assistance, ["请主管确认上线窗口"]);
  assert.deepEqual(content.sections.tomorrow, ["跟进灰度（截止 2026-09-03）"]);
  assert.deepEqual(content.sections.risks, ["人工改过的风险"]);
  db.close();
});

test("manual.sections 被原样回填，且锁定空数组同样生效", () => {
  const db = memoryDb();
  seed(db, DATE);
  const existing = {
    manual: { decisions: ["人工决策"], notes: "主管手记", sections: { risks: ["人工风险"], tomorrow: [] } },
  };

  const content = buildDailyReportContent(db, DATE, existing, NOW);

  // 原样回填：保证 PUT 二次合并时不丢锁定信息
  assert.deepEqual(content.manual.sections, { risks: ["人工风险"], tomorrow: [] });
  assert.deepEqual(content.manual.decisions, ["人工决策"]);
  assert.equal(content.manual.notes, "主管手记");
  // 用户把某段清空也是一次「改动」：空数组应被锁定，不得被源数据重新填回
  assert.deepEqual(content.sections.tomorrow, []);
  db.close();
});

test("decisions 始终由 manual.decisions 派生，不因 manual.sections.decisions 分叉", () => {
  const db = memoryDb();
  seed(db, DATE);
  const existing = {
    manual: { decisions: ["人工决策A"], sections: { decisions: ["段内伪造决策"] } },
  };

  const content = buildDailyReportContent(db, DATE, existing, NOW);

  assert.deepEqual(content.sections.decisions, ["人工决策A"]);
  assert.deepEqual(content.manual.decisions, ["人工决策A"]);
  assert.ok(!content.sections.decisions.includes("段内伪造决策"));
  db.close();
});

test("无 manual.sections 的旧数据行为不变且不抛错", () => {
  const db = memoryDb();
  seed(db, DATE);

  // 老格式：只有 teamBlockers / needManagerReview，没有 manual
  const legacy = { summary: "旧摘要", teamBlockers: ["旧阻塞"], needManagerReview: ["旧待审"] };
  let content;
  assert.doesNotThrow(() => { content = buildDailyReportContent(db, DATE, legacy, NOW); });
  assert.deepEqual(content.manual.sections, {});
  assert.ok(content.sections.risks.includes("接口依赖未就绪"), "旧数据不携带锁定，风险段应按源数据重建");
  assert.deepEqual(content.sections.assistance, ["请主管确认上线窗口"]);
  assert.ok(!content.sections.risks.includes("旧阻塞"), "旧字段 teamBlockers 不是生成输入，风险段只由源数据重建");

  // 空对象 / null / undefined 均不抛错
  assert.deepEqual(buildDailyReportContent(db, DATE, {}, NOW).manual.sections, {});
  assert.doesNotThrow(() => buildDailyReportContent(db, DATE, null, NOW));
  assert.doesNotThrow(() => buildDailyReportContent(db, DATE, undefined, NOW));

  // 脏数据：manual.sections 不是对象时按「无锁定」处理，不抛错
  assert.doesNotThrow(() => buildDailyReportContent(db, DATE, { manual: { sections: "oops" } }, NOW));
  const dirty = buildDailyReportContent(db, DATE, { manual: { sections: { risks: "not-an-array" } } }, NOW);
  assert.ok(dirty.sections.risks.includes("接口依赖未就绪"));
  db.close();
});
