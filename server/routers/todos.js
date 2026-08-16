import express from "express";
import { getDb } from "../db.mjs";

const router = express.Router();

router.get("/", (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM todos ORDER BY status, priority, due_date").all();
  res.json({ items: rows });
});

router.post("/", (req, res) => {
  const db = getDb();
  const { title, note, priority, due_date } = req.body;
  if (!title) return res.status(400).json({ error: "标题必填" });
  const id = "t" + Math.random().toString(36).slice(2, 10);
  db.prepare(
    "INSERT INTO todos(id, title, note, status, priority, due_date, created_at, completed_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(id, title, note || "", "inbox", priority || "P1", due_date || null, new Date().toISOString(), null);
  res.json({ ok: true, id });
});

router.patch("/:id", (req, res) => {
  const db = getDb();
  const { status, title, note, priority, due_date } = req.body;
  const existing = db.prepare("SELECT * FROM todos WHERE id=?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "未找到" });
  const completed_at = status === "done" && existing.status !== "done" ? new Date().toISOString() : existing.completed_at;
  db.prepare(
    "UPDATE todos SET status=COALESCE(?,status), title=COALESCE(?,title), note=COALESCE(?,note), priority=COALESCE(?,priority), due_date=COALESCE(?,due_date), completed_at=? WHERE id=?",
  ).run(status, title, note, priority, due_date, completed_at, req.params.id);
  res.json({ ok: true });
});

router.delete("/:id", (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM todos WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

export default router;
