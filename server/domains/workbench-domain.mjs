import { createHash } from "node:crypto";
import { localTimeString, teamMetricDate } from "../core/local-date.mjs";
import { getRosterBaseline } from "../db.mjs";
import { enrichProject } from "./project-status.mjs";

function safeJson(value, fallback = []) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function enrichCalendarMeeting(meeting) {
  if (meeting.location || !meeting.raw_json) return meeting;
  const raw = safeJson(meeting.raw_json, null);
  if (!raw) return meeting;
  const location = raw.location;
  const direct = typeof location === "string"
    ? location
    : location?.displayName || location?.name || location?.address || location?.locationName || location?.placeName || location?.place || "";
  const rooms = raw.meetingRooms || raw.meeting_rooms;
  const room = Array.isArray(rooms) ? rooms.find(Boolean) : rooms;
  const roomLabel = typeof room === "string" ? room : room?.displayName || room?.name || room?.roomName || room?.locationName || "";
  return { ...meeting, location: direct || roomLabel };
}

function priorityRank(priority) {
  return { P0: 0, high: 0, P1: 1, medium: 1, P2: 2, low: 2 }[priority] ?? 3;
}

export function buildTeamPulse(db, date, now = new Date()) {
  const rows = db.prepare("SELECT * FROM dingtalk_reports WHERE report_date=? ORDER BY user_name").all(date);
  const byUser = new Map();
  for (const row of rows) {
    const key = row.user_id || row.user_name;
    if (!key) continue;
    if (!byUser.has(key)) {
      byUser.set(key, {
        user_id: key,
        name: row.user_name || key,
        dept_name: row.dept_name || "",
        submitted: true,
        reportCount: 0,
        blockers: [],
        review: [],
      });
    }
    const member = byUser.get(key);
    member.reportCount += 1;
    member.blockers.push(...safeJson(row.blockers));
    member.review.push(...safeJson(row.needs_review));
  }

  const roster = getRosterBaseline(db);
  const submissionWindowOpen = teamMetricDate(date, now).isFallbackDate;
  const rosterKeys = new Set(roster.map((member) => member.key));
  for (const member of roster) {
    if (byUser.has(member.key)) continue;
    byUser.set(member.key, {
      user_id: member.key,
      name: member.name,
      dept_name: member.dept_name || "",
      submitted: false,
      reportCount: 0,
      blockers: [],
      review: [],
    });
  }
  for (const [key, member] of byUser) {
    if (!rosterKeys.has(key)) rosterKeys.add(key);
    member.submissionState = member.submitted ? "submitted" : submissionWindowOpen ? "pending" : "missing";
    member.signalScore = member.blockers.length * 2 + member.review.length + (member.submissionState === "missing" ? 3 : 0);
  }

  const members = [...byUser.values()].sort(
    (a, b) => b.signalScore - a.signalScore || Number(a.submitted) - Number(b.submitted) || a.name.localeCompare(b.name),
  );
  const submittedUnique = members.filter((member) => member.submitted).length;
  const missing = members.filter((member) => !member.submitted);
  const blockers = members.flatMap((member) => member.blockers.map((text) => ({ memberId: member.user_id, memberName: member.name, text })));
  const reviewRequests = members.flatMap((member) => member.review.map((text) => ({ memberId: member.user_id, memberName: member.name, text })));
  const rosterTotal = members.length;

  return {
    date,
    rosterTotal,
    submittedUnique,
    submissionRate: rosterTotal ? Math.round((submittedUnique / rosterTotal) * 100) : null,
    missing,
    missingStatus: submissionWindowOpen ? "pending" : "missing",
    analysisStatus: submittedUnique ? "available" : "no_reports",
    blockers,
    reviewRequests,
    members,
    summary: {
      total: rosterTotal,
      submitted: submittedUnique,
      notSubmitted: missing.length,
      risk: members.filter((member) => member.blockers.length > 0).length,
      needsReview: members.filter((member) => member.review.length > 0).length,
      attention: members.filter((member) => member.signalScore > 0).length,
    },
  };
}

