import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config, ensureDataDir } from "./config.mjs";

ensureDataDir();
const DB_PATH = path.join(config.dataDir, "workbench.sqlite");

let db;

export function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      sender TEXT,
      sender_email TEXT,
      received_at TEXT,
      importance TEXT DEFAULT 'normal',
      has_flag INTEGER DEFAULT 0,
      due_at TEXT,
      preview TEXT,
      needs_action INTEGER DEFAULT 0,
      reason TEXT,
      confidence REAL,
      summary TEXT,
      source TEXT DEFAULT 'outlook',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_emails_needs ON emails(needs_action, received_at DESC);

    CREATE TABLE IF NOT EXISTS dingtalk_members (
      user_id TEXT PRIMARY KEY,
      name TEXT,
      dept_id TEXT,
      dept_name TEXT,
      is_manager INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dingtalk_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT,
      report_date TEXT NOT NULL,
      template_name TEXT,
      content_json TEXT,
      blockers TEXT,
      needs_review TEXT,
      summary TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_date ON dingtalk_reports(report_date DESC, user_id);

    CREATE TABLE IF NOT EXISTS calendars (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT,
      location TEXT,
      organizer TEXT,
      day TEXT NOT NULL,
      raw_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cal_day ON calendars(day);

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      note TEXT,
      status TEXT DEFAULT 'inbox',
      priority TEXT DEFAULT 'P1',
      due_date TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_reviews (
      id TEXT PRIMARY KEY,
      review_date TEXT NOT NULL UNIQUE,
      did TEXT,
      learned TEXT,
      mistake TEXT,
      mood TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_reports (
      id TEXT PRIMARY KEY,
      report_date TEXT NOT NULL UNIQUE,
      content_json TEXT,
      generated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS weekly_reports (
      id TEXT PRIMARY KEY,
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      content_json TEXT,
      generated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_weekly ON weekly_reports(week_start DESC);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT,
      color TEXT DEFAULT '#378ADD',
      note TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_phases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      phase TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_phase_proj ON project_phases(project_id);

    CREATE TABLE IF NOT EXISTS ai_hot_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value_json TEXT
    );

    CREATE TABLE IF NOT EXISTS email_drafts (
      message_id TEXT PRIMARY KEY,
      draft_text TEXT NOT NULL,
      tone TEXT DEFAULT 'formal',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 手动维护的钉钉日志模板（替代旧的“调钉钉接口查全部模板 + 勾选”方案）
    -- name 即钉钉日志接口服务端过滤用的 template_name；enabled=1 才参与同步拉取
    CREATE TABLE IF NOT EXISTS report_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    d.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version),
  );
  const versions = [
    "001_core",
    "002_dingtalk_members",
    "003_projects",
    "004_ai_hot_cache",
  ];
  for (const v of versions) {
    if (!applied.has(v)) {
      d.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(
        v,
        new Date().toISOString(),
      );
    }
  }

  // 005：projects 表补 progress 列（已有库向后兼容）
  const projCols = d.prepare("PRAGMA table_info(projects)").all().map((c) => c.name);
  if (!projCols.includes("progress")) {
    d.exec("ALTER TABLE projects ADD COLUMN progress INTEGER NOT NULL DEFAULT 0");
  }

  // 006：emails 表补 action / priority / priority_reason / due_source / web_link
  const emCols = d.prepare("PRAGMA table_info(emails)").all().map((c) => c.name);
  const emAdds = {
    action: "TEXT",
    priority: "TEXT",
    priority_reason: "TEXT",
    due_source: "TEXT",
    web_link: "TEXT",
  };
  for (const [c, t] of Object.entries(emAdds)) {
    if (!emCols.includes(c)) d.exec(`ALTER TABLE emails ADD COLUMN ${c} ${t}`);
  }

  // 008：dingtalk_reports 补 dept_name 列（从钉钉 API 响应提取部门信息）
  const reportCols = d.prepare("PRAGMA table_info(dingtalk_reports)").all().map((c) => c.name);
  if (!reportCols.includes("dept_name")) {
    d.exec("ALTER TABLE dingtalk_reports ADD COLUMN dept_name TEXT DEFAULT ''");
  }

  // 009：通讯录成员作为团队口径基线，可停用离职/无需提交成员。
  const memberCols = d.prepare("PRAGMA table_info(dingtalk_members)").all().map((c) => c.name);
  if (!memberCols.includes("active")) {
    d.exec("ALTER TABLE dingtalk_members ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  }

  // 010：待办保留来源血缘与项目/责任人关联；来源唯一索引保证重复转换幂等。
  const todoCols = d.prepare("PRAGMA table_info(todos)").all().map((c) => c.name);
  const todoAdds = {
    source_type: "TEXT",
    source_id: "TEXT",
    project_id: "TEXT",
    assignee_id: "TEXT",
  };
  for (const [column, type] of Object.entries(todoAdds)) {
    if (!todoCols.includes(column)) d.exec(`ALTER TABLE todos ADD COLUMN ${column} ${type}`);
  }
  d.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_source ON todos(source_type, source_id) " +
      "WHERE source_type IS NOT NULL AND source_id IS NOT NULL",
  );

  // 007：weekly_reports 的 week_start 需 UNIQUE（/weekly/generate 用 ON CONFLICT(week_start) 覆盖生成）。
  // 旧库的 idx_weekly 是普通索引，ON CONFLICT 会报 "does not match any PRIMARY KEY or UNIQUE constraint"；
  // 把该索引重建为 UNIQUE（SQLite 的 ON CONFLICT 同样认唯一索引），幂等：仅当现有索引非唯一时重建。
  const weeklyIdx = d.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_weekly'").get();
  if (!weeklyIdx?.sql?.toUpperCase().includes("UNIQUE")) {
    d.exec("DROP INDEX IF EXISTS idx_weekly");
    d.exec("CREATE UNIQUE INDEX idx_weekly ON weekly_reports(week_start)");
  }
}

export function upsert(table, rows, conflictCols) {
  const d = getDb();
  if (!rows || !rows.length) return;
  const cols = Object.keys(rows[0]);
  const placeholders = cols.map(() => "?").join(", ");
  const updateCols = cols.filter((c) => !conflictCols.includes(c));
  const updateClause = updateCols.map((c) => `${c} = excluded.${c}`).join(", ");
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})
    ON CONFLICT(${conflictCols.join(", ")}) DO UPDATE SET ${updateClause}`;
  const stmt = d.prepare(sql);
  const tx = d.transaction((items) => {
    for (const item of items) stmt.run(...cols.map((c) => item[c]));
  });
  tx(rows);
}

// 团队「应提交日报」基线：历史日志中出现过的真实提交人。
// user_id 可能为空（钉钉未回 creator.userid），用 user_name 兜底作为唯一键。
// 采用「历史真实提交人」作基线：某天不在 dingtalk_reports 中即视为未提交。
// 集中于此，便于将来切换为「手动名册」或「钉钉通讯录」基线时只改一处。
export function getRosterBaseline(db) {
  const roster = db
    .prepare(
      "SELECT user_id AS key, name, dept_name FROM dingtalk_members " +
        "WHERE COALESCE(active, 1)=1 AND COALESCE(is_manager, 0)=0 AND name IS NOT NULL AND name<>'' ORDER BY name",
    )
    .all();
  if (roster.length) return roster;
  return db.prepare(
    "SELECT DISTINCT COALESCE(NULLIF(user_id, ''), user_name) AS key, user_name AS name, COALESCE(dept_name, '') AS dept_name " +
      "FROM dingtalk_reports WHERE user_name IS NOT NULL AND user_name <> '' ORDER BY user_name",
  ).all();
}
