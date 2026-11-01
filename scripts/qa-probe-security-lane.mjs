#!/usr/bin/env node
// LANE 3 — SECURITY live probe (4.0.12 quality gate). Boots the REAL platform
// (startPlatform, ephemeral port, compose PostgreSQL + Redis) and drives:
//   (a) quotas + rate limits engage with crafted requests — API-key fixed-window
//       burst → 429 + Retry-After + X-RateLimit-*; quota concurrent/daily limits
//       → 429/402 on POST /api/tasks with a Bearer session; cross-tenant
//       ?orgId= usage probe → 403.
//   (b) export zip carries no credential-named entries — plants cookies.json,
//       storage-state.json, .env, secrets/ dir, private/ and asserts the v1
//       zip enumeration is clean while site source (storage.js) survives.
//   (d) every /api route is auth-probed: anonymous (documented legacy posture
//       or 401), garbage Bearer → 401, garbage X-API-Key → 401, foreign-user
//       session → 403/404, traversal ids rejected (no rm-rf, no file read).
// Route expectations are the DOCUMENTED posture (server.js credentialed()
// header comments). Unexpected statuses are FAIL.
// Prints PASS/FAIL per check; exits nonzero on any failure. Postgres SKIP
// posture per repo rule 3.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);
// limiter + queue backends: prefer the compose Redis (rate limiter backend is
// sticky per process; quota defaults are read at call time)
process.env.CLONER_REDIS_URL = process.env.CLONER_REDIS_URL || "redis://127.0.0.1:6379";
process.env.API_RATE_LIMIT_PER_MINUTE = "4";   // module-load default — small burst
process.env.API_RATE_LIMIT_PER_HOUR = "10000"; // keep the hour window out of the way
process.env.PURGE_CREDS_ON_DONE = "";          // keep private/ so the export probe can plant it

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

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

// ---- migrations needed by this probe (own set only) ----
const { query, closePool } = await import("../src/database/client.js");
async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  for (const f of ["001-initial.sql", "010-tenants.sql", "011-org-members.sql", "012-quotas.sql", "013-api-keys.sql", "014-artifact-retention.sql", "015-audit-logs.sql", "016-admin-quotas.sql"]) {
    const applied = await query(`SELECT 1 FROM _migrations WHERE id = $1`, [f]);
    if (applied.rows.length) continue;
    const sql = fs.readFileSync(path.join(PROJECT, "src/database/migrations", f), "utf8");
    try {
      await query(sql);
      await query(`INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT DO NOTHING`, [f]);
    } catch (e) {
      // already-applied-by-another-agent migrations fail on CREATE TABLE; only
      // record when the objects actually exist
      const has = await query(`SELECT 1 FROM information_schema.tables WHERE table_name IN ('users','api_keys','quota_reservations','orgs','audit_events') HAVING count(*) >= 5`);
      if (has.rows.length) await query(`INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT DO NOTHING`, [f]);
      else throw e;
    }
  }
}

try {
  await query("SELECT 1");
  await ensureSchema();
} catch (e) {
  console.log("SKIP  security-lane probe — PostgreSQL unreachable (" + String(e?.message || e).split("\n")[0] + ")");
  console.log("SKIP  hint: docker compose up -d postgres, then re-run");
  process.exit(0);
}

const { startPlatform } = await import("../src/platform/server.js");
const started = await startPlatform({ port: 0 });
const platform = `http://127.0.0.1:${started.server.address().port}`;
console.log(`[probe] platform on :${started.server.address().port}`);

// throwaway identities (runtime passwords — nothing hardcoded)
const cred = (tag) => ({
  email: `lane3-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.invalid`,
  password: "pw-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
});
async function makeUser(tag) {
  const c = cred(tag);
  await api(platform, "POST", "/api/auth/register", { body: c });
  const r = await api(platform, "POST", "/api/auth/login", { body: c });
  if (!r.json?.token) throw new Error(`login failed for ${tag}: ${r.status} ${r.text.slice(0, 120)}`);
  return { ...c, token: r.json.token, userId: r.json.userId };
}
const victim = await makeUser("victim");
const attacker = await makeUser("attacker");
const V = { Authorization: `Bearer ${victim.token}` };
const A = { Authorization: `Bearer ${attacker.token}` };
const BAD = { Authorization: "Bearer lane3-garbage-token-not-real" };