export function buildAttentionItems(db, date) {
  const items = [];
  const todos = db.prepare("SELECT * FROM todos WHERE status!='done' AND (due_date IS NULL OR due_date='' OR due_date<=?)").all(date);
  for (const todo of todos) {
    const overdue = todo.due_date && todo.due_date < date;
    items.push({
      id: `todo:${todo.id}`,
      kind: "todo",
      sourceRef: todo.source_type && todo.source_id ? `${todo.source_type}:${todo.source_id}` : `todo:${todo.id}`,
      title: todo.title,
      detail: todo.note || "",
      priority: overdue && todo.priority !== "P0" ? "P0" : todo.priority || "P1",
      status: "open",
      dueAt: todo.due_date,
      recommendedAction: overdue ? "优先完成逾期待办" : "推进待办",
      projectId: todo.project_id || null,
    });
  }

  const emails = db.prepare(
    "SELECT id, subject, sender, action, priority, importance, due_at, priority_reason FROM emails " +
      "WHERE needs_action=1 AND source='outlook' ORDER BY received_at DESC LIMIT 20",
  ).all();
  for (const email of emails) {
    const priority = email.importance === "high" || email.priority === "high" ? "P0" : email.priority === "low" ? "P2" : "P1";
    items.push({
      id: `email:${email.id}`,
      kind: "email",
      sourceRef: `outlook:${email.id}`,
      title: email.subject,
      detail: [email.sender, email.priority_reason].filter(Boolean).join(" · "),
      priority,
      status: "open",
      dueAt: email.due_at ? String(email.due_at).slice(0, 10) : null,
      recommendedAction: email.action || "处理邮件",
      projectId: null,
    });
  }

  const pulse = buildTeamPulse(db, date);
  for (const blocker of pulse.blockers) {
    items.push({
      id: `blocker:${blocker.memberId}:${blocker.text}`,
      kind: "blocker",
      sourceRef: `dingtalk:${blocker.memberId}:${date}`,
      title: blocker.text,
      detail: blocker.memberName,
      priority: "P0",
      status: "open",
      dueAt: date,
      recommendedAction: "与成员确认解决路径",
      projectId: null,
    });
  }
  for (const request of pulse.reviewRequests) {
    items.push({
      id: `review:${request.memberId}:${request.text}`,
      kind: "review",
      sourceRef: `dingtalk:${request.memberId}:${date}`,
      title: request.text,
      detail: request.memberName,
      priority: "P1",
      status: "open",
      dueAt: date,
      recommendedAction: "完成主管审核",
      projectId: null,
    });
  }

  const projects = db.prepare("SELECT * FROM projects").all();
  const phases = db.prepare("SELECT * FROM project_phases").all();
  const phasesByProject = new Map();
  for (const phase of phases) {
    if (!phasesByProject.has(phase.project_id)) phasesByProject.set(phase.project_id, []);
    phasesByProject.get(phase.project_id).push(phase);
  }
  for (const project of projects.map((item) => enrichProject(item, phasesByProject.get(item.id) || [], date))) {
    if (project.status !== "at_risk" && project.status !== "overdue") continue;
    items.push({
      id: `project:${project.id}`,
      kind: "project",
      sourceRef: `project:${project.id}`,
      title: project.name,
      detail: `${project.owner || "未设置负责人"} · 进度 ${project.progress}%`,
      priority: project.status === "overdue" ? "P0" : "P1",
      status: "open",
      dueAt: null,
      recommendedAction: project.status === "overdue" ? "处理项目逾期" : "确认风险缓解方案",
      projectId: project.id,
    });
  }

  return items.sort((a, b) => {
    const priority = priorityRank(a.priority) - priorityRank(b.priority);
    if (priority) return priority;
    const aDue = a.dueAt || "9999-12-31";
    const bDue = b.dueAt || "9999-12-31";
    return aDue.localeCompare(bDue);
  });
}

export function buildDashboard(db, date, now = new Date()) {
  const pulse = buildTeamPulse(db, date, now);
  const teamRule = teamMetricDate(date, now);
  const metricPulse = teamRule.date === date ? pulse : buildTeamPulse(db, teamRule.date, now);
  const attention = buildAttentionItems(db, date);
  const projects = db.prepare("SELECT * FROM projects").all();
  const phases = db.prepare("SELECT * FROM project_phases").all();
  const phasesByProject = new Map();
  for (const phase of phases) {
    if (!phasesByProject.has(phase.project_id)) phasesByProject.set(phase.project_id, []);
    phasesByProject.get(phase.project_id).push(phase);
  }
  const enrichedProjects = projects.map((project) => enrichProject(project, phasesByProject.get(project.id) || [], date));
  const meetings = db.prepare("SELECT * FROM calendars WHERE day=? ORDER BY start_at").all(date).map(enrichCalendarMeeting);
  const todos = db.prepare(`
    SELECT * FROM todos
    WHERE status != 'done'
       OR (status = 'done' AND due_date IS NOT NULL AND due_date != '' AND due_date >= ?)
  `).all(date);
  const latest = db.prepare("SELECT MAX(report_date) AS date FROM dingtalk_reports").get()?.date || null;
  const projectRisk = enrichedProjects.filter((project) => project.status === "at_risk" || project.status === "overdue");
  const openTodos = todos.filter((todo) => todo.status !== "done");
  const doneTodos = todos.length - openTodos.length;

  return {
    date,
    hasData: Boolean(meetings.length || pulse.submittedUnique || attention.length),
    availableDateHint: latest && latest !== date ? latest : null,
    metrics: {
      projects: {
        total: enrichedProjects.length,
        healthy: enrichedProjects.filter((project) => project.status === "normal" || project.status === "done").length,
        risk: projectRisk.length,
      },
      email: {
        open: attention.filter((item) => item.kind === "email").length,
        p0: attention.filter((item) => item.kind === "email" && item.priority === "P0").length,
      },
      team: {
        rosterTotal: metricPulse.rosterTotal,
        submitted: metricPulse.submittedUnique,
        missing: metricPulse.missing.length,
        missingStatus: metricPulse.missingStatus,
        rate: metricPulse.submissionRate,
        metricDate: teamRule.date,
        isFallbackDate: teamRule.isFallbackDate,
        ruleLabel: teamRule.ruleLabel,
      },
      todos: {
        total: todos.length,
        open: openTodos.length,
        done: doneTodos,
        rate: todos.length ? Math.round((doneTodos / todos.length) * 100) : null,
      },
    },
    meetings: meetings.map((meeting) => ({
      ...meeting,
      start: localTimeString(meeting.start_at),
      end: localTimeString(meeting.end_at),
    })),
    attention,
    pulse,
    projects: enrichedProjects,
    inputHash: createHash("sha256").update(JSON.stringify({ date, attention, pulse: pulse.summary, meetings })).digest("hex").slice(0, 16),
  };
}
