import express from "express";
import { config, configured } from "../config.mjs";
import { dingtalk } from "../integrations/dingtalk.mjs";
import { getDb } from "../db.mjs";
import { resolveDateKey } from "../core/local-date.mjs";
import { buildDashboard } from "../domains/workbench-domain.mjs";

export default function systemRouter(aiScheduler) {
const router = express.Router();

function fmt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

router.get("/system", (req, res) => {
  const aiRouting = aiScheduler.aiService.statusSnapshot?.() || null;
  res.json({
    configured: configured(),
    useDemoData: config.useDemoData,
    aiProvider: aiScheduler.aiService.label(),
    aiRouting,
    aiRoutingChecking: !aiRouting,
    aiQueue: aiScheduler.stats(),
    publicBaseUrl: config.publicBaseUrl,
    displayName: config.displayName,
    appVersion: config.appVersion,
    runtimeMode: config.runtimeMode,
    dataDirectory: config.dataDir,
    configPath: config.configPath,
  });
});

router.post("/system/ai/refresh", async (req, res) => {
  try { res.json(await aiScheduler.aiService.status({ refresh: true })); }
  catch (error) { res.status(500).json({ error: error?.message || "AI 来源检测失败" }); }
});

router.get("/overview", (req, res) => {
  try {
    const dashboard = buildDashboard(getDb(), resolveDateKey(req.query.date));
    res.json({
      date: dashboard.date,
      pendingEmails: dashboard.attention.filter((item) => item.kind === "email"),
      meetings: dashboard.meetings,
      teamBlockers: dashboard.pulse.blockers.map((item) => item.text),
      needReview: dashboard.pulse.reviewRequests.map((item) => item.text),
      notSubmitted: dashboard.pulse.missing.map((item) => item.name),
      openTodos: dashboard.metrics.todos.open,
      riskProjects: dashboard.projects.filter((item) => item.status === "at_risk" || item.status === "overdue"),
      availableDateHint: dashboard.availableDateHint,
    });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// 首屏不等待模型：返回已有 AI 产物，或确定性的即时规则，同时确保后台任务已入队。
router.get("/overview/suggestion", (req, res) => {
  let date;
  try { date = resolveDateKey(req.query.date); } catch (error) { return res.status(400).json({ error: error.message }); }
  const artifact = aiScheduler.dashboardArtifact(date, { force: req.query.force === "1", trigger: req.query.force === "1" ? "manual" : "view" });
  res.json({
    suggestion: artifact.payload.text, artifact, cached: artifact.status === "ready", date,
    inputHash: artifact.inputHash, sourceRefs: artifact.sourceRefs, generatedAt: artifact.generatedAt, aiMeta: artifact.aiMeta || null,
  });
});

router.get("/ai/artifacts", (req, res) => {
  const { kind, scope } = req.query;
  if (!kind || !scope) return res.status(400).json({ error: "kind 和 scope 为必填项" });
  const artifact = kind === "dashboard.suggestion" ? aiScheduler.dashboardArtifact(scope) : aiScheduler.read(kind, scope);
  res.json({ artifact });
});

router.post("/ai/artifacts/:kind/:scope/regenerate", (req, res) => {
  const { kind, scope } = req.params;
  if (kind !== "dashboard.suggestion") return res.status(400).json({ error: "该内容暂不支持后台重新生成" });
  const artifact = aiScheduler.dashboardArtifact(scope, { force: true, trigger: "manual" });
  res.status(202).json({ artifact, taskId: null });
});

return router;
}
