import express from "express";

export default function meetingsRouter(service) {
  const router = express.Router();
  const respond = (res, fn, status = 200) => Promise.resolve().then(fn).then((body) => res.status(status).json(body)).catch((error) => res.status(error.code === "NOT_FOUND" ? 404 : 400).json({ error: error.message, code: error.code || null }));
  router.get("/", (req, res) => respond(res, () => ({ items: service.list(req.query.view || "pending") })));
  router.get("/:id", (req, res) => { const item = service.detail(req.params.id); return item ? res.json({ item }) : res.status(404).json({ error: "未找到会议" }); });
  router.post("/sync", (req, res) => respond(res, () => service.syncRecent()));
  router.post("/import", (req, res) => respond(res, () => service.importMeeting(req.body?.reference)));
  router.get("/search/:query", (req, res) => respond(res, () => service.search(req.params.query)));
  router.patch("/items/:id", (req, res) => respond(res, () => ({ item: service.patchItem(req.params.id, req.body || {}) })));
  router.post("/:id/preview", (req, res) => respond(res, () => service.previewCreate(req.params.id, req.body?.itemIds || [])));
  router.post("/:id/confirm", (req, res) => respond(res, () => service.confirmCreate(req.params.id, req.body || {})));
  return router;
}
