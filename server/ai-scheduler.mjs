import crypto from "node:crypto";
import { getDb } from "./db.mjs";
import { ai } from "./ai.mjs";
import { buildDashboard } from "./workbench-domain.mjs";

const PRIORITY = {
  "email.classify": 500,
  "dingtalk.message.classify": 450,
  "dashboard.suggestion": 400,
  "team.analysis": 300,
  "report.daily": 200,
  "report.weekly": 200,
  "review.summary": 200,
  "email.draft": 100,
};
const DASHBOARD_ARTIFACT_VERSION = "v2-opencode-text-output";
const DINGTALK_NOISE_PHRASES = new Set([
  "嗯", "嗯嗯", "哦", "哦哦", "啊", "哈哈", "哈哈哈", "好的", "好滴", "收到", "了解", "明白",
  "行", "可以", "没问题", "没事", "谢谢", "感谢", "在吗", "来了", "到了", "ok", "okay", "thanks",
]);

function isDingtalkNoiseMessage(content) {
  const text = String(content || "").trim().toLocaleLowerCase().replace(/[\s，。！？、,.!?~～]+/g, "");
  if (!text) return true;
  if (DINGTALK_NOISE_PHRASES.has(text)) return true;
  // 仅拦截极短、没有数字/链接/任务动词的确认回复，避免误伤正常事项。
  return text.length <= 2 && !/[0-9一二三四五六七八九十]/.test(text);
}

function json(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }

function fallbackSuggestion(summary) {
  const parts = [];
  if (summary.riskProjects > 0) parts.push(`有 ${summary.riskProjects} 个风险项目，优先推进并确认下一步`);
  if (summary.pendingEmails > 0) parts.push(`先处理 ${summary.pendingEmails} 封待处理邮件中的高优先级事项`);
  if (summary.meetingCount > 0) parts.push(`为 ${summary.firstMeetings?.[0]?.time || "稍后"} 的「${summary.firstMeetings?.[0]?.title || "会议"}」预留准备时间`);
  if (summary.blockers > 0) parts.push(`尽快拍板 ${summary.blockers} 个团队卡点`);
  if (summary.openTodos > 0) parts.push(`清理 ${summary.openTodos} 条未完成待办`);
  return parts.length ? `${parts.slice(0, 2).join("；")}。` : "当前日期没有高优先级注意事项，可以安排一段不被打断的专注时间。";
}

function dashboardSummary(db, date) {
  const dashboard = buildDashboard(db, date);
  const risks = dashboard.projects.filter((item) => item.status === "at_risk" || item.status === "overdue");
  const emails = dashboard.attention.filter((item) => item.kind === "email");
  return {
    dashboard,
    summary: {
      date,
      teamMetricDate: dashboard.metrics.team.metricDate || date,
      teamMetricRule: dashboard.metrics.team.ruleLabel || "按所选日期统计",
      riskProjects: risks.length,
      riskNames: risks.map((item) => item.name),
      pendingEmails: emails.length,
      pendingTop: emails.slice(0, 3).map((item) => ({ subject: item.title, sender: item.detail, priority: item.priority })),
      meetingCount: dashboard.meetings.length,
      firstMeetings: dashboard.meetings.slice(0, 2).map((item) => ({ title: item.title, time: item.start })),
      blockers: dashboard.pulse.blockers.length,
      openTodos: dashboard.metrics.todos.open,
    },
    sourceRefs: dashboard.attention.slice(0, 6).map((item) => item.sourceRef),
  };
}

function reportSummary(raw) {
  let text = String(raw || "");
  try { const parsed = JSON.parse(text); text = Array.isArray(parsed) ? parsed.map((item) => item?.value || item?.content || "").join("；") : String(parsed); } catch { /* plain text */ }
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "未提供有效日志内容";
}

function toArtifact(row) {
  if (!row) return null;
  return {
    kind: row.kind, scope: row.scope, inputHash: row.input_hash, status: row.status,
    payload: json(row.payload_json, {}), sourceRefs: json(row.source_refs_json, []),
    aiMeta: json(row.ai_meta_json, null), generatedAt: row.generated_at || null,
    lastAttemptAt: row.last_attempt_at || null, lastError: row.last_error || null,
    updatedAt: row.updated_at,
  };
}