// =====================================================================
// (d) every /api route auth-probed
// =====================================================================
console.log("\n== (d) route auth matrix ==");

// documented-401 group: management/privileged surfaces
const must401Anon = [
  ["GET", "/api/auth/me"],
  ["POST", "/api/auth/logout"],
  ["GET", "/api/keys"],
  ["POST", "/api/keys"],
  ["GET", "/api/quota/usage"],
  ["POST", "/api/quota/reconcile"],
  ["GET", "/api/admin/users"],
  ["GET", "/api/admin/tasks"],
  ["POST", "/api/admin/retention/sweep"],
  ["GET", "/api/orgs"],
  ["POST", "/api/orgs"],
];
for (const [m, p] of must401Anon) {
  const r = await api(platform, m, p, { body: m === "GET" ? undefined : {} });
  check(`anon ${m} ${p} → 401`, r.status === 401, `got ${r.status}`);
  const bad = await api(platform, m, p, { body: m === "GET" ? undefined : {}, headers: BAD });
  check(`garbage-bearer ${m} ${p} → 401`, bad.status === 401, `got ${bad.status}`);
}

// documented-401: garbage X-API-Key on the credentialed routes
for (const [m, p] of [["POST", "/api/tasks"], ["GET", "/api/tasks"], ["GET", "/api/jobs"]]) {
  const r = await api(platform, m, p, { body: m === "GET" ? undefined : { url: "https://example.com/" }, headers: { "x-api-key": "ck_lane3_not_a_real_key_000000" } });
  check(`garbage-api-key ${m} ${p} → 401`, r.status === 401, `got ${r.status}`);
}

// foreign-session isolation: attacker must not see victim resources (403/404, never 200 with data).
// The victim task is created IN-PROCESS (no browser launch) — the probes below
// exercise the HTTP isolation layer only.
const tasksModEarly = await import("../src/platform/tasks.js");
const vTaskMeta = tasksModEarly.createTask({ url: "https://example.com/lane3-victim", userId: victim.userId });
const foreignTaskGet = await api(platform, "GET", `/api/tasks/${vTaskMeta.id}`, { headers: A });
check("foreign GET /api/tasks/:id → 404", foreignTaskGet.status === 404, `got ${foreignTaskGet.status}`);
{
  const foreignDelete = await api(platform, "DELETE", `/api/tasks/${vTaskMeta.id}`, { headers: A });
  const stillThere = await api(platform, "GET", `/api/tasks/${vTaskMeta.id}`, { headers: V });
  check("foreign DELETE /api/tasks/:id → 404 AND victim task survives", foreignDelete.status === 404 && stillThere.status === 200, `delete ${foreignDelete.status}, get ${stillThere.status}`);
  const foreignExport = await api(platform, "POST", `/api/export/${vTaskMeta.id}`, { headers: A });
  check("foreign POST /api/export/:id → 404", foreignExport.status === 404, `got ${foreignExport.status}`);
  const foreignChat = await api(platform, "POST", `/api/tasks/${vTaskMeta.id}/chat`, { body: { instruction: "x" }, headers: A });
  check("foreign POST /api/tasks/:id/chat → 404", foreignChat.status === 404, `got ${foreignChat.status}`);
}

// anonymous legacy posture (DOCUMENTED): no creds → proceeds (see server.js
// credentialed() header). Assert it does NOT 401 and does NOT leak credentialed
// tasks: anonymous GET /api/tasks shows ownerless v2 jobs only — the victim's
// credentialed v1 task must still be invisible when the victim id is unknown,
// and quota must not have been reserved (quotaGuard skips null userId).
const anonList = await api(platform, "GET", "/api/tasks");
check("anon GET /api/tasks → 200 (documented legacy posture)", anonList.status === 200, `got ${anonList.status}`);
{
  const leaked = JSON.stringify(anonList.json || []).includes(vTaskMeta.id);
  check("anon listing does NOT leak victim's credentialed task id", !leaked);
}

