import express from "express";
import { getDb } from "../db.mjs";

const router = express.Router();

router.get("/:date", (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM daily_reviews WHERE review_date=?").get(req.params.date);
  res.json({ review: row || null });
});

router.put("/:date", (req, res) => {
  const db = getDb();
  const { did, learned, mistake, mood } = req.body;
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT id FROM daily_reviews WHERE review_date=?").get(req.params.date);
  if (existing) {
    db.prepare(
      "UPDATE daily_reviews SET did=?, learned=?, mistake=?, mood=?, updated_at=? WHERE review_date=?",
    ).run(did || "", learned || "", mistake || "", mood || "", now, req.params.date);
  } else {
    db.prepare(
      "INSERT INTO daily_reviews(id, review_date, did, learned, mistake, mood, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run("r" + Math.random().toString(36).slice(2, 10), req.params.date, did || "", learned || "", mistake || "", mood || "", now, now);
  }
  res.json({ ok: true });
});

export default router;
