#!/usr/bin/env node
// API keys + rate limiting e2e (task 4.0.6).
// Boots the platform on an EPHEMERAL port against the compose PostgreSQL
// (docker compose up -d postgres if not running) for the real auth/session
// flows, then mounts the API-key management router and the X-API-Key
// middleware on a test-local Express app (same process, same DB) because
// src/platform/server.js is integrator-owned and mounts them later.
// Asserts through live HTTP:
//   • creation returns the full key EXACTLY once; DB stores only a SHA-256
//     hash + display prefix (the raw key string appears in NO column)
//   • X-API-Key middleware authenticates and sets req.userId compatibly with
//     authRequired; missing/wrong/revoked/expired keys are rejected
//   • scope enforcement: read:task key rejected 403 on a create:task route
//   • rate limiting: fixed-window burst → 429 + Retry-After; concurrent burst
//     respects the exact allowance; X-RateLimit-* headers present
//   • no plaintext key material in PostgreSQL storage or captured stdout
// Prints PASS/FAIL lines, exits nonzero on any failure, closes everything.
// REDIS_URL / CLONER_REDIS_URL selects the Redis limiter backend; without it
// the in-memory fallback runs (both postures are runnable, see header comment).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // platform-data etc. are cwd-relative
// small limits so the burst test is short and deterministic (module-load time)
process.env.API_RATE_LIMIT_PER_MINUTE = process.env.API_RATE_LIMIT_PER_MINUTE || "5";
process.env.API_RATE_LIMIT_PER_HOUR = process.env.API_RATE_LIMIT_PER_HOUR || "8";

const { query, closePool } = await import("../src/database/client.js");
const { startPlatform } = await import("../src/platform/server.js");
const { default: express } = await import("express");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(base, method, p, { body, headers } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers, text };
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---- apply ONLY our own migrations (integrator runs the full ordered set) ----
async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const users = await query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'users'`);
  if (!users.rows.length) {
    const sql = fs.readFileSync(path.join(PROJECT, "src/database/migrations/001-initial.sql"), "utf8");
    await query(sql);
    await query(`INSERT INTO _migrations (id) VALUES ('001-initial.sql') ON CONFLICT DO NOTHING`);
  }
  const mine = await query(`SELECT 1 FROM _migrations WHERE id = '013-api-keys.sql'`);
  if (!mine.rows.length) {
    const sql = fs.readFileSync(path.join(PROJECT, "src/database/migrations/013-api-keys.sql"), "utf8");
    await query(sql);
    await query(`INSERT INTO _migrations (id) VALUES ('013-api-keys.sql') ON CONFLICT DO NOTHING`);
  }
}

// ---- postgres reachability (SKIP posture per repo rule 3) ----
try {
  await query("SELECT 1");
  await ensureSchema();
} catch (e) {
  console.log("SKIP  api-keys suite — PostgreSQL unreachable (" + String(e?.message || e).split("\n")[0] + ")");
  console.log("SKIP  hint: docker compose up -d postgres, then re-run");
  process.exit(0);
}

// ---- boot platform (auth/session flows) + test app (key routes) ----
const started = await startPlatform({ port: 0 });
const server = started.server;
const platformPort = server.address().port; // actual ephemeral port (started.port echoes the request)
const platform = `http://127.0.0.1:${platformPort}`;
const app = express();
app.use(express.json());
const { keysRouter, apiKeyAuth } = await import("../src/platform/api-key-service.js");
app.use("/api/keys", keysRouter);
app.get("/api/whoami", apiKeyAuth(null), (req, res) => res.json({ userId: req.userId, keyId: req.auth.keyId, scopes: req.auth.scopes }));
app.post("/api/create-thing", apiKeyAuth("create:task"), (req, res) => res.json({ created: true }));
const testServer = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const testPort = testServer.address().port;
const base = `http://127.0.0.1:${testPort}`;
console.log(`[test] platform on :${platformPort}, key-test app on :${testPort}`);

// capture stdout for the "no key material in logs" assertion
const origLog = console.log;
const logLines = [];
console.log = (...a) => { const s = a.join(" "); logLines.push(s); process.stdout.write(s + "\n"); };

// register a throwaway user (runtime password, nothing hardcoded)
const email = `apikey-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.invalid`;
const password = "pw-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const reg = await api(platform, "POST", "/api/auth/register", { body: { email, password } });
const login = await api(platform, "POST", "/api/auth/login", { body: { email, password } });
const token = login.json?.token;
check("register+login yields session token", reg.status === 200 && !!token, `register=${reg.status} login=${login.status}`);
if (!token) { console.error("FATAL: no session token"); process.exit(1); }
const bearer = { authorization: `Bearer ${token}` };

