import express from "express";
import { aihot } from "../ai/aihot.mjs";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const data = await aihot.load({ force: req.query.force === "1" });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message, status: "unavailable" });
  }
});

export default router;
