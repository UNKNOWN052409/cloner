// Activity center (task 4.1.12): per-user product notification events.
//
// Activity events (task completed/failed, publish done, quota warnings) are
// rows in activity_events (migration 018). Read/unread per user, unread
// count, mark-read (single + all). WS emission rides the EXISTING ws-auth
// rooms via the injectable emitter (mock in tests; the real default emits
// nothing — server.js wires the live bus).
//
// Channel fan-out (email/webhook) stays in notification-delivery.js (4.2.16);
// this module is the in-app activity surface and the event CATALOG the
// delivery module links to.
//
// Surface:
//   ACTIVITY_EVENTS                    — event catalog (title template per event)
//   recordActivityEvent({ userId, orgId, event, title, detail, correlationId })
//   listActivityEvents(userId, { unreadOnly, limit })
//   unreadCount(userId)
//   markActivityRead(userId, id) / markAllActivityRead(userId)
//   activityRouter()                   — INTEGRATOR MOUNT LINE:
//       import { activityRouter } from "./activity-routes.js";
//       app.use("/api/activity", activityRouter());
import { Router } from "express";
import { query } from "../database/client.js";
import { authRequired } from "../auth/auth-middleware.js";

export const ACTIVITY_EVENTS = {
  "task.completed": "Clone completed",
  "task.failed": "Clone failed",
  "task.exported": "Export ready",
  "publish.done": "GitHub publish finished",
  "quota.warning": "Approaching fair-use limit",
  "resync.applied": "Re-sync applied",
  "drift.detected": "Drift detected",
};

let emitActivity = null; // injectable WS emitter (mock in tests)
export function setActivityEmitter(fn) { emitActivity = fn; }
export function resetActivityEmitter() { emitActivity = null; }

export async function recordActivityEvent({ userId, orgId = null, event, title = null, detail = {}, correlationId = null, emitter } = {}) {
  if (!userId) throw new Error("userId required for an activity event");
  if (!ACTIVITY_EVENTS[event]) throw new Error(`unknown activity event "${event}" (valid: ${Object.keys(ACTIVITY_EVENTS).join(", ")})`);
  const ins = await query(
    `INSERT INTO activity_events (user_id, org_id, event, title, detail, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, orgId, event, title || ACTIVITY_EVENTS[event], JSON.stringify(detail && typeof detail === "object" ? detail : {}), correlationId]
  );
  const row = ins.rows[0];
  const shaped = shapeEvent(row);
  const emit = emitter !== undefined ? emitter : emitActivity;
  if (typeof emit === "function") {
    try { emit(shaped); } catch { /* WS emission must never break the record */ }
  }
  return shaped;
}

function shapeEvent(row) {
  return {
    id: Number(row.id),
    userId: row.user_id,
    orgId: row.org_id,
    event: row.event,
    title: row.title,
    detail: row.detail || {},
    correlationId: row.correlation_id,
    read: row.read_at != null,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export async function listActivityEvents(userId, { unreadOnly = false, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));
  const r = await query(
    `SELECT * FROM activity_events WHERE user_id = $1 ${unreadOnly ? "AND read_at IS NULL" : ""}
     ORDER BY id DESC LIMIT ${lim}`,
    [userId]
  );
  return r.rows.map(shapeEvent);
}

export async function unreadCount(userId) {
  const r = await query("SELECT count(*)::int AS n FROM activity_events WHERE user_id = $1 AND read_at IS NULL", [userId]);
  return r.rows[0].n;
}

export async function markActivityRead(userId, id) {
  const r = await query(
    `UPDATE activity_events SET read_at = COALESCE(read_at, now()) WHERE user_id = $1 AND id = $2 RETURNING *`,
    [userId, id]
  );
  return r.rows[0] ? shapeEvent(r.rows[0]) : null;
}

export async function markAllActivityRead(userId) {
  await query(`UPDATE activity_events SET read_at = COALESCE(read_at, now()) WHERE user_id = $1 AND read_at IS NULL`, [userId]);
  return { ok: true, unread: await unreadCount(userId) };
}

export async function resetForTest(userId) {
  await query("DELETE FROM activity_events WHERE user_id = $1", [userId]);
}

export function activityRouter() {
  const router = Router();
  router.use(authRequired);

  router.get("/", async (req, res) => {
    try {
      const events = await listActivityEvents(req.userId, {
        unreadOnly: req.query.unread === "1" || req.query.unread === "true",
        limit: Number(req.query.limit) || 50,
      });
      res.json({ ok: true, events, unread: await unreadCount(req.userId) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  router.get("/unread", async (req, res) => {
    try {
      res.json({ ok: true, unread: await unreadCount(req.userId) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  router.post("/:id/read", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "numeric event id required" });
      const updated = await markActivityRead(req.userId, id);
      if (!updated) return res.status(404).json({ ok: false, error: "event not found" });
      res.json({ ok: true, event: updated, unread: await unreadCount(req.userId) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  router.post("/read-all", async (req, res) => {
    try {
      res.json(await markAllActivityRead(req.userId));
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  return router;
}
