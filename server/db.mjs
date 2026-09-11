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
      attendee_count INTEGER,
      accepted_count INTEGER,
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
    CREATE TABLE IF NOT EXISTS dws_todo_event_log (
      event_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      handled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_drafts (
      message_id TEXT PRIMARY KEY,
      draft_text TEXT NOT NULL,
      tone TEXT DEFAULT 'formal',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- DWS 个人消息：原文在本地归档，SQLite 仅负责索引、状态与关联。
    CREATE TABLE IF NOT EXISTS dingtalk_chat_conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      peer_user_id TEXT,
      peer_name TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      retention_mode TEXT NOT NULL DEFAULT 'inherit',
      last_message_at TEXT,
      sync_cursor_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dt_chat_conversations_type ON dingtalk_chat_conversations(type, enabled);

    CREATE TABLE IF NOT EXISTS dingtalk_chat_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES dingtalk_chat_conversations(id) ON DELETE CASCADE,
      sender_id TEXT,
      sender_name TEXT,
      direction TEXT NOT NULL DEFAULT 'inbound',
      sent_at TEXT NOT NULL,
      message_type TEXT,
      content TEXT,
      mentioned_me INTEGER NOT NULL DEFAULT 0,
      context_only INTEGER NOT NULL DEFAULT 0,
      context_root_id TEXT,
      quoted_message_id TEXT,
      raw_json TEXT,
      archive_path TEXT,
      processing_status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dt_chat_messages_conversation ON dingtalk_chat_messages(conversation_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dt_chat_messages_attention ON dingtalk_chat_messages(processing_status, mentioned_me, direction, sent_at DESC);

    CREATE TABLE IF NOT EXISTS dingtalk_message_analysis (
      message_id TEXT PRIMARY KEY REFERENCES dingtalk_chat_messages(id) ON DELETE CASCADE,
      classification TEXT NOT NULL DEFAULT 'uncertain',
      attention_type TEXT NOT NULL DEFAULT 'ignore',
      summary TEXT,
      action_text TEXT,
      due_date TEXT,
      priority TEXT,
      confidence INTEGER NOT NULL DEFAULT 0,
      assignee_self INTEGER NOT NULL DEFAULT 0,
      ai_meta_json TEXT,
      todo_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_links (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      confidence INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'suggested',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_type, source_id, target_type, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_links_source ON work_links(source_type, source_id, status);

    -- AI 调度层：只保存领域引用、摘要结果与诊断元数据，不保存邮件正文。
    CREATE TABLE IF NOT EXISTS ai_artifacts (
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      payload_json TEXT,
      source_refs_json TEXT,
      ai_meta_json TEXT,
      generated_at TEXT,
      last_attempt_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, scope)
    );
    CREATE TABLE IF NOT EXISTS ai_tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 0,
      trigger TEXT NOT NULL DEFAULT 'automatic',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_tasks_pending ON ai_tasks(status, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_ai_artifacts_status ON ai_artifacts(status, updated_at DESC);

    -- 手动维护的钉钉日志模板（替代旧的“调钉钉接口查全部模板 + 勾选”方案）
    -- name 即钉钉日志接口服务端过滤用的 template_name；enabled=1 才参与同步拉取
    CREATE TABLE IF NOT EXISTS report_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dws_agent_conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_message_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dws_agent_conversations_recent ON dws_agent_conversations(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS dws_agent_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES dws_agent_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL DEFAULT 'text',
      tool_name TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dws_agent_messages_conversation ON dws_agent_messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS dws_agent_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES dws_agent_conversations(id) ON DELETE CASCADE,
      user_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      input_hash TEXT NOT NULL,
      output_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS dws_agent_actions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES dws_agent_runs(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT NOT NULL UNIQUE,
      external_id TEXT,
      result_json TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      executed_at TEXT
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
    "011_ai_scheduler",
    "019_dws_agent",
  ];
  for (const v of versions) {
    if (!applied.has(v)) {
      d.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(
        v,
        new Date().toISOString(),
      );
    }
  }

  // 020：AI Task 失败重试窗口（最多 3 次，指数退避）
  const aiTaskCols = d.prepare("PRAGMA table_info(ai_tasks)").all().map((c) => c.name);
  if (!aiTaskCols.includes("next_attempt_at")) d.exec("ALTER TABLE ai_tasks ADD COLUMN next_attempt_at TEXT");
  if (!aiTaskCols.includes("max_attempts")) d.exec("ALTER TABLE ai_tasks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3");
  if (!aiTaskCols.includes("payload_json")) d.exec("ALTER TABLE ai_tasks ADD COLUMN payload_json TEXT");
  if (!aiTaskCols.includes("input_tokens")) d.exec("ALTER TABLE ai_tasks ADD COLUMN input_tokens INTEGER");
  if (!aiTaskCols.includes("output_tokens")) d.exec("ALTER TABLE ai_tasks ADD COLUMN output_tokens INTEGER");
  if (!aiTaskCols.includes("prompt_version")) d.exec("ALTER TABLE ai_tasks ADD COLUMN prompt_version TEXT");
  const aiArtifactCols = d.prepare("PRAGMA table_info(ai_artifacts)").all().map((item) => item.name);
  if (!aiArtifactCols.includes("prompt_version")) d.exec("ALTER TABLE ai_artifacts ADD COLUMN prompt_version TEXT");

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

  // 012：日程补充参会人数，旧库保留原有会议数据并允许为空。
  const calendarCols = d.prepare("PRAGMA table_info(calendars)").all().map((c) => c.name);
  if (!calendarCols.includes("attendee_count")) d.exec("ALTER TABLE calendars ADD COLUMN attendee_count INTEGER");
  if (!calendarCols.includes("accepted_count")) d.exec("ALTER TABLE calendars ADD COLUMN accepted_count INTEGER");

  // 014：钉钉个人消息补充会话画像与附件元数据。
  // 会话画像用于区分群/单聊（DWS +conversation-list 不返回类型）与降权机器人噪声；
  // 附件只存元数据，真正的文件在用户点击后才经 DWS 下载，避免静默拉取大量二进制。
  const chatConvCols = d.prepare("PRAGMA table_info(dingtalk_chat_conversations)").all().map((c) => c.name);
  if (!chatConvCols.includes("chat_mode")) d.exec("ALTER TABLE dingtalk_chat_conversations ADD COLUMN chat_mode TEXT");
  if (!chatConvCols.includes("is_bot")) d.exec("ALTER TABLE dingtalk_chat_conversations ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0");
  if (!chatConvCols.includes("type_known")) d.exec("ALTER TABLE dingtalk_chat_conversations ADD COLUMN type_known INTEGER NOT NULL DEFAULT 0");
  if (!chatConvCols.includes("last_sync_json")) d.exec("ALTER TABLE dingtalk_chat_conversations ADD COLUMN last_sync_json TEXT");

  const chatMsgCols = d.prepare("PRAGMA table_info(dingtalk_chat_messages)").all().map((c) => c.name);
  if (!chatMsgCols.includes("attachment_count")) d.exec("ALTER TABLE dingtalk_chat_messages ADD COLUMN attachment_count INTEGER NOT NULL DEFAULT 0");
  // 016：群消息根的提及范围。self/@我、all/@所有人、none 三态，兼容旧的 mentioned_me。
  if (!chatMsgCols.includes("mention_scope")) d.exec("ALTER TABLE dingtalk_chat_messages ADD COLUMN mention_scope TEXT NOT NULL DEFAULT 'none'");

  // 015：钉钉消息 AI 行动箱待办草稿。分析时一并生成草稿并落库，避免反复调用 AI；
  // 用户可在右侧编辑后「确认创建待办」（按消息 ID 幂等）。
  const analysisCols = d.prepare("PRAGMA table_info(dingtalk_message_analysis)").all().map((c) => c.name);
  if (!analysisCols.includes("attention_type")) d.exec("ALTER TABLE dingtalk_message_analysis ADD COLUMN attention_type TEXT NOT NULL DEFAULT 'ignore'");
  if (!analysisCols.includes("draft_title")) d.exec("ALTER TABLE dingtalk_message_analysis ADD COLUMN draft_title TEXT");
  if (!analysisCols.includes("draft_note")) d.exec("ALTER TABLE dingtalk_message_analysis ADD COLUMN draft_note TEXT");
  if (!analysisCols.includes("draft_priority")) d.exec("ALTER TABLE dingtalk_message_analysis ADD COLUMN draft_priority TEXT");
  if (!analysisCols.includes("draft_due_date")) d.exec("ALTER TABLE dingtalk_message_analysis ADD COLUMN draft_due_date TEXT");
  if (!analysisCols.includes("draft_rationale")) d.exec("ALTER TABLE dingtalk_message_analysis ADD COLUMN draft_rationale TEXT");
  if (!analysisCols.includes("draft_generated_at")) d.exec("ALTER TABLE dingtalk_message_analysis ADD COLUMN draft_generated_at TEXT");

  d.exec(`
    CREATE TABLE IF NOT EXISTS dingtalk_chat_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES dingtalk_chat_messages(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,
      kind TEXT,
      name TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      ref_json TEXT,
      local_path TEXT,
      downloaded_at TEXT,
      download_error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dt_chat_attachments_message ON dingtalk_chat_attachments(message_id);

    -- 017：钉钉工作信号。消息是证据，信号才是行动中心的稳定实体。
    CREATE TABLE IF NOT EXISTS work_signals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      classification TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'P2',
      confidence INTEGER NOT NULL DEFAULT 0,
      conclusion TEXT,
      facts_json TEXT NOT NULL DEFAULT '[]',
      steps_json TEXT NOT NULL DEFAULT '[]',
      draft_title TEXT,
      draft_note TEXT,
      draft_priority TEXT,
      draft_due_date TEXT,
      draft_rationale TEXT,
      todo_id TEXT,
      ai_meta_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_signals_active ON work_signals(state, priority, updated_at DESC);
    CREATE TABLE IF NOT EXISTS work_signal_evidence (
      id TEXT PRIMARY KEY,
      signal_id TEXT NOT NULL REFERENCES work_signals(id) ON DELETE CASCADE,
      message_id TEXT,
      conversation_id TEXT,
      conversation_title TEXT,
      sender_name TEXT,
      sent_at TEXT,
      mention_scope TEXT NOT NULL DEFAULT 'none',
      excerpt TEXT,
      is_root INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(signal_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_signal_evidence_signal ON work_signal_evidence(signal_id, sent_at);

    CREATE TABLE IF NOT EXISTS management_cases (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'decision_needed', priority TEXT NOT NULL DEFAULT 'P2',
      title TEXT NOT NULL, management_summary TEXT, owner_id TEXT, owner_name TEXT, due_at TEXT, project_id TEXT,
      source_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_management_cases_active ON management_cases(state, priority, due_at, updated_at DESC);
    CREATE TABLE IF NOT EXISTS management_case_evidence (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES management_cases(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL, source_id TEXT NOT NULL, role TEXT NOT NULL, excerpt TEXT, occurred_at TEXT, created_at TEXT NOT NULL,
      UNIQUE(case_id, source_type, source_id)
    );
    CREATE TABLE IF NOT EXISTS management_case_actions (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES management_cases(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, preview_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE, external_id TEXT, result_json TEXT, created_at TEXT NOT NULL, executed_at TEXT
    );
  `);
  // 018: durable task sync state shared by manual creation and DWS Agent.
  const syncColumns = new Set(d.prepare("PRAGMA table_info(todos)").all().map((column) => column.name));
  for (const column of ["external_task_id", "dws_profile", "sync_status", "sync_error", "local_updated_at", "external_updated_at", "last_sync_at", "sync_direction"]) {
    if (!syncColumns.has(column)) d.exec(`ALTER TABLE todos ADD COLUMN ${column} TEXT`);
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
