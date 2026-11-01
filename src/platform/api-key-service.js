// API key service (task 4.0.6): creation, listing, revocation, expiration,
// validation. SECURITY INVARIANTS (all asserted by scripts/test-api-keys.mjs):
//   • the raw key exists only in the create() return value — never persisted,
//     never logged, never returned by any other function;
//   • storage is a SHA-256 hex hash (key_hash) plus a display-only prefix;
//   • validation rejects revoked, expired and scope-missing keys and stamps
//     last_used_at / last_used_ip (write coalesced to once per minute per key).
import crypto from "node:crypto";
import { query } from "../database/client.js";
import { checkLimit, rateLimitHeaders } from "./rate-limiter.js";

export const SCOPES = ["create:task", "read:task", "export:task"];
const PREFIX_LEN = 12;                       // chars of the raw key kept in clear text
const LAST_USED_THROTTLE_MS = 60 * 1000;     // coalesce last-used writes

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalizeScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : String(scopes || "").split(",");
  const clean = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
  for (const s of clean) {
    if (!SCOPES.includes(s)) throw new Error(`invalid scope: ${s} (valid: ${SCOPES.join(", ")})`);
  }
  return clean;
}

// Create a key. The raw secret is returned EXACTLY ONCE here; every later read
// (list/get/validate) sees only the prefix.
export async function createKey(userId, { name = "api key", scopes = ["read:task"], expiresInDays = null } = {}) {
  if (!userId) throw new Error("userId required");
  const normalized = normalizeScopes(scopes);
  if (!normalized.length) throw new Error("at least one scope required");
  // 32 random bytes = 256 bits; hex-encoded so the whole key is header-safe.
  const raw = "ck_" + crypto.randomBytes(32).toString("hex");
  const prefix = raw.slice(0, PREFIX_LEN);
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null;
  const result = await query(
    `INSERT INTO api_keys (user_id, name, key_hash, prefix, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, prefix, scopes, created_at, expires_at`,
    [userId, String(name).slice(0, 120), sha256(raw), prefix, normalized, expiresAt]
  );
  // fullKey is the ONLY place the raw key is ever exposed — show once at creation
  return { ...result.rows[0], fullKey: raw };
}

export async function listKeys(userId) {
  const result = await query(
    `SELECT id, name, prefix, scopes, created_at, expires_at, revoked_at, last_used_at, last_used_ip
     FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows; // key_hash intentionally NOT selected — never leaves storage
}

export async function getKey(id, userId) {
  const result = await query(
    `SELECT id, name, prefix, scopes, created_at, expires_at, revoked_at, last_used_at, last_used_ip
     FROM api_keys WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return result.rows[0] || null;
}

// Immediate revocation (revoked_at = now()). Revoked keys fail validation at the
// very next request — no grace period, no cache.
export async function revokeKey(id, userId) {
  const result = await query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [id, userId]
  );
  return result.rows.length > 0;
}

// Validate a raw presented key → { userId, keyId, scopes } | null.
// Rejects: unknown key, revoked, expired. On success records last-use info.
export async function validateKey(rawKey, { ip = null } = {}) {
  if (!rawKey || typeof rawKey !== "string") return null;
  const hash = sha256(rawKey);
  const result = await query(
    `SELECT id, user_id, scopes, revoked_at, expires_at, last_used_at
     FROM api_keys WHERE key_hash = $1`,
    [hash]
  );
  const key = result.rows[0];
  if (!key) return null;
  if (key.revoked_at) return null;                       // revoked
  if (key.expires_at && new Date(key.expires_at) <= new Date()) return null; // expired

  // last-used tracking, throttled to one UPDATE per minute per key
  const last = key.last_used_at ? new Date(key.last_used_at).getTime() : 0;
  if (Date.now() - last > LAST_USED_THROTTLE_MS) {
    await query("UPDATE api_keys SET last_used_at = now(), last_used_ip = $2 WHERE id = $1", [key.id, ip]);
  }
  return { userId: key.user_id, keyId: key.id, scopes: key.scopes || [] };
}

export function hasScope(auth, scope) {
  return !!auth && Array.isArray(auth.scopes) && auth.scopes.includes(scope);
}

// ---- Express middleware ----------------------------------------------------
// apiKeyAuth(scope) protects routes with an X-API-Key header. Compatible with
// authRequired: on success it sets req.userId / req.auth (keyId + scopes), so
// user-owned handlers work unchanged. Order of checks: header → key valid →
// scope → rate limit (429 with standard headers). Rejection bodies never echo
// any part of the presented key.
export function apiKeyAuth(scope) {
  return async (req, res, next) => {
    const raw = req.headers["x-api-key"];
    if (!raw) return res.status(401).json({ error: "X-API-Key header required" });
    let auth = null;
    try {
      auth = await validateKey(String(raw), { ip: req.ip });
    } catch {
      return res.status(500).json({ error: "api key check failed" });
    }
    if (!auth) return res.status(401).json({ error: "invalid, revoked or expired api key" });
    if (scope && !auth.scopes.includes(scope)) {
      return res.status(403).json({ error: `api key missing required scope: ${scope}` });
    }
    const limit = await checkLimit(auth.keyId); // limiter id = key UUID, never key material
    for (const [h, v] of Object.entries(rateLimitHeaders(limit))) res.setHeader(h, v);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "rate limit exceeded",
        window: limit.window,
        retryAfterMs: limit.retryAfterMs,
      });
    }
    req.userId = auth.userId;
    req.auth = auth;
    next();
  };
}

// ---- Management router (additive; integrator mounts in server.js) -----------
// INTEGRATOR MOUNT LINE:
//   app.use("/api/keys", keysRouter);
// with `import { keysRouter } from "./api-key-service.js";`
// Session-authenticated (authRequired): keys belong to the session user. The
// created key's raw secret appears in EXACTLY ONE response — creation.
import { Router } from "express";
import { authRequired } from "../auth/auth-middleware.js";

export const keysRouter = Router();

keysRouter.get("/", authRequired, async (req, res) => {
  try { res.json({ keys: await listKeys(req.userId) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

keysRouter.post("/", authRequired, async (req, res) => {
  try {
    const { name, scopes, expiresInDays } = req.body || {};
    const created = await createKey(req.userId, {
      name: name || "api key",
      scopes: Array.isArray(scopes) ? scopes : String(scopes || "read:task").split(","),
      expiresInDays: expiresInDays ? Number(expiresInDays) : null,
    });
    res.status(201).json({ key: created });
  } catch (e) {
    const bad = e.message.startsWith("invalid scope") || /required/.test(e.message);
    res.status(bad ? 400 : 500).json({ error: e.message });
  }
});

keysRouter.get("/:id", authRequired, async (req, res) => {
  try {
    const key = await getKey(req.params.id, req.userId);
    if (!key) return res.status(404).json({ error: "key not found" });
    res.json({ key });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

keysRouter.post("/:id/revoke", authRequired, async (req, res) => {
  try {
    const ok = await revokeKey(req.params.id, req.userId);
    if (!ok) return res.status(404).json({ error: "key not found or already revoked" });
    res.json({ revoked: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
