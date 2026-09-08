import express from "express";

export default function dwsRouter(client) {
  const router = express.Router();
  router.get("/status", async (req, res) => { try { res.json(await client.status({ force: req.query.refresh === "1" })); } catch (error) { res.status(503).json({ error: error.message, code: error.code }); } });
  router.get("/capabilities", async (req, res) => { try { res.json(await client.capabilities({ force: req.query.refresh === "1" })); } catch (error) { res.status(503).json({ error: error.message, code: error.code }); } });
  router.post("/sync/:source", (req, res) => res.status(501).json({ error: `DWS ${req.params.source} 同步连接器尚未启用。`, code: "DWS_CONNECTOR_NOT_ENABLED" }));
  return router;
}
