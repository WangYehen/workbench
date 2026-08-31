import express from "express";
import { getDb } from "../db.mjs";
import { config } from "../config.mjs";
import { resolveDateKey } from "../local-date.mjs";
import { buildAttentionItems, buildDashboard, buildTeamPulse } from "../workbench-domain.mjs";

export default function workbenchRouter(syncCoordinator) {
  const router = express.Router();

  router.get("/dashboard", async (req, res) => {
    try {
      const date = resolveDateKey(req.query.date);
      const db = getDb();
      res.json({ ...buildDashboard(db, date), freshness: await syncCoordinator.status(), displayName: config.displayName });
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

  router.get("/sync/status", async (req, res) => res.json({ items: await syncCoordinator.status() }));

  router.post("/sync/run", async (req, res) => {
    let date;
    try { date = resolveDateKey(req.body?.date); } catch (error) { return res.status(400).json({ error: error.message }); }
    const requested = Array.isArray(req.body?.sources) && req.body.sources.length
      ? req.body.sources
      : ["outlook", "dingtalk", "calendar", "dingtalk_chat"];
    const allowed = new Set(["outlook", "dingtalk", "calendar", "dingtalk_chat"]);
    const sources = [...new Set(requested)].filter((source) => allowed.has(source));
    const results = await syncCoordinator.run(sources, { date, trigger: "manual" });
    res.status(results.some((item) => item.status === "success" || item.status === "running") ? 200 : 502).json({ date, results });
  });

  return router;
}
