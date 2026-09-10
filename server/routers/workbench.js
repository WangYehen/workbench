import express from "express";
import { getDb } from "../db.mjs";
import { config } from "../config.mjs";
import { resolveDateKey } from "../core/local-date.mjs";
import { buildAttentionItems, buildDashboard, buildTeamDashboard, buildTeamPulse } from "../domains/workbench-domain.mjs";

export default function workbenchRouter(syncCoordinator, aiScheduler = null) {
  const router = express.Router();

  router.get("/dashboard", (req, res) => {
    try {
      const date = resolveDateKey(req.query.date);
      const db = getDb();
      res.json({ ...buildDashboard(db, date), freshness: syncCoordinator.statusSnapshot(), displayName: config.displayName });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.get("/team/dashboard", (req, res) => {
    try {
      const dashboard = buildTeamDashboard(getDb(), resolveDateKey(req.query.date));
      if (dashboard.date && dashboard.analysisStatus !== "no_reports") aiScheduler?.teamAnalysisArtifact(dashboard.date, { trigger: "view:team-dashboard" });
      res.json({ ...dashboard, freshness: syncCoordinator.statusSnapshot() });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.get("/attention", (req, res) => {
    try {
      const date = resolveDateKey(req.query.date);
      let items = buildAttentionItems(getDb(), date);
      if (req.query.kind) items = items.filter((item) => item.kind === req.query.kind);
      if (req.query.status) items = items.filter((item) => item.status === req.query.status);
      res.json({ date, items });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.get("/team/pulse", (req, res) => {
    try { res.json(buildTeamPulse(getDb(), resolveDateKey(req.query.date))); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.get("/sync/status", (req, res) => res.json({ items: syncCoordinator.statusSnapshot() }));

  router.post("/sync/run", async (req, res) => {
    let date;
    try { date = resolveDateKey(req.body?.date); } catch (error) { return res.status(400).json({ error: error.message }); }
    const requested = Array.isArray(req.body?.sources) && req.body.sources.length
      ? req.body.sources
      : ["outlook", "dingtalk", "calendar", "dingtalk_chat"];
    const allowed = new Set(["outlook", "dingtalk", "calendar", "dingtalk_chat"]);
    const sources = [...new Set(requested)].filter((source) => allowed.has(source));
    const dingtalkChatDays = Number(req.body?.dingtalkChatDays);
    const results = await syncCoordinator.run(sources, { date, trigger: "manual", ...(Number.isFinite(dingtalkChatDays) && dingtalkChatDays > 0 ? { dingtalkChatDays, dingtalkChatBackfill: true } : {}) });
    res.status(results.some((item) => item.status === "success" || item.status === "running") ? 200 : 502).json({ date, results });
  });

  return router;
}