// public-by-design probes (documented: healthz/readyz/metrics; ui static)
for (const p of ["/healthz", "/readyz", "/metrics", "/api/sessions", "/api/providers"]) {
  const r = await api(platform, "GET", p);
  check(`anon GET ${p} → 200/503 (public by design, no 401)`, r.status === 200 || r.status === 503, `got ${r.status}`);
}
// metrics must not carry key material
const metricsText = (await api(platform, "GET", "/metrics")).text;
check("/metrics carries no key/token material", !/sk-[A-Za-z0-9]{8,}|ck_[0-9a-f]{16,}|Bearer /i.test(metricsText));

// traversal ids: unauthenticated rm-rf / file-read class (Express decodes %2f)
const traversalProbe = async (label, p) => {
  const r = await api(platform, "GET", p);
  check(label, r.status >= 400 && r.status !== 503, `got ${r.status} (expect 4xx)`);
};
await traversalProbe("GET /api/tasks/<traversal> → 4xx", "/api/tasks/..%2f..%2fbackups");
await traversalProbe("GET /api/export/<traversal>/download → 4xx", "/api/export/..%2f..%2fsecret/download");
await traversalProbe("GET /preview/<traversal>/<file> → 4xx", "/preview/..%2f..%2f/package.json/x.html");
await traversalProbe("GET /api/jobs/<traversal> → 4xx", "/api/jobs/..%2f..%2fbackups");
await traversalProbe("GET /api/jobs/<traversal>/artifacts/manifest.json → 4xx", "/api/jobs/..%2f..%2fbackups/artifacts/manifest.json");
// nonexistent job: no existence leak for anon + foreign callers; a GARBAGE
// credential must 401 at the auth layer (documented: "once a credential IS
// presented it is enforced fully") before any resource check
{
  const missing = "lane3-no-such-job";
  for (const [hdr, who, want] of [[{}, "anon", 404], [A, "foreign", 404], [BAD, "garbage-bearer", 401]]) {
    const r1 = await api(platform, "GET", `/api/jobs/${missing}`, { headers: hdr });
    const r2 = await api(platform, "GET", `/api/jobs/${missing}/artifacts/manifest.json`, { headers: hdr });
    check(`${who} GET /api/jobs/<missing> → ${want}`, r1.status === want, `got ${r1.status}`);
    check(`${who} GET /api/jobs/<missing>/artifacts → ${want}`, r2.status === want, `got ${r2.status}`);
  }
  const rj = await api(platform, "GET", "/api/jobs", { headers: BAD });
  check("garbage-bearer GET /api/jobs → 401", rj.status === 401, `got ${rj.status}`);
}
// auth routes: garbage input must 4xx (never 500)
{
  const reg = await api(platform, "POST", "/api/auth/register", { body: { email: "not-an-email", password: "x" } });
  check("register garbage input → 4xx", reg.status >= 400 && reg.status < 500, `got ${reg.status}`);
  const log = await api(platform, "POST", "/api/auth/login", { body: { email: "lane3-nope@example.invalid", password: "wrong" } });
  check("login unknown user → 401 (no existence leak)", log.status === 401, `got ${log.status}`);
}
{
  // DESTRUCTIVE probe: traversal DELETE must not delete a real sibling dir.
  // Target a throwaway directory OUTSIDE platform-data via ../ from ROOT.
  const canaryRoot = path.join(PROJECT, "lane3-canary", "inner");
  fs.rmSync(path.join(PROJECT, "lane3-canary"), { recursive: true, force: true });
  fs.mkdirSync(canaryRoot, { recursive: true });
  fs.writeFileSync(path.join(canaryRoot, "keep.txt"), "canary");
  // id = "../lane3-canary/inner" — deleteTask(taskDir(id)) would rm it
  const rel = encodeURIComponent("../lane3-canary/inner").replace(/%2F/g, "%2f");
  const r = await api(platform, "DELETE", `/api/tasks/${rel}`);
  const survived = fs.existsSync(path.join(canaryRoot, "keep.txt"));
  check("traversal DELETE does not delete outside dirs", survived, `http ${r.status}, canary ${survived ? "survived" : "DELETED"}`);
  fs.rmSync(path.join(PROJECT, "lane3-canary"), { recursive: true, force: true });
}

