import express from "express";

export default function dwsAgentRouter(service) {
  const router = express.Router();
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  router.get("/conversations", (req, res) => res.json({ items: service.listConversations() }));
  router.post("/conversations", (req, res) => res.status(201).json({ conversation: service.createConversation(req.body?.title) }));
  router.patch("/conversations/:id", (req, res) => { const conversation = service.rename(req.params.id, req.body?.title); return conversation ? res.json({ conversation }) : res.status(404).json({ error: "未找到对话" }); });
  router.post("/conversations/:id/archive", (req, res) => { const conversation = service.archive(req.params.id); return conversation ? res.json({ conversation }) : res.status(404).json({ error: "未找到对话" }); });
  router.get("/conversations/:id/messages", (req, res) => { if (!service.conversation(req.params.id)) return res.status(404).json({ error: "未找到对话" }); return res.json({ items: service.messages(req.params.id) }); });
  router.post("/conversations/:id/turns", async (req, res) => {
    if (!service.conversation(req.params.id)) return res.status(404).json({ error: "未找到对话" });
    if (!String(req.body?.content || "").trim()) return res.status(400).json({ error: "消息不能为空" });
    res.status(200); res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }); res.flushHeaders?.();
    try { await service.runTurn(req.params.id, req.body.content, (event, data) => send(res, event, data)); } catch (error) { send(res, "error", { code: error.code || "DWS_AGENT_FAILED", message: error.message }); }
    res.end();
  });
  router.post("/conversations/:id/confirm", async (req, res) => { try { res.json(await service.confirm(req.body?.runId, req.body?.previewId, req.body?.idempotencyKey, req.params.id)); } catch (error) { res.status(400).json({ error: error.message, code: error.code }); } });
  router.get("/runs/:id", (req, res) => { const run = service.run(req.params.id); return run ? res.json({ run }) : res.status(404).json({ error: "未找到运行记录" }); });
  router.get("/status", (req, res) => res.json({ ready: true, mode: "local-agent" }));
  return router;
}
