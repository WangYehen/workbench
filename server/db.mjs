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
  return db
    .prepare(
      "SELECT DISTINCT COALESCE(NULLIF(user_id, ''), user_name) AS key, user_name AS name " +
        "FROM dingtalk_reports WHERE user_name IS NOT NULL AND user_name <> ''",
    )
    .all();
}
