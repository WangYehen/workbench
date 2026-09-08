import express from "express";

export default function managementRouter(service, dwsClient) {
  const router = express.Router();
  const date = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : new Date().toISOString().slice(0, 10);
  router.get("/dashboard", (req, res) => { try { res.json(service.dashboard(date(req.query.date))); } catch (error) { res.status(400).json({ error: error.message }); } });
  router.get("/cases", (req, res) => { try { service.refresh(date(req.query.date)); res.json({ items: service.list(req.query) }); } catch (error) { res.status(400).json({ error: error.message }); } });
  router.get("/cases/:id", (req, res) => { const item = service.detail(req.params.id); if (!item) return res.status(404).json({ error: "未找到管理事项" }); return res.json({ item }); });
  router.patch("/cases/:id", (req, res) => { try { const item = service.update(req.params.id, req.body || {}); if (!item) return res.status(404).json({ error: "未找到管理事项" }); return res.json({ item }); } catch (error) { return res.status(400).json({ error: error.message }); } });
  router.post("/cases/:id/actions/preview", (req, res) => { const item = service.detail(req.params.id); if (!item) return res.status(404).json({ error: "未找到管理事项" }); const action = req.body || {}; if (!action.type) return res.status(400).json({ error: "缺少动作类型" }); const preview = dwsClient.preview(action.type, { caseId: item.id, ...action }); const audit = service.recordActionPreview(item.id, preview, action.type); return res.json({ preview, audit, case: item }); });
  router.post("/cases/:id/actions/execute", async (req, res) => {
    const item = service.detail(req.params.id); if (!item) return res.status(404).json({ error: "未找到管理事项" });
    try {
      const action = req.body || {}; const result = await dwsClient.executeConfirmed(action.type, {}, action);
      const idempotencyKey = action.idempotencyKey;
      service.recordActionResult(idempotencyKey, { status: "not_enabled", result });
      return res.status(501).json({ error: result.message, code: "DWS_CONNECTOR_NOT_ENABLED", idempotencyKey });
    } catch (error) {
      if (req.body?.idempotencyKey) service.recordActionResult(req.body.idempotencyKey, { status: "rejected", result: { code: error.code, message: error.message } });
      return res.status(400).json({ error: error.message, code: error.code });
    }
  });
  return router;
}