try {
  // ---- 1. creation: full key shown once, prefix-only everywhere else ----
  const created = await api(base, "POST", "/api/keys", { headers: bearer, body: { name: "e2e", scopes: ["create:task", "read:task"] } });
  const fullKey = created.json?.key?.fullKey;
  check("POST /api/keys 201 returns fullKey once", created.status === 201 && typeof fullKey === "string" && fullKey.startsWith("ck_"), `status=${created.status}`);
  check("created row is prefix-only (no key_hash in response)", !!created.json?.key?.prefix && !("key_hash" in (created.json.key || {})));
  const keyId = created.json.key.id;

  const listed = await api(base, "GET", "/api/keys", { headers: bearer });
  const row = listed.json?.keys?.find((k) => k.id === keyId);
  check("GET /api/keys lists prefix-only, never the secret", !!row && !JSON.stringify(listed.json).includes(fullKey) && row.prefix === fullKey.slice(0, 12));

  // ---- 2. storage invariant: only hash + prefix persisted ----
  const hashRow = await query("SELECT key_hash, prefix, scopes FROM api_keys WHERE id = $1", [keyId]);
  const keyHash = hashRow.rows[0]?.key_hash;
  check("key_hash is sha256(raw) — hashing actually happened", keyHash === sha256(fullKey));
  check("key_hash is not the plaintext key", !!keyHash && keyHash !== fullKey);
  check("prefix column equals first 12 chars (display only)", hashRow.rows[0]?.prefix === fullKey.slice(0, 12));

  // ---- 3. X-API-Key middleware: auth + authRequired compatibility ----
  const who = await api(base, "GET", "/api/whoami", { headers: { "x-api-key": fullKey } });
  check("X-API-Key authenticates protected route", who.status === 200 && who.json?.keyId === keyId, `status=${who.status}`);
  check("middleware exposes userId (authRequired-compatible contract)", typeof who.json?.userId === "string" && who.json.userId.length > 0);
  check("allowed request carries X-RateLimit-* headers", !!(who.headers?.get("x-ratelimit-limit") && who.headers?.get("x-ratelimit-remaining")));
  const noKey = await api(base, "GET", "/api/whoami");
  check("no key → 401", noKey.status === 401);
  const badKey = await api(base, "GET", "/api/whoami", { headers: { "x-api-key": "ck_" + "0".repeat(64) } });
  check("wrong key → 401", badKey.status === 401);
  const bearerWho = await api(base, "GET", "/api/whoami", { headers: bearer });
  check("Bearer token does NOT pass X-API-Key route", bearerWho.status === 401);
  const sessionOnKeys = await api(base, "GET", "/api/keys", { headers: bearer });
  check("session authRequired still guards /api/keys", sessionOnKeys.status === 200);

  // ---- 4. last-used tracking ----
  const lu = await query("SELECT last_used_at IS NOT NULL AS used FROM api_keys WHERE id = $1", [keyId]);
  check("last_used_at stamped after successful use", lu.rows[0]?.used === true);

  // ---- 5. scope enforcement ----
  const ro = await api(base, "POST", "/api/keys", { headers: bearer, body: { name: "ro", scopes: ["read:task"] } });
  const roKey = ro.json?.key?.fullKey;
  check("read-only key created", ro.status === 201 && !!roKey);
  const forbidden = await api(base, "POST", "/api/create-thing", { headers: { "x-api-key": roKey } });
  check("read:task key blocked from create:task route (403)", forbidden.status === 403, `status=${forbidden.status}`);
  check("403 body does not echo key material", !JSON.stringify(forbidden.json || {}).includes(roKey));
  const allowed = await api(base, "POST", "/api/create-thing", { headers: { "x-api-key": fullKey } });
  check("create:task key passes create:task route", allowed.status === 200, `status=${allowed.status}`);
  const bogus = await api(base, "POST", "/api/keys", { headers: bearer, body: { name: "x", scopes: ["admin:everything"] } });
  check("unknown scope rejected at creation (400)", bogus.status === 400, `status=${bogus.status}`);

  // ---- 6. rate limiting (middleware over HTTP, env limits 5/min, 8/hour) ----
  const rl = await import("../src/platform/rate-limiter.js");
  const probe = await rl.checkLimit("probe-" + Math.random().toString(36).slice(2));
  check("limiter backend available (redis or memory)", probe.backend === "redis" || probe.backend === "memory", `backend=${probe.backend}`);

  let mw429 = null;
  for (let i = 0; i < 10; i++) {
    const r = await api(base, "GET", "/api/whoami", { headers: { "x-api-key": fullKey } });
    if (r.status === 429) { mw429 = r; break; }
  }
  check("burst over per-minute limit → HTTP 429", !!mw429, mw429 ? "" : "never tripped in 10 requests");
  check("429 carries Retry-After + X-RateLimit headers", !!mw429 && !!mw429.headers?.get("retry-after") && !!mw429.headers?.get("x-ratelimit-reset"));
  check("429 body names the window, echoes no key", !!mw429?.json?.window && !JSON.stringify(mw429.json).includes(fullKey));

  // concurrent burst against a FRESH limiter id via direct checkLimit (10/min, 15/h).
  // Boundary-proof assertion: results sharing a resetAt share one fixed window,
  // and every window must allow ≤ perMinute. (Firing across a minute edge is a
  // legitimate two-window outcome; per-window ≤ 10 is the real invariant.)
  const burstKey = "burst-" + Math.random().toString(36).slice(2);
  const burst = await Promise.all(Array.from({ length: 20 }, () => rl.checkLimit(burstKey, { perMinute: 10, perHour: 15 })));
  const okCount = burst.filter((r) => r.allowed).length;
  const denied = burst.filter((r) => !r.allowed).length;
  const byWindow = new Map();
  for (const r of burst) {
    const w = byWindow.get(r.resetAt) || { ok: 0 };
    if (r.allowed) w.ok += 1;
    byWindow.set(r.resetAt, w);
  }
  const windowsClean = [...byWindow.values()].every((w) => w.ok <= 10);
  check("concurrent burst respects per-window allowance", windowsClean && okCount + denied === 20 && denied >= 10, `ok=${okCount} denied=${denied} windows=${byWindow.size}`);
  const d0 = burst.find((r) => !r.allowed);
  check("denied result has resetAt + retryAfterMs", !!d0?.resetAt && d0.retryAfterMs >= 1000);
  const hdrs = rl.rateLimitHeaders(burst[0]);
  check("rateLimitHeaders emits X-RateLimit-Limit/Remaining/Reset", !!(hdrs["X-RateLimit-Limit"] && hdrs["X-RateLimit-Remaining"] && hdrs["X-RateLimit-Reset"]));

  // ---- 7. revocation: immediate ----
  const rev = await api(base, "POST", `/api/keys/${keyId}/revoke`, { headers: bearer });
  check("revoke returns 200", rev.status === 200, `status=${rev.status}`);
  const revokedUse = await api(base, "GET", "/api/whoami", { headers: { "x-api-key": fullKey } });
  check("revoked key rejected at the very next request (401)", revokedUse.status === 401, `status=${revokedUse.status}`);
  const revAgain = await api(base, "POST", `/api/keys/${keyId}/revoke`, { headers: bearer });
  check("second revoke → 404 (already revoked)", revAgain.status === 404);

  // ---- 8. expiration ----
  // G5.2: expiresInDays must be a POSITIVE number of days (a negative/garbage
  // value used to mint a dead-on-arrival key via `new Date(NaN)`; the API now
  // 400s it). Mint a short-lived key (~1.6s) and wait for it to lapse.
  const expNeg = await api(base, "POST", "/api/keys", { headers: bearer, body: { name: "exp-neg", scopes: ["read:task"], expiresInDays: -1 } });
  check("negative expiresInDays rejected with 400", expNeg.status === 400, `got ${expNeg.status}`);
  const exp = await api(base, "POST", "/api/keys", { headers: bearer, body: { name: "exp", scopes: ["read:task"], expiresInDays: 1.9e-8 } }); // ≈1.64 seconds
  const expKey = exp.json?.key?.fullKey;
  check("short-lived key created for test", exp.status === 201 && !!expKey);
  await new Promise((r) => setTimeout(r, 2200));
  const expUse = await api(base, "GET", "/api/whoami", { headers: { "x-api-key": expKey } });
  check("expired key rejected (401)", expUse.status === 401, `status=${expUse.status}`);

  // ---- 9. plaintext key material: not stored, not logged ----
  const secrets = [fullKey, roKey, expKey].filter(Boolean);
  const allRows = await query("SELECT * FROM api_keys");
  const serialized = JSON.stringify(allRows.rows);
  check("full raw key string appears in NO api_keys column", secrets.every((s) => !serialized.includes(s)));
  check("key sha256 only ever stored in key_hash", secrets.every((s) => {
    const h = sha256(s);
    return allRows.rows.some((r) => r.key_hash === h) === allRows.rows.some((r) => r.key_hash && r.prefix === s.slice(0, 12));
  }));
  await sleep(50);
  const logged = logLines.join("\n");
  check("captured stdout contains no key material", secrets.every((s) => !logged.includes(s)));
  check("captured stdout contains no sha256 of any key", secrets.every((s) => !logged.includes(sha256(s))));

  // cleanup throwaway rows (keys cascade with the user)
  await query("DELETE FROM users WHERE email = $1", [email]);
} finally {
  console.log = origLog;
  const mod = await import("../src/platform/rate-limiter.js");
  mod.closeLimiter();
  try { testServer.close(); } catch {}
  try { server.close(); } catch {}
  await closePool().catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
