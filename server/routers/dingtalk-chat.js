import express from "express";

function respond(res, fn, status = 200) {
  Promise.resolve().then(fn).then((body) => res.status(status).json(body)).catch((error) => {
    res.status(error?.code === "NOT_FOUND" ? 404 : 400).json({ error: error?.message || "钉钉消息操作失败", code: error?.code || null });
  });
}

export default function dingtalkChatRouter(service) {
  const router = express.Router();
  router.get("/status", (req, res) => respond(res, async () => {
    if (req.query.refresh === "1") return service.status({ force: true });
    return service.statusSnapshot();
  }));
  router.post("/auth/start", (req, res) => respond(res, () => ({ attempt: service.startLogin() }), 202));
  router.get("/auth/:attemptId", (req, res) => {
    const attempt = service.loginStatus(req.params.attemptId);
    if (!attempt) return res.status(404).json({ error: "未找到登录任务" });
    return res.json({ attempt });
  });
  router.get("/settings", (req, res) => res.json({ settings: service.settings() }));
  router.patch("/settings", (req, res) => respond(res, () => ({ settings: service.updateSettings(req.body || {}) })));
  router.get("/conversations", (req, res) => {
    const result = service.listConversations({ q: req.query.q, scope: req.query.scope, limit: req.query.limit, offset: req.query.offset });
    res.json(result);
  });
  router.patch("/conversations/:id", (req, res) => respond(res, () => ({ item: service.setConversation(req.params.id, req.body || {}) })));
  router.get("/messages", (req, res) => {
    const includeBots = req.query.includeBots !== "false";
    const filters = {
      conversationId: req.query.conversationId || undefined,
      status: req.query.status || undefined,
      q: req.query.q || undefined,
      limit: req.query.limit,
      offset: req.query.offset,
      includeBots,
    };
    const items = service.listMessages(filters);
    const counts = service.countByStatus({ conversationId: filters.conversationId, includeBots });
    return res.json({ items, counts });
  });
  router.get("/messages/:id", (req, res) => {
    const item = service.message(req.params.id);
    if (!item) return res.status(404).json({ error: "未找到消息" });
    return res.json({ item });
  });
  router.patch("/messages/:id", (req, res) => respond(res, () => ({ item: service.setMessageStatus(req.params.id, req.body?.processingStatus || "processed") })));
  router.post("/messages/:id/task", (req, res) => respond(res, () => ({ todo: service.createTodo(req.params.id) })));
  router.post("/messages/:id/draft", (req, res) => respond(res, async () => {
    const result = await service.generateTodoDraft(req.params.id);
    return { item: result.item, cached: result.cached };
  }));
  router.post("/messages/:id/draft/confirm", (req, res) => respond(res, () => {
    const result = service.confirmTodoDraft(req.params.id, req.body || {});
    return { item: result.item, todo: result.todo, created: result.created };
  }));
  router.post("/messages/:id/attachments/:attachmentId/download", (req, res) => respond(res, () => ({ attachment: service.downloadAttachment(req.params.id, req.params.attachmentId) })));
  router.post("/links/:id/confirm", (req, res) => respond(res, () => ({ item: service.setLink(req.params.id, "confirmed") })));
  router.post("/links/:id/reject", (req, res) => respond(res, () => ({ item: service.setLink(req.params.id, "rejected") })));
  return router;
}
