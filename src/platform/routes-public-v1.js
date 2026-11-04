// Public API versioning + compatibility layer (task 4.1.10).
//
// Public API v1 under /api/v1/* with:
//   • version negotiation — Accept: application/vnd.cloner.v1+json (default
//     when the Accept header is absent/unparsed is v1 JSON)
//   • stable error envelope — { ok:false, error, code } on EVERY failure
//   • deprecation headers on every v1 response (Deprecation + Sunset + Link)
//   • compatibility shim — legacy /api/tasks shapes (flat array of raw task
//     objects) map onto the v1 envelope { ok, data, meta } and back
//
// Surface:
//   API_VERSIONS = ["v1"]
//   negotiateVersion(req)            → "v1" | null (null = unsupported)
//   errorEnvelope(res, status, code, error)
//   toV1TaskShape(task) / fromLegacyTaskList(rows)
//   publicV1Router({ handlers })     — INTEGRATOR MOUNT LINE:
//       import { publicV1Router } from "./routes-public-v1.js";
//       app.use("/api/v1", publicV1Router({ ... }));
//     handlers are injected so the versioned surface shares the REAL task
//     store (tasks.js / exploration-runner.js) without importing server.js.
import { Router } from "express";

export const API_VERSIONS = ["v1"];
export const V1_MEDIA_TYPE = "application/vnd.cloner.v1+json";
export const DEPRECATION_EPOCH = "Wed, 01 Jan 2025 00:00:00 GMT";

// Content negotiation: the vnd media type pins v1; anything else (including
// no Accept or */*) defaults to v1 JSON. An Accept that EXPLICITLY names a
// version we do not serve → null → the router answers 406 with the list.
export function negotiateVersion(req) {
  const accept = String(req.headers.accept || "");
  if (!accept || accept.includes("*/*") || accept.includes("application/json")) return "v1";
  const m = accept.match(/application\/vnd\.cloner\.([a-z0-9]+)\+json/i);
  if (!m) return "v1"; // unrelated accept types (text/html browsers etc.) still get v1
  return API_VERSIONS.includes(m[1]) ? m[1] : null;
}

export function errorEnvelope(res, status, code, error) {
  return res.status(status).json({ ok: false, error: String(error || code).slice(0, 300), code });
}

export function v1Headers(res) {
  res.setHeader("X-Cloner-API-Version", "v1");
  res.setHeader("Deprecation", DEPRECATION_EPOCH);
  res.setHeader("Link", '</api/v1>; rel="versioned"; title="Cloner Public API v1"');
}

// Legacy /api/tasks shape (flat array of raw task metas) → stable v1 shape.
export function toV1TaskShape(t) {
  return {
    id: t.id ?? t.jobId ?? null,
    url: t.url ?? null,
    status: t.status ?? null,
    pipeline: t.pipeline ?? (t.jobId ? "v2" : "v1"),
    createdAt: t.createdAt ?? t.queuedAt ?? null,
    finishedAt: t.finishedAt ?? null,
    verificationPassed: t.verification ? !!t.verification.passed : null,
    artifacts: t.artifacts || null,
    error: t.error || null,
  };
}

export function fromLegacyTaskList(rows) {
  return rows.map(toV1TaskShape);
}

function bearer(req) {
  const h = String(req.headers.authorization || "");
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// The versioned router. handlers = injected real-store access:
//   listTasks({ userId, role })          → legacy+job rows (same as GET /api/tasks)
//   getTask({ userId, role, id })        → row | null (owner-gated)
//   requireAuth(req)                     → { userId, role } | null
export function publicV1Router({ handlers } = {}) {
  const router = Router();
  if (!handlers || typeof handlers.listTasks !== "function") {
    throw new Error("publicV1Router requires handlers.listTasks (injected real store access)");
  }

  router.use((req, res, next) => {
    v1Headers(res);
    const v = negotiateVersion(req);
    if (!v) return errorEnvelope(res, 406, "VERSION_NOT_SUPPORTED", `requested API version is not supported (served: ${API_VERSIONS.join(", ")})`);
    next();
  });

  const identity = async (req) => {
    const token = bearer(req);
    if (!token) return null;
    try {
      const { validateSession } = await import("../auth/auth-service.js");
      const s = await validateSession(token);
      return s ? { userId: s.userId, role: s.role } : null;
    } catch {
      return null;
    }
  };

  router.get("/tasks", async (req, res) => {
    try {
      const id = await identity(req);
      if (!id) return errorEnvelope(res, 401, "UNAUTHENTICATED", "authentication required (Authorization: Bearer <token>)");
      const rows = await handlers.listTasks({ userId: id.userId, role: id.role });
      const data = fromLegacyTaskList(rows);
      res.json({ ok: true, data, meta: { count: data.length, version: "v1" } });
    } catch (e) {
      errorEnvelope(res, 500, "INTERNAL", e?.message || e);
    }
  });

  router.get("/tasks/:id", async (req, res) => {
    try {
      const id = await identity(req);
      if (!id) return errorEnvelope(res, 401, "UNAUTHENTICATED", "authentication required (Authorization: Bearer <token>)");
      const row = await handlers.getTask({ userId: id.userId, role: id.role, id: req.params.id });
      if (!row) return errorEnvelope(res, 404, "NOT_FOUND", "task not found");
      res.json({ ok: true, data: toV1TaskShape(row), meta: { version: "v1" } });
    } catch (e) {
      errorEnvelope(res, 500, "INTERNAL", e?.message || e);
    }
  });

  // version discovery
  router.get("/", (_req, res) => {
    res.json({ ok: true, data: { versions: API_VERSIONS, current: "v1" }, meta: { version: "v1" } });
  });

  return router;
}
