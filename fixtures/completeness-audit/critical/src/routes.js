// Fixture (critical case): route-level violations.
import express from "express";
const router = express.Router();

// seed:dead-501 — a 501 paired with not-implemented language.
router.get("/refund", (req, res) => res.status(501).json({ error: "not implemented" }));

// seed:http-501 — a bare 501 capability gate.
router.post("/sync", (req, res) => res.status(501).json({ error: "this node has no registry attached" }));

export default router;