/** Single-process persistent queue. Handlers derive input from local domain records at execution time. */
export function createAiScheduler({ database = getDb, aiService = ai, now = () => new Date() } = {}) {
  let running = false;
  let closed = false;

  function db() { return database(); }
  function read(kind, scope) { return toArtifact(db().prepare("SELECT * FROM ai_artifacts WHERE kind=? AND scope=?").get(kind, scope)); }
  function writeArtifact({ kind, scope, inputHash, status, payload, sourceRefs, aiMeta, generatedAt, lastAttemptAt, lastError }) {
    const stamp = now().toISOString();
    const current = read(kind, scope);
    db().prepare(`INSERT INTO ai_artifacts(kind,scope,input_hash,status,payload_json,source_refs_json,ai_meta_json,generated_at,last_attempt_at,last_error,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,scope) DO UPDATE SET
      input_hash=excluded.input_hash,status=excluded.status,payload_json=excluded.payload_json,source_refs_json=excluded.source_refs_json,
      ai_meta_json=excluded.ai_meta_json,generated_at=excluded.generated_at,last_attempt_at=excluded.last_attempt_at,last_error=excluded.last_error,updated_at=excluded.updated_at`)
      .run(kind, scope, inputHash, status, JSON.stringify(payload ?? current?.payload ?? {}), JSON.stringify(sourceRefs ?? current?.sourceRefs ?? []), JSON.stringify(aiMeta ?? current?.aiMeta ?? null), generatedAt ?? current?.generatedAt ?? null, lastAttemptAt ?? current?.lastAttemptAt ?? null, lastError ?? current?.lastError ?? null, stamp);
    return read(kind, scope);
  }
  function activeTask(kind, scope, inputHash) {
    return db().prepare("SELECT * FROM ai_tasks WHERE kind=? AND scope=? AND input_hash=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(kind, scope, inputHash);
  }
  function enqueue({ kind, scope, inputHash, trigger = "automatic", priority = PRIORITY[kind] || 0, force = false }) {
    const current = read(kind, scope);
    if (!force && current?.inputHash === inputHash && current.status === "ready") return { task: null, artifact: current };
    const active = activeTask(kind, scope, inputHash);
    if (active) return { task: active, artifact: current };
    const task = { id: crypto.randomUUID(), kind, scope, inputHash, priority: force ? priority + 1_000 : priority, trigger, createdAt: now().toISOString() };
    db().prepare("INSERT INTO ai_tasks(id,kind,scope,input_hash,status,priority,trigger,attempts,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(task.id, kind, scope, inputHash, "queued", task.priority, trigger, 0, task.createdAt);
    writeArtifact({ kind, scope, inputHash, status: current?.payload ? "stale" : "queued", payload: current?.payload, sourceRefs: current?.sourceRefs, aiMeta: current?.aiMeta, generatedAt: current?.generatedAt, lastError: null });
    void pump();
    return { task, artifact: read(kind, scope) };
  }
  async function execute(task) {
    if (task.kind === "dingtalk.message.classify") {
      const message = db().prepare(`SELECT m.*,c.title AS conversation_title,c.type AS conversation_type FROM dingtalk_chat_messages m JOIN dingtalk_chat_conversations c ON c.id=m.conversation_id WHERE m.id=?`).get(task.scope);
      if (!message) throw Object.assign(new Error("钉钉消息不存在"), { code: "message_not_found" });
      const context = db().prepare("SELECT sender_name,content,sent_at FROM dingtalk_chat_messages WHERE conversation_id=? ORDER BY ABS(strftime('%s', sent_at)-strftime('%s', ?)) LIMIT 21").all(message.conversation_id, message.sent_at);
      if (isDingtalkNoiseMessage(message.content)) {
        const stamp = now().toISOString();
        db().prepare(`INSERT INTO dingtalk_message_analysis(message_id,classification,summary,action_text,due_date,priority,confidence,assignee_self,ai_meta_json,todo_id,draft_title,draft_note,draft_priority,draft_due_date,draft_rationale,draft_generated_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET classification=excluded.classification,summary=excluded.summary,action_text=excluded.action_text,confidence=excluded.confidence,ai_meta_json=excluded.ai_meta_json,updated_at=excluded.updated_at`)
          .run(message.id, "informational", "低价值确认或寒暄", "无需处理", null, "P2", 99, 0, JSON.stringify({ source: "noise-filter", reason: "short_acknowledgement" }), null, null, null, null, null, null, null, stamp, stamp);
        db().prepare("UPDATE dingtalk_chat_messages SET processing_status='ignored',updated_at=? WHERE id=?").run(stamp, message.id);
        return { payload: { classification: "noise", confidence: 99, todoId: null }, sourceRefs: [`dingtalk_message:${message.id}`], aiMeta: { source: "noise-filter" } };
      }
      const result = await aiService.analyzeDingtalkMessage({ ...message, context });
      const stamp = now().toISOString();
      db().prepare(`INSERT INTO dingtalk_message_analysis(message_id,classification,summary,action_text,due_date,priority,confidence,assignee_self,ai_meta_json,todo_id,draft_title,draft_note,draft_priority,draft_due_date,draft_rationale,draft_generated_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET classification=excluded.classification,summary=excluded.summary,action_text=excluded.action_text,due_date=excluded.due_date,priority=excluded.priority,confidence=excluded.confidence,assignee_self=excluded.assignee_self,ai_meta_json=excluded.ai_meta_json,draft_title=excluded.draft_title,draft_note=excluded.draft_note,draft_priority=excluded.draft_priority,draft_due_date=excluded.draft_due_date,draft_rationale=excluded.draft_rationale,draft_generated_at=excluded.draft_generated_at,updated_at=excluded.updated_at`)
        .run(message.id, result.classification, result.summary, result.actionText, result.dueDate, result.priority, result.confidence, result.assigneeSelf ? 1 : 0, JSON.stringify(result.aiMeta || null), null,
          result.draftTitle || result.actionText || null, result.draftNote || null, result.draftPriority || result.priority || "P2", result.draftDueDate || null, result.draftRationale || null, stamp, stamp, stamp);
      let todoId = null;
      if (result.classification === "action" && result.assigneeSelf && result.confidence >= 90) {
        const existing = db().prepare("SELECT id FROM todos WHERE source_type='dingtalk_message' AND source_id=?").get(message.id);
        if (!existing) {
          todoId = `t${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
          db().prepare("INSERT INTO todos(id,title,note,status,priority,due_date,created_at,completed_at,source_type,source_id,project_id,assignee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(todoId, result.actionText || result.summary, `来自钉钉：${message.sender_name || "成员"} · ${message.content || ""}`.slice(0, 2000), "inbox", result.priority || "P2", result.dueDate || null, stamp, null, "dingtalk_message", message.id, null, null);
        } else todoId = existing.id;
        db().prepare("UPDATE dingtalk_message_analysis SET todo_id=?,updated_at=? WHERE message_id=?").run(todoId, stamp, message.id);
        db().prepare("UPDATE dingtalk_chat_messages SET processing_status='task_created',updated_at=? WHERE id=?").run(stamp, message.id);
      } else {
        db().prepare("UPDATE dingtalk_chat_messages SET processing_status=?,updated_at=? WHERE id=?").run(result.classification === "action" ? "needs_confirmation" : result.classification === "informational" ? "informational" : "needs_confirmation", stamp, message.id);
      }
      const content = String(message.content || "");
      const targets = [
        ["outlook", "emails", "id", "subject"], ["calendar", "calendars", "id", "title"], ["project", "projects", "id", "name"],
      ];
      for (const [targetType, table, idField, textField] of targets) {
        const candidates = db().prepare(`SELECT ${idField} id, ${textField} title FROM ${table} WHERE ${textField} IS NOT NULL AND length(${textField})>=4 LIMIT 100`).all()
          .filter((item) => content.includes(item.title) || item.title.includes(content.slice(0, 40)));
        if (candidates.length === 1) db().prepare(`INSERT INTO work_links(id,source_type,source_id,target_type,target_id,confidence,reason,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_type,source_id,target_type,target_id) DO NOTHING`)
          .run(crypto.randomUUID(), "dingtalk_message", message.id, targetType, String(candidates[0].id), 90, "消息内容与标题唯一匹配", "auto", stamp, stamp);
      }
      return { payload: { classification: result.classification, confidence: result.confidence, todoId }, sourceRefs: [`dingtalk_message:${message.id}`], aiMeta: result.aiMeta || null };
    }
    if (task.kind === "dashboard.suggestion") {
      const context = dashboardSummary(db(), task.scope);
      const result = await aiService.dailySuggestion(context.summary);
      return { inputHash: `${context.dashboard.inputHash}:${DASHBOARD_ARTIFACT_VERSION}`, payload: { text: result.suggestion || fallbackSuggestion(context.summary) }, sourceRefs: context.sourceRefs, aiMeta: result.aiMeta || null };
    }
    if (task.kind === "team.analysis") {
      const reports = db().prepare("SELECT * FROM dingtalk_reports WHERE report_date=? ORDER BY user_name").all(task.scope);
      const result = await aiService.analyzeReports(reports);
      const byMember = new Map((result.members || []).map((member) => [String(member.userId || member.name), member]));
      const update = db().prepare("UPDATE dingtalk_reports SET blockers=?, needs_review=?, summary=? WHERE id=?");
      for (const report of reports) {
        const member = byMember.get(String(report.user_id || report.user_name));
        update.run(JSON.stringify(member?.blockers || []), JSON.stringify(member?.reviewItems || []), member?.summary || reportSummary(report.content_json), report.id);
      }
      return { payload: { teamSummary: result.teamSummary || `已整理 ${reports.length} 份团队日志`, memberCount: reports.length }, sourceRefs: reports.map((report) => `report:${report.id}`), aiMeta: result.aiMeta || null };
    }
    throw Object.assign(new Error(`未注册的 AI 任务：${task.kind}`), { code: "unsupported_task" });
  }
  async function pump() {
    if (running || closed) return;
    const task = db().prepare("SELECT * FROM ai_tasks WHERE status='queued' ORDER BY priority DESC, created_at ASC LIMIT 1").get();
    if (!task) return;
    running = true;
    const startedAt = now().toISOString();
    db().prepare("UPDATE ai_tasks SET status='running', attempts=attempts+1, started_at=? WHERE id=?").run(startedAt, task.id);
    const current = read(task.kind, task.scope);
    writeArtifact({ kind: task.kind, scope: task.scope, inputHash: task.input_hash, status: current?.payload ? "stale" : "running", payload: current?.payload, sourceRefs: current?.sourceRefs, aiMeta: current?.aiMeta, generatedAt: current?.generatedAt, lastAttemptAt: startedAt, lastError: null });
    try {
      const output = await execute(task);
      writeArtifact({ kind: task.kind, scope: task.scope, inputHash: output.inputHash || task.input_hash, status: "ready", ...output, generatedAt: now().toISOString(), lastAttemptAt: startedAt, lastError: null });
      db().prepare("UPDATE ai_tasks SET status='ready', finished_at=?, last_error=NULL WHERE id=?").run(now().toISOString(), task.id);
    } catch (error) {
      const retained = read(task.kind, task.scope);
      writeArtifact({ kind: task.kind, scope: task.scope, inputHash: task.input_hash, status: retained?.payload ? "stale" : "failed", payload: retained?.payload, sourceRefs: retained?.sourceRefs, aiMeta: retained?.aiMeta, generatedAt: retained?.generatedAt, lastAttemptAt: startedAt, lastError: error?.code || error?.message || "generation_failed" });
      db().prepare("UPDATE ai_tasks SET status='failed', finished_at=?, last_error=? WHERE id=?").run(now().toISOString(), error?.code || error?.message || "generation_failed", task.id);
    } finally { running = false; queueMicrotask(() => void pump()); }
  }
  function dashboardArtifact(date, { force = false, trigger = "view" } = {}) {
    const context = dashboardSummary(db(), date);
    const current = read("dashboard.suggestion", date);
    // 适配器规则变化时，旧缓存不能永久遮蔽新路由；版本串入去重键只触发一次迁移。
    const inputHash = `${context.dashboard.inputHash}:${DASHBOARD_ARTIFACT_VERSION}`;
    const same = current?.inputHash === inputHash;
    if (!same || force || current?.status === "failed") enqueue({ kind: "dashboard.suggestion", scope: date, inputHash, trigger, force });
    const artifact = read("dashboard.suggestion", date);
    const text = artifact?.payload?.text || fallbackSuggestion(context.summary);
    return { ...artifact, kind: "dashboard.suggestion", scope: date, inputHash, status: artifact?.status || "queued", payload: { text }, sourceRefs: artifact?.sourceRefs?.length ? artifact.sourceRefs : context.sourceRefs, ruleFallback: !artifact?.payload?.text };
  }
  function teamAnalysisArtifact(date, { trigger = "sync" } = {}) {
    const reports = db().prepare("SELECT id, user_id, content_json FROM dingtalk_reports WHERE report_date=? ORDER BY id").all(date);
    const inputHash = crypto.createHash("sha256").update(JSON.stringify(reports)).digest("hex");
    if (reports.length) enqueue({ kind: "team.analysis", scope: date, inputHash, trigger });
    return read("team.analysis", date);
  }
  function dingtalkChatMessagesArtifact(ids, { trigger = "sync" } = {}) {
    for (const id of ids || []) {
      const message = db().prepare(`SELECT m.id,m.content,m.sent_at,m.direction,m.mentioned_me,m.context_only,c.type FROM dingtalk_chat_messages m JOIN dingtalk_chat_conversations c ON c.id=m.conversation_id WHERE m.id=?`).get(id);
      if (!message || message.direction !== "inbound" || message.context_only || (message.type === "group" && !message.mentioned_me)) continue;
      const inputHash = crypto.createHash("sha256").update(JSON.stringify([message.id, message.content, message.sent_at])).digest("hex");
      enqueue({ kind: "dingtalk.message.classify", scope: message.id, inputHash, trigger });
    }
  }
  function stats() {
    const rows = db().prepare("SELECT status, COUNT(*) count FROM ai_tasks GROUP BY status").all();
    const byStatus = Object.fromEntries(rows.map((row) => [row.status, row.count]));
    const completed = db().prepare("SELECT started_at, finished_at, last_error FROM ai_tasks WHERE status='ready' AND started_at IS NOT NULL AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 30").all();
    const samples = completed.map((row) => Date.parse(row.finished_at) - Date.parse(row.started_at)).filter((value) => Number.isFinite(value));
    const recentFailure = db().prepare("SELECT kind, scope, last_error, finished_at FROM ai_tasks WHERE status='failed' ORDER BY finished_at DESC LIMIT 1").get();
    const recentSuccess = db().prepare("SELECT kind, scope, finished_at FROM ai_tasks WHERE status='ready' ORDER BY finished_at DESC LIMIT 1").get();
    return { queued: byStatus.queued || 0, running: byStatus.running || 0, failed: byStatus.failed || 0, ready: byStatus.ready || 0, averageDurationMs: samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : null, recentFailure: recentFailure || null, recentSuccess: recentSuccess || null };
  }
  function start() {
    // Running tasks were interrupted by a prior process; retry them after restart.
    db().prepare("UPDATE ai_tasks SET status='queued', started_at=NULL WHERE status='running'").run();
    void pump();
  }
  return { start, close() { closed = true; }, read, enqueue, dashboardArtifact, teamAnalysisArtifact, dingtalkChatMessagesArtifact, stats, priority: PRIORITY, aiService };
}
