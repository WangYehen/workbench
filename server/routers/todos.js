import express from "express";
import { getDb } from "../db.mjs";
import { dwsClient } from "../integrations/dws-client.mjs";
import { createTodoSyncService } from "../domains/todo-sync.mjs";

export function createTodosRouter({ database = getDb, client = dwsClient } = {}) {
const router = express.Router();
const sync = createTodoSyncService({ database, dwsClient: client });

router.get("/", (req, res) => {
  const db = database();
  const rows = db.prepare("SELECT * FROM todos ORDER BY status, priority, due_date").all();
  res.json({ items: rows });
});

router.post("/", async (req, res) => {
  try {
    const key = req.body.requestId;
    if (key && !/^[\w-]{8,80}$/.test(key)) return res.status(400).json({ error: "请求标识无效" });
    const result = await sync.create(req.body, key ? { id: `manual_${key}` } : {});
    res.json({ ok: true, id: result.todo.id, ...result });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post("/:id/verify", async (req, res) => {
  const todo = database().prepare("SELECT * FROM todos WHERE id=?").get(req.params.id);
  if (!todo?.external_task_id) return res.status(400).json({ error: "尚无可回读的钉钉待办 ID，请先在钉钉核对创建结果。" });
  res.json(await sync.verify(todo.id));
});

router.patch("/:id", async (req, res) => {
  const db = database();
  const { status, title, note, priority, due_date, project_id, assignee_id } = req.body;
  const existing = db.prepare("SELECT * FROM todos WHERE id=?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "未找到" });
  const completed_at = status === "done" && existing.status !== "done" ? new Date().toISOString() : existing.completed_at;
  if (status === "done" || (status === "inbox" && existing.status === "done")) {
    const result = await sync.syncFromWorkbench(req.params.id, { status });
    db.prepare("UPDATE todos SET title=COALESCE(?,title), note=COALESCE(?,note), priority=COALESCE(?,priority), due_date=COALESCE(?,due_date), project_id=COALESCE(?,project_id), assignee_id=COALESCE(?,assignee_id) WHERE id=?")
      .run(title, note, priority, due_date, project_id, assignee_id, req.params.id);
    return res.json({ ok: true, ...result });
  }
  db.prepare("UPDATE todos SET title=COALESCE(?,title), note=COALESCE(?,note), priority=COALESCE(?,priority), due_date=COALESCE(?,due_date), project_id=COALESCE(?,project_id), assignee_id=COALESCE(?,assignee_id), local_updated_at=? WHERE id=?")
    .run(title, note, priority, due_date, project_id, assignee_id, new Date().toISOString(), req.params.id);
  res.json({ ok: true, todo: database().prepare("SELECT * FROM todos WHERE id=?").get(req.params.id) });
});

router.delete("/:id", (req, res) => {
  const db = database();
  db.prepare("DELETE FROM todos WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

return router;
}
export default createTodosRouter();