// org cross-tenant: victim creates org, attacker must get 403 on every org route
const org = await api(platform, "POST", "/api/orgs", { body: { name: "lane3-org" }, headers: V });
check("owner POST /api/orgs → 201", org.status === 201, `got ${org.status}`);
const orgId = org.json?.org?.id || org.json?.id;
if (orgId) {
  for (const [m, p] of [["GET", `/api/orgs/${orgId}`], ["PATCH", `/api/orgs/${orgId}`], ["GET", `/api/orgs/${orgId}/members`], ["POST", `/api/orgs/${orgId}/invitations`]]) {
    const r = await api(platform, m, p, { body: m === "GET" ? undefined : { email: "x@y.z", role: "admin" }, headers: A });
    check(`foreign ${m} ${p} → 403`, r.status === 403, `got ${r.status}`);
  }
  const usage = await api(platform, "GET", `/api/quota/usage?orgId=${orgId}`, { headers: A });
  check("foreign GET /api/quota/usage?orgId=<victim org> → 403", usage.status === 403, `got ${usage.status}`);
}

// =====================================================================
// (a) quotas + rate limits engage with crafted requests
// =====================================================================
console.log("\n== (a) rate limits + quotas ==");

// rate limit: real API key, burst past the per-minute window
const keyRes = await api(platform, "POST", "/api/keys", { body: { name: "lane3", scopes: ["create:task", "read:task"] }, headers: V });
check("key creation → 201 with fullKey once", keyRes.status === 201 && !!keyRes.json?.key?.fullKey, `got ${keyRes.status}`);
const rawKey = keyRes.json?.key?.fullKey;
const K = { "x-api-key": rawKey };
let burst = [];
for (let i = 0; i < 7; i++) {
  burst.push(await api(platform, "POST", "/api/tasks", { body: { url: "http://127.0.0.1:1/nope" }, headers: K }));
}
const got429 = burst.find((r) => r.status === 429);
check("API-key burst engages 429", !!got429, `statuses ${burst.map((r) => r.status).join(",")}`);
if (got429) {
  check("429 carries Retry-After", !!got429.headers.get("retry-after"), got429.headers.get("retry-after"));
  check("429 carries X-RateLimit-*", ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"].every((h) => got429.headers.get(h) !== null));
}

// crafted bypass attempts: different URLs/headers must NOT reset the window
const bypass1 = await api(platform, "POST", "/api/tasks", { body: { url: "http://127.0.0.1:2/nope", pipeline: "v2" }, headers: K });
check("crafted variant request still 429 (same key)", bypass1.status === 429, `got ${bypass1.status}`);

// quota: FRESH user (the API-key burst above already consumed victim's daily
// job slots through the quota guard — by design, each crafted POST reserves
// then releases). ORDER MATTERS: the daily test first (reserving a slot bumps
// jobs_started), then the concurrent-hold test.
const quotaUser = await makeUser("quota");
const Q = { Authorization: `Bearer ${quotaUser.token}` };
const { resolveScope, reserveJobSlot, releaseReservation, setQuotaLimit } = await import("../src/platform/quota-service.js");
const vScope = resolveScope({ userId: quotaUser.userId });

// daily limit: jobs/day=1, burn the day's slot with reserve+release, next POST → 402
await setQuotaLimit(vScope, "max_jobs_per_day", 1);
const k1 = `lane3-daily-${Date.now()}`;
await reserveJobSlot(vScope, k1, { userId: quotaUser.userId });
await releaseReservation(vScope, k1, { userId: quotaUser.userId, outcome: "failed" });
const dailyHit = await api(platform, "POST", "/api/tasks", { body: { url: "https://example.com/lane3" }, headers: Q });
check("daily quota exhausted → POST /api/tasks 402 daily_job_limit", dailyHit.status === 402 && dailyHit.json?.reason === "daily_job_limit", `got ${dailyHit.status} ${JSON.stringify(dailyHit.json?.reason || "")}`);
await setQuotaLimit(vScope, "max_jobs_per_day", null); // unlimited again

// concurrent limit: hold the only slot (simulates a running job), HTTP POST → 429
await setQuotaLimit(vScope, "max_concurrent_jobs", 1);
const heldKey = `lane3-held-${Date.now()}`;
const held = await reserveJobSlot(vScope, heldKey, { userId: quotaUser.userId });
check("direct reserveJobSlot holds the slot", !!held.reservationId);
const qHit = await api(platform, "POST", "/api/tasks", { body: { url: "https://example.com/lane3" }, headers: Q });
check("held concurrent slot → POST /api/tasks 429 concurrent_job_limit", qHit.status === 429 && qHit.json?.reason === "concurrent_job_limit", `got ${qHit.status} ${JSON.stringify(qHit.json?.reason || "")}`);
await releaseReservation(vScope, heldKey, { userId: quotaUser.userId, outcome: "cancelled" });
await setQuotaLimit(vScope, "max_concurrent_jobs", null);

// anonymous quota bypass probe (documented posture): anonymous POST must NOT
// 401 — but assert the documented behavior explicitly so the report is precise
const anonPost = await api(platform, "POST", "/api/tasks", { body: { url: "http://127.0.0.1:3/nope" } });
check("anon POST /api/tasks → 200/400 (documented legacy posture, no auth)", [200, 400].includes(anonPost.status), `got ${anonPost.status}`);

// =====================================================================
// (b) export zip has no credential-named entries
// =====================================================================
console.log("\n== (b) export zip credential sweep ==");
const { exportTask } = await import("../src/platform/exporter.js");
const tasksMod = await import("../src/platform/tasks.js");
const meta = tasksMod.createTask({ url: "https://example.com/lane3-export", cookies: JSON.stringify([{ name: "sid", value: "secret" }]), storage: JSON.stringify({ cookies: [] }), userId: victim.userId });
const out = tasksMod.outDir(meta.id);
fs.mkdirSync(path.join(out, "assets", "secrets"), { recursive: true });          // credential-named DIR with a payload inside
fs.writeFileSync(path.join(out, "assets", "secrets", "api-keys.json"), '{"k":"v"}');
fs.writeFileSync(path.join(out, "cookies.json"), JSON.stringify([{ name: "sid", value: "x" }]));
fs.writeFileSync(path.join(out, "storage-state.json"), "{}");
fs.writeFileSync(path.join(out, "passwords.txt"), "u:p");
fs.writeFileSync(path.join(out, ".env"), "SECRET=1");
fs.writeFileSync(path.join(out, "api-token.txt"), "tok");
fs.writeFileSync(path.join(out, "index.html"), "<html><body>clone</body></html>");
fs.writeFileSync(path.join(out, "storage.js"), "export const storage = {};");   // site source MUST survive
fs.writeFileSync(path.join(out, "snapshot.mhtml"), "MIME-Version: 1.0");
let exported;
try {
  exported = await exportTask(meta.id);
} catch (e) {
  check("v1 export completes (fail-closed or clean)", false, String(e.message).slice(0, 140));
}
if (exported) {
  check("v1 export produced a zip", exported.size > 0);
  // enumerate entries via PowerShell
  const { execFileSync } = await import("node:child_process");
  const list = execFileSync("powershell", ["-NoProfile", "-Command",
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${exported.zipPath.replace(/'/g, "''")}'); $z.Entries | ForEach-Object { $_.FullName }; $z.Dispose()`], { encoding: "utf8", windowsHide: true });
  const entries = list.split(/\r?\n/).filter(Boolean);
  const sensitive = entries.filter((e) => /cookie|private\/|(^|\/)\.env|password|token|credential|(^|\/)secrets?\/|storage-state/i.test(e));
  check("zip has NO credential-named entries", sensitive.length === 0, sensitive.join(", ") || "clean");
  check("zip keeps site source (storage.js) + clone artifacts", entries.includes("storage.js") && entries.includes("index.html"), entries.slice(0, 12).join(", "));
  tasksMod.deleteTask(meta.id);
}

console.log(`\n== summary: ${results.filter(Boolean).length}/${results.length} passed ==`);
const failed = results.filter((r) => !r).length;
// shutdown
try { await import("../src/platform/rate-limiter.js").then((m) => m.closeLimiter()); } catch {}
try { started.server.close(); } catch {}
try { started.wss?.close(); } catch {}
await closePool().catch(() => {});
process.exit(failed ? 1 : 0);
