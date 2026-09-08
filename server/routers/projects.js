import express from "express";
import { getDb } from "../db.mjs";
import { enrichProject } from "../domains/project-status.mjs";

const router = express.Router();

router.get("/", (req, res) => {
  const db = getDb();
  const projects = db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all();
  const phases = db.prepare("SELECT * FROM project_phases").all();
  const byProj = {};
  for (const p of phases) (byProj[p.project_id] ||= []).push(p);
  res.json({
    items: projects.map((p) => {
      const ph = (byProj[p.id] || []).sort((a, b) => a.start_date.localeCompare(b.start_date));
      return enrichProject(p, ph);
    }),
  });
});

router.post("/", (req, res) => {
  const db = getDb();
  const { name, owner, color, note, progress } = req.body;
  if (!name) return res.status(400).json({ error: "项目名称必填" });
  const id = "p" + Math.random().toString(36).slice(2, 10);
  db.prepare("INSERT INTO projects(id, name, owner, color, note, progress, created_at) VALUES(?,?,?,?,?,?,?)").run(
    id, name, owner || "", color || "#378ADD", note || "", Number(progress) || 0, new Date().toISOString(),
  );
  res.json({ ok: true, id });
});

router.patch("/:id", (req, res) => {
  const db = getDb();
  const p = db.prepare("SELECT * FROM projects WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "项目不存在" });
  const { name, owner, note, color, progress } = req.body;
  const next = {
    name: name ?? p.name,
    owner: owner ?? p.owner,
    note: note ?? p.note,
    color: color ?? p.color,
    progress: progress != null ? Number(progress) : p.progress,
  };
  db.prepare("UPDATE projects SET name=?, owner=?, note=?, color=?, progress=? WHERE id=?").run(
    next.name, next.owner, next.note, next.color, next.progress, req.params.id,
  );
  res.json({ ok: true });
});

router.post("/:id/phases", (req, res) => {
  const db = getDb();
  const { phase, start_date, end_date, note } = req.body;
  if (!phase || !start_date || !end_date) return res.status(400).json({ error: "阶段名与起止日期必填" });
  const pid = req.params.id;
  const id = "ph" + Math.random().toString(36).slice(2, 10);
  db.prepare("INSERT INTO project_phases(id, project_id, phase, start_date, end_date, note, created_at) VALUES(?,?,?,?,?,?,?)").run(
    id, pid, phase, start_date, end_date, note || "", new Date().toISOString(),
  );
  res.json({ ok: true, id });
});

router.delete("/:id", (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM projects WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

router.delete("/phases/:id", (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM project_phases WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

export default router;
