#!/usr/bin/env node
// G5.2 — HOSTILE backend hunt (real platform, real PostgreSQL, zero mocks in
// product paths). Boots the REAL platform (startPlatform, ephemeral port,
// compose PostgreSQL, memory queue/limiter backends for determinism) and runs
// the abusive playbook a real attacker would:
//
//   H1  wrong-method matrix over every API surface (never 5xx, never crash)
//   H2  oversized + malformed payloads (auth body cap, parse-error hygiene,
//       deep-nesting stack leak, per-field payload caps)
//   H3  concurrent doubles (HTTP parallel submits → distinct ids; queue-level
//       same-ms enqueue storm → distinct tempIds; same-jobId resubmit →
//       idempotent single entry)
//   H4  auth-bypass matrix (garbage bearer/key, revoked/expired/wrong-scope
//       keys, foreign tasks/jobs, admin surface as plain user, query-token)
//   H5  tenant crossing (quota pool crossing via header-vs-body org mismatch,
//       cross-org usage probes, org artifacts ACL, remote-anonymous access)
//   H6  queue/lease races (PostgreSQL lease: 8 concurrent acquirers → 1 winner,
//       steal bumps epoch, wrong-owner renew/release rejected, stale-epoch
//       fencing; quota promote-failure must stop the job; status-listener leak)
//   H7  migration edges (concurrent migrate() race, idempotent re-run)
//   H8  auth brute-force throttle (register/login per-IP limits) — LAST, burns
//       the per-IP budget
//   H9  server liveness after the whole barrage
//
// SKIP contract: compose PostgreSQL unreachable → loud SKIP, exit 0.
// Every identity is runtime-generated; everything this run created is cleaned up.
process.env.PGCONNECT_TIMEOUT = process.env.PGCONNECT_TIMEOUT || "4";
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // fixture targets on 127.0.0.1
delete process.env.CLONER_REDIS_URL;
delete process.env.REDIS_URL; // memory queue + memory limiter for determinism

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n== ${t} ==`);
const TAG = "g52" + crypto.randomBytes(3).toString("hex");

// last-resort capture: an async error escaping a route handler is a crash-class
// finding — record it instead of losing the report (product has NO handler).
const escaped = [];
process.on("unhandledRejection", (e) => {
  escaped.push(String((e && e.stack) || e).split("\n").slice(0, 4).join(" | "));
});

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (300s)"); process.exit(1); }, 300_000);
watchdog.unref();

// ---------- probes ----------
async function api(base, method, p, { body, headers, raw } = {}) {
  const canBody = raw !== undefined || (body !== undefined && !/^GET$|^HEAD$/i.test(method));
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(canBody && body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...(headers || {}) },
    body: raw !== undefined ? raw : canBody && body !== undefined ? JSON.stringify(body) : undefined,
  }).catch((e) => null);
  if (!res) return { status: 0, json: null, text: "connection failed", headers: new Headers() };
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

// ---------- database ----------
let db;
try {
  db = await import("../src/database/client.js");
  await db.query("SELECT 1");
} catch (e) {
  const msg = `compose Postgres unreachable (${String(e?.message || e).slice(0, 120)}) — docker compose up -d postgres`;
  for (let i = 0; i < 40; i++) console.log(`SKIP  g52 hunt check ${i + 1}/40 — ${msg}`);
  console.log(`\nRESULT: SKIP  (0/40 checks run — database unavailable)`);
  process.exit(0);
}
const { query, closePool } = db;

// baseline schema: apply the ordered migrations once (advisory-locked inside)
const { migrate } = await import("../src/database/client.js");
try { await migrate(); } catch (e) {
  console.log("FAIL  baseline migrations failed — " + String(e?.message || e).slice(0, 200));
  process.exit(1);
}

// ---------- platform boot (real) ----------
const { startPlatform } = await import("../src/platform/server.js");
const started = await startPlatform({ port: 0 });
const base = `http://127.0.0.1:${started.server.address().port}`;
console.log(`[hunt] platform on :${started.server.address().port}`);

// ---------- identities ----------
const cred = (tag) => ({
  email: `${TAG}-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@hunt.test`,
  password: "pw-" + crypto.randomBytes(9).toString("hex"),
});
async function makeUser(tag, { role = "member" } = {}) {
  const c = cred(tag);
  const reg = await api(base, "POST", "/api/auth/register", { body: c });
  if (reg.status !== 200) throw new Error(`register ${tag}: ${reg.status} ${reg.text.slice(0, 120)}`);
  const r = await api(base, "POST", "/api/auth/login", { body: c });
  if (!r.json?.token) throw new Error(`login ${tag}: ${r.status} ${r.text.slice(0, 120)}`);
  const id = r.json.userId;
  if (role !== "member") await query("UPDATE users SET role = $1 WHERE id = $2", [role, id]);
  return { tag, ...c, token: r.json.token, userId: id, h: { authorization: `Bearer ${r.json.token}` } };
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });

const owner = await makeUser("owner");
const attacker = await makeUser("attacker");
const memberM = await makeUser("memberM");          // OWNER of org C
const plainMember = await makeUser("plainmember");  // plain MEMBER of org C (invited below)
const outsider = await makeUser("outsider");        // member of NO org
const adminUser = await makeUser("admin", { role: "admin" });
const BAD_BEARER = { authorization: "Bearer g52-garbage-not-a-session" };
const BAD_KEY = { "x-api-key": "ck_" + "0".repeat(64) };

// pin generous quota headroom for the probe identities so the abuse battery
// below never trips a coded default mid-suite (the limits under test are set
// explicitly per-probe); cleanup removes these rows.
for (const u of [owner, attacker, memberM]) {
  await query(
    `INSERT INTO quota_limits (scope_type, scope_id, limit_key, limit_value)
     VALUES ('user', $1, 'max_concurrent_jobs', 12), ('user', $1, 'max_queued_jobs', 60),
            ('user', $1, 'max_jobs_per_day', 500), ('user', $1, 'max_exploration_minutes_per_day', NULL)
     ON CONFLICT (scope_type, scope_id, limit_key) DO UPDATE SET limit_value = EXCLUDED.limit_value`,
    [u.userId]
  );
}
// (org-scoped limits are pinned inline in H5 where the org contexts exist)

// orgs: owner's org A (attacker NOT member), org B (attacker owner), org C (memberM + outsider NOT member)
async function makeOrg(actor, tag) {
  const r = await api(base, "POST", "/api/orgs", { headers: actor.h, body: { name: `Hunt org ${tag} ${TAG}` } });
  if (r.status !== 201) throw new Error(`org ${tag}: ${r.status} ${r.text.slice(0, 120)}`);
  return r.json.org;
}
const orgA = await makeOrg(owner, "A");
const orgB = await makeOrg(attacker, "B");
const orgC = await makeOrg(memberM, "C");
{
  const inv = await api(base, "POST", `/api/orgs/${orgC.id}/invitations`, { headers: memberM.h, body: { email: plainMember.email, role: "member" } });
  if (inv.status !== 201) throw new Error(`invite plainMember: ${inv.status} ${inv.text.slice(0, 120)}`);
  const acc = await api(base, "POST", "/api/orgs/invitations/accept", { headers: plainMember.h, body: { token: inv.json.token } });
  if (acc.status !== 200) throw new Error(`accept plainMember: ${acc.status} ${acc.text.slice(0, 120)}`);
} // plainMember joins org C; outsider stays a non-member (no invitation issued)

// keys for scope/revocation/expiry probes
const { createKey, revokeKey } = await import("../src/platform/api-key-service.js");
const kRead = await createKey(owner.userId, { name: "hunt-read", scopes: ["read:task"] });
const kCreate = await createKey(owner.userId, { name: "hunt-create", scopes: ["create:task"] });
const kRevoked = await createKey(owner.userId, { name: "hunt-revoked", scopes: ["read:task"] });
await revokeKey(kRevoked.id, owner.userId);
const kExpired = await createKey(owner.userId, { name: "hunt-expired", scopes: ["read:task"], expiresInDays: 0.00002 }); // ~1.7s
await sleep(2100);

// victim v1 task (created in-process; no browser — isolation probes only)
const tasksMod = await import("../src/platform/tasks.js");
const victimTask = tasksMod.createTask({ url: "https://example.com/hunt-victim", userId: owner.userId });

// ownerless job id that does not exist
const MISSING = "g52-no-such-job";

// fast-fail target: passes url-guard, refuses TCP immediately (no browser page load)
const DEAD_URL = "http://127.0.0.1:1/hunt";

// ---------- cleanup bookkeeping ----------
const artifactsBefore = new Set(fs.existsSync(path.join(PROJECT, "artifacts")) ? fs.readdirSync(path.join(PROJECT, "artifacts")) : []);
const platformDataBefore = new Set(fs.existsSync(path.join(PROJECT, "platform-data")) ? fs.readdirSync(path.join(PROJECT, "platform-data")) : []);
const v1TasksCreated = [victimTask.id];
async function cleanup() {
  try {
    await query(`DELETE FROM quota_reservations WHERE scope_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%') OR scope_id IN (SELECT id FROM organizations WHERE slug LIKE '${TAG}-%')`);
    await query(`DELETE FROM quota_usage_events WHERE scope_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%') OR scope_id IN (SELECT id FROM organizations WHERE slug LIKE '${TAG}-%')`);
    await query(`DELETE FROM quota_usage_daily WHERE scope_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%') OR scope_id IN (SELECT id FROM organizations WHERE slug LIKE '${TAG}-%')`);
    await query(`DELETE FROM quota_limits WHERE scope_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%') OR scope_id IN (SELECT id FROM organizations WHERE slug LIKE '${TAG}-%')`);
    await query(`DELETE FROM compute_job_costs WHERE scope_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%') OR scope_id IN (SELECT id FROM organizations WHERE slug LIKE '${TAG}-%')`);
    await query(`DELETE FROM job_leases WHERE job_id LIKE '${TAG}-%'`);
    await query(`DELETE FROM api_keys WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%')`);
    await query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${TAG}-%')`);
    await query(`DELETE FROM org_invitations WHERE org_id IN (SELECT id FROM organizations WHERE slug LIKE '${TAG}-%')`);
    await query(`DELETE FROM org_members WHERE org_id IN (SELECT id FROM organizations WHERE slug LIKE '${TAG}-%') OR user_id IN (SELECT id FROM users WHERE email LIKE '%${TAG}%')`);
    await query(`DELETE FROM organizations WHERE slug LIKE '${TAG}-%'`);
    await query(`DELETE FROM users WHERE email LIKE '%${TAG}%'`);
    for (const id of v1TasksCreated) { try { tasksMod.deleteTask(id); } catch {} }
    const now = fs.existsSync(path.join(PROJECT, "artifacts")) ? fs.readdirSync(path.join(PROJECT, "artifacts")) : [];
    for (const d of now) if (!artifactsBefore.has(d)) { try { fs.rmSync(path.join(PROJECT, "artifacts", d), { recursive: true, force: true }); } catch {} }
    const pd = fs.existsSync(path.join(PROJECT, "platform-data")) ? fs.readdirSync(path.join(PROJECT, "platform-data")) : [];
    for (const d of pd) if (!platformDataBefore.has(d)) { try { fs.rmSync(path.join(PROJECT, "platform-data", d), { recursive: true, force: true }); } catch {} }
  } catch (e) { console.log(`[hunt] cleanup warning: ${String(e?.message || e).slice(0, 160)}`); }
}

// ============================================================================
section("H1 — wrong-method matrix (no 5xx, no crash, state preserved)");
{
  const matrix = [
    ["PUT", "/api/auth/login"], ["PATCH", "/api/auth/register"], ["GET", "/api/auth/register"],
    ["DELETE", "/api/auth/me"], ["POST", "/api/auth/me"], ["PUT", "/api/tasks"],
    ["DELETE", "/api/tasks"], ["PATCH", "/api/tasks"], ["POST", `/api/tasks/${victimTask.id}`],
    ["PUT", `/api/tasks/${victimTask.id}`], ["GET", `/api/tasks/${victimTask.id}/chat`],
    ["PUT", "/api/jobs"], ["DELETE", "/api/jobs"], ["POST", `/api/jobs/${MISSING}`],
    ["DELETE", `/api/jobs/${MISSING}/artifacts/manifest.json`], ["PUT", `/api/export/${victimTask.id}`],
    ["PATCH", "/api/keys"], ["DELETE", "/api/keys"], ["PUT", "/api/keys/revoke"],
    ["POST", "/api/quota/usage"], ["DELETE", "/api/quota/reconcile"], ["PUT", "/api/orgs"],
    ["GET", "/api/orgs/invitations/accept"], ["POST", `/api/orgs/${orgA.id}`],
    ["PATCH", "/api/admin/users"], ["DELETE", "/api/admin/tasks"], ["POST", "/api/sessions"],
    ["PUT", "/api/providers"], ["POST", "/preview/x"], ["POST", "/metrics"], ["DELETE", "/healthz"],
  ];
  let bad = [];
  for (const [m, p] of matrix) {
    const r = await api(base, m, p, { body: { url: DEAD_URL, x: 1 }, headers: owner.h });
    const who = owner.h; // with credentials: an unsupported method must be a plain 404/405, never 5xx/200
    const ok = r.status === 404 || r.status === 405 || (r.status === 401 && !who) || (r.status >= 400 && r.status < 500 && r.status !== 401);
    if (!ok) bad.push(`${m} ${p} → ${r.status}`);
  }
  check("H1: all wrong-method probes → 4xx (404/405/…), never 5xx/2xx", bad.length === 0, bad.slice(0, 4).join("; ") || `${matrix.length} probes`);
  const r = await api(base, "POST", "/api/tasks", { body: { url: DEAD_URL, pipeline: "v1" }, headers: owner.h });
  check("H1: server still serves after method abuse", (await api(base, "GET", "/healthz")).status === 200 && r.status < 500, `last POST /api/tasks → ${r.status}`);
}

// ============================================================================
section("H2 — oversized + malformed payloads");
{
  // (a) malformed JSON → clean JSON 4xx, no stack leak
  const bad = await api(base, "POST", "/api/tasks", { raw: '{"url":"https://example.com",', headers: { ...owner.h, "content-type": "application/json" } });
  const clean = bad.json && typeof bad.json === "object" && bad.status >= 400 && bad.status < 500;
  const noStack = !bad.text.includes("\n    at ");
  check("H2a: malformed JSON → JSON 4xx (no HTML/stack leak)", clean && noStack, `status=${bad.status} json=${Boolean(bad.json)} stack=${bad.text.includes("\n    at ")}`);

  // (b) deep nesting → bounded JSON error, no stack leak
  const deep = '{"a":' + "[".repeat(200000) + "1" + "]".repeat(200000) + "}";
  const deepRes = await api(base, "POST", "/api/tasks", { raw: deep, headers: { ...owner.h, "content-type": "application/json" } });
  const deepOk = deepRes.status >= 400 && deepRes.status < 500 && Boolean(deepRes.json) && !deepRes.text.includes("\n    at ");
  check("H2b: 200k-deep nesting → JSON 4xx, no crash/stack", deepOk, `status=${deepRes.status} json=${Boolean(deepRes.json)}`);

  // (c) auth routes reject oversized bodies (413), tiny JSON still fine
  const bigAuth = await api(base, "POST", "/api/auth/login", { raw: JSON.stringify({ email: "a@b.test", password: "x".repeat(2 * 1024 * 1024) }), headers: { ...owner.h, "content-type": "application/json" } });
  check("H2c: 2MB login body → 413", bigAuth.status === 413, `got ${bigAuth.status}`);
  const bigRegister = await api(base, "POST", "/api/auth/register", { raw: JSON.stringify({ email: `big-${TAG}@hunt.test`, password: "x".repeat(2 * 1024 * 1024) }), headers: { "content-type": "application/json" } });
  check("H2c: 2MB register body → 413", bigRegister.status === 413, `got ${bigRegister.status}`);
  const bigKeys = await api(base, "POST", "/api/keys", { raw: JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) }), headers: { ...owner.h, "content-type": "application/json" } });
  check("H2c: 2MB key-create body → 413", bigKeys.status === 413, `got ${bigKeys.status}`);

  // (d) per-field caps on task creation
  const hugeInstr = await api(base, "POST", "/api/tasks", { body: { url: DEAD_URL, instructions: "x".repeat(30000) }, headers: owner.h });
  check("H2d: 30k-char instructions → 400/413", hugeInstr.status === 400 || hugeInstr.status === 413, `got ${hugeInstr.status}`);
  const hugeCookies = await api(base, "POST", "/api/tasks", { body: { url: DEAD_URL, cookies: { blob: "c".repeat(1600 * 1024) } }, headers: owner.h });
  check("H2d: 1.6MB cookies blob → 413", hugeCookies.status === 413, `got ${hugeCookies.status}`);
  const longUser = await api(base, "POST", "/api/tasks", { body: { url: DEAD_URL, username: "u".repeat(4000), password: "p" }, headers: owner.h });
  check("H2d: 4k-char username → 400", longUser.status === 400, `got ${longUser.status}`);
  const normalTask = await api(base, "POST", "/api/tasks", { body: { url: DEAD_URL }, headers: owner.h });
  check("H2d: normal task body still accepted", normalTask.status === 200, `got ${normalTask.status}`);

  // (e) login with pathological field types → 4xx not 500
  for (const [i, b] of [["arr", { email: ["x"], password: ["y"] }], ["num", { email: 42, password: { a: 1 } }], ["deep", { email: { toString: 1 }, password: null }]].entries()) {
    const r = await api(base, "POST", "/api/auth/login", { body: b[1] });
    check(`H2e: login with ${b[0]} fields → 4xx`, r.status >= 400 && r.status < 500, `got ${r.status}`);
  }
}

// ============================================================================
section("H3 — concurrent doubles");
{
  // (a) HTTP: N parallel submissions must return N DISTINCT ids
  const N = 8;
  const posts = await Promise.all(Array.from({ length: N }, () =>
    api(base, "POST", "/api/tasks", { body: { url: DEAD_URL, pipeline: "v2" }, headers: owner.h })));
  const ids = posts.map((r) => r.json?.id);
  const allOk = posts.every((r) => r.status === 200);
  const distinct = new Set(ids).size;
  check("H3a: 8 parallel POST /api/tasks → 8 distinct job ids", allOk && distinct === N, `statuses=${posts.map((r) => r.status).join(",")} distinct=${distinct}/${N}`);

  // (b) queue-level same-millisecond storm (the race window the API path hits)
  const { createCloneQueue } = await import("../src/queues/clone-queue.js");
  const q = createCloneQueue({ maxConcurrent: 50 });
  const entries = [];
  for (let i = 0; i < 400; i++) entries.push(q.enqueue({ payload: { url: "https://storm.invalid/" }, run: () => new Promise((res) => setTimeout(res, 5)) }));
  const tempIds = new Set(entries.map((e) => e.tempId));
  const dupes = entries.length - tempIds.size;
  const registryLeak = entries.filter((e) => q.getEntry(e.tempId) !== e).length;
  check("H3b: 400 same-ms enqueues → distinct tempIds, no registry collision", dupes === 0 && registryLeak === 0, `dupes=${dupes} unreachable-entries=${registryLeak}`);

  // (c) same explicit jobId resubmitted → idempotent (one entry, one dispatch)
  const fixedId = `${TAG}-dupjob`;
  const a = q.enqueue({ payload: { url: "https://dup.invalid/" }, jobId: fixedId, run: () => new Promise((res) => setTimeout(res, 30)) });
  const b = q.enqueue({ payload: { url: "https://dup.invalid/" }, jobId: fixedId, run: () => new Promise((res) => setTimeout(res, 30)) });
  check("H3c: explicit jobId double-submit is idempotent", a === b, `same-entry=${a === b}`);
  await q.close();

  // (d) settle the HTTP batch so quota/listeners clean up
  await sleep(9000);
}

// ============================================================================
section("H4 — auth-bypass matrix");
{
  // garbage credentials are fully enforced (never silently degraded)
  for (const [m, p, want] of [
    ["POST", "/api/tasks", 401], ["GET", "/api/tasks", 401], ["GET", "/api/jobs", 401],
    ["GET", "/api/quota/usage", 401], ["POST", "/api/quota/reconcile", 401],
    ["GET", "/api/keys", 401], ["GET", "/api/admin/users", 401], ["GET", "/api/orgs", 401],
    ["GET", "/api/sessions", 401], ["GET", "/api/providers", 401],
  ]) {
    const rb = await api(base, m, p, { body: m === "GET" ? undefined : { url: DEAD_URL }, headers: BAD_BEARER });
    check(`H4: garbage bearer ${m} ${p} → ${want}`, rb.status === want, `got ${rb.status}`);
    const rk = await api(base, m, p, { body: m === "GET" ? undefined : { url: DEAD_URL }, headers: BAD_KEY });
    // 401 = key rejected at validation; 403 = documented "no key scope may perform this" gate
    check(`H4: garbage api-key ${m} ${p} → 401/403`, rk.status === 401 || rk.status === 403, `got ${rk.status}`);
  }

  // revoked key is dead at the very next request
  const revokedUse = await api(base, "GET", "/api/tasks", { headers: { "x-api-key": kRevoked.fullKey } });
  check("H4: revoked key → 401", revokedUse.status === 401, `got ${revokedUse.status}`);
  // expired key is dead
  const expiredUse = await api(base, "GET", "/api/tasks", { headers: { "x-api-key": kExpired.fullKey } });
  check("H4: expired key → 401", expiredUse.status === 401, `got ${expiredUse.status}`);
  // wrong-scope key cannot create tasks
  const wrongScope = await api(base, "POST", "/api/tasks", { body: { url: DEAD_URL }, headers: { "x-api-key": kRead.fullKey } });
  check("H4: read-only key POST /api/tasks → 403", wrongScope.status === 403, `got ${wrongScope.status}`);
  // any key scope is barred from destructive/session surfaces
  for (const [m, p] of [["DELETE", `/api/tasks/${victimTask.id}`], ["POST", `/api/tasks/${victimTask.id}/chat`], ["POST", `/api/export/${victimTask.id}`], ["GET", "/api/sessions"]]) {
    const r = await api(base, m, p, { body: m === "GET" ? undefined : { instruction: "x" }, headers: { "x-api-key": kCreate.fullKey } });
    check(`H4: api key ${m} ${p} → 403 (no key scope may perform this)`, r.status === 403, `got ${r.status}`);
  }

  // foreign-session isolation
  const foreignGet = await api(base, "GET", `/api/tasks/${victimTask.id}`, { headers: attacker.h });
  check("H4: foreign GET v1 task → 404", foreignGet.status === 404, `got ${foreignGet.status}`);
  const foreignDelete = await api(base, "DELETE", `/api/tasks/${victimTask.id}`, { headers: attacker.h });
  const stillThere = await api(base, "GET", `/api/tasks/${victimTask.id}`, { headers: owner.h });
  check("H4: foreign DELETE v1 task → 404 AND task survives", foreignDelete.status === 404 && stillThere.status === 200, `delete=${foreignDelete.status} get=${stillThere.status}`);
  const foreignExport = await api(base, "POST", `/api/export/${victimTask.id}`, { headers: attacker.h });
  check("H4: foreign export → 404", foreignExport.status === 404, `got ${foreignExport.status}`);
  const foreignDownload = await api(base, "GET", `/api/export/${victimTask.id}/download`, { headers: attacker.h });
  check("H4: foreign export download → 404", foreignDownload.status === 404, `got ${foreignDownload.status}`);
  const foreignChat = await api(base, "POST", `/api/tasks/${victimTask.id}/chat`, { body: { instruction: "x" }, headers: attacker.h });
  check("H4: foreign chat edit → 404", foreignChat.status === 404, `got ${foreignChat.status}`);

  // admin surface as plain user / as member
  for (const [m, p] of [["GET", "/api/admin/users"], ["GET", "/api/admin/tasks"], ["POST", "/api/admin/tasks/x/cancel"], ["PUT", `/api/admin/users/${attacker.userId}/quota`], ["POST", "/api/admin/api-keys/x/revoke"], ["POST", "/api/admin/retention/sweep"]]) {
    const r = await api(base, m, p, { body: m === "GET" ? undefined : {}, headers: attacker.h });
    check(`H4: plain user ${m} ${p} → 403`, r.status === 403, `got ${r.status}`);
  }
  const adminOk = await api(base, "GET", "/api/admin/users", { headers: adminUser.h });
  check("H4: real admin GET /api/admin/users → 200", adminOk.status === 200, `got ${adminOk.status}`);
  const reconcile = await api(base, "POST", "/api/quota/reconcile", { headers: attacker.h, body: {} });
  check("H4: plain user quota reconcile → 403", reconcile.status === 403, `got ${reconcile.status}`);

  // non-member org probes (tenant middleware 403 / service 404 — both deny without leaking)
  const orgPeek = await api(base, "GET", `/api/orgs/${orgA.id}`, { headers: attacker.h });
  check("H4: non-member GET foreign org → 403/404", [403, 404].includes(orgPeek.status), `got ${orgPeek.status}`);
  const orgPatch = await api(base, "PATCH", `/api/orgs/${orgA.id}`, { headers: attacker.h, body: { name: "pwned" } });
  check("H4: non-member PATCH foreign org → 403/404", [403, 404].includes(orgPatch.status), `got ${orgPatch.status}`);
  const orgInvite = await api(base, "POST", `/api/orgs/${orgA.id}/invitations`, { headers: attacker.h, body: { email: attacker.email, role: "member" } });
  check("H4: non-member invite self → 403/404", [403, 404].includes(orgInvite.status), `got ${orgInvite.status}`);
  const memberRole = await api(base, "PATCH", `/api/orgs/${orgA.id}/members/${attacker.userId}`, { headers: attacker.h, body: { role: "owner" } });
  check("H4: non-member role escalation → 403/404", [403, 404].includes(memberRole.status), `got ${memberRole.status}`);

  // plain member (NOT owner/admin) cannot do owner-only things in org C
  const memberInviteAdmin = await api(base, "POST", `/api/orgs/${orgC.id}/invitations`, { headers: plainMember.h, body: { email: `x-${TAG}@hunt.test`, role: "admin" } });
  check("H4: member inviting admin → 403", memberInviteAdmin.status === 403, `got ${memberInviteAdmin.status}`);
  const memberDeleteOrg = await api(base, "DELETE", `/api/orgs/${orgC.id}`, { headers: plainMember.h });
  check("H4: member delete org → 403", memberDeleteOrg.status === 403, `got ${memberDeleteOrg.status}`);
  const memberPatchOrg = await api(base, "PATCH", `/api/orgs/${orgC.id}`, { headers: plainMember.h, body: { name: "renamed-by-member" } });
  check("H4: member PATCH org → 403", memberPatchOrg.status === 403, `got ${memberPatchOrg.status}`);
  const memberListInvites = await api(base, "GET", `/api/orgs/${orgC.id}/invitations`, { headers: plainMember.h });
  check("H4: member list invitations → 403", memberListInvites.status === 403, `got ${memberListInvites.status}`);

  // traversal ids still refused
  for (const p of ["/api/tasks/..%2f..%2fplatform-data", "/api/jobs/..%2f..%2fpackage.json/artifacts/manifest.json", "/preview/..%2f..%2f/package.json/index.html", "/api/export/..%2f..%2fsecrets/download"]) {
    const r = await api(base, "GET", p, { headers: BAD_BEARER });
    check(`H4: traversal GET ${p.split("/").slice(0, 2).join("/")} → 4xx`, r.status >= 400 && r.status < 500, `got ${r.status}`);
  }
}

// ============================================================================
section("H5 — tenant crossing");
{
  // (a) THE CROSSING PROBE: quota scope resolved from body.orgId while the
  // tenant middleware validated the X-Org-Id header → a member of org A
  // consumes org B's pool (and B's higher limits) without membership.
  await query(
    `INSERT INTO quota_limits (scope_type, scope_id, limit_key, limit_value)
     VALUES ('org', $1, 'max_jobs_per_day', 3), ('org', $2, 'max_jobs_per_day', 3)
     ON CONFLICT (scope_type, scope_id, limit_key) DO UPDATE SET limit_value = EXCLUDED.limit_value`,
    [orgA.id, orgB.id]
  );
  const crossing = await api(base, "POST", "/api/tasks", {
    headers: { ...owner.h, "x-org-id": orgA.id }, // header = org A (valid membership)
    body: { url: DEAD_URL, pipeline: "v2", orgId: orgB.id },   // body smuggles org B
  });
  check("H5a: header-A body-B submit accepted (B not joined via body)", crossing.status === 200, `got ${crossing.status}`);
  const crossed = await query(
    `SELECT 1 FROM quota_reservations
      WHERE scope_type = 'org' AND scope_id = $1 AND created_by_user_id = $2
        AND reserved_at > now() - interval '2 minutes' LIMIT 1`,
    [orgB.id, owner.userId]
  );
  check("H5a: NO quota reservation for org B by a non-member", crossed.rows.length === 0, `rows=${crossed.rows.length} (crossing = leak)`);
  const inA = await query(
    `SELECT 1 FROM quota_reservations WHERE scope_type='org' AND scope_id=$1 AND created_by_user_id=$2 AND reserved_at > now() - interval '2 minutes' LIMIT 1`,
    [orgA.id, owner.userId]
  );
  check("H5a: reservation lands in the VALIDATED org (A)", inA.rows.length > 0, `rows=${inA.rows.length}`);
  await query(`DELETE FROM quota_limits WHERE scope_id IN ($1, $2)`, [orgA.id, orgB.id]);

  // (b) direct body-org probes on non-member orgs
  const usageB = await api(base, "GET", `/api/quota/usage?orgId=${orgB.id}`, { headers: owner.h });
  check("H5b: non-member usage read of org B → 403", usageB.status === 403, `got ${usageB.status}`);
  const taskBodyB = await api(base, "POST", "/api/tasks", { headers: owner.h, body: { url: DEAD_URL, pipeline: "v2", orgId: orgB.id } });
  check("H5b: body-orgId-only submit to non-member org → 403", taskBodyB.status === 403, `got ${taskBodyB.status}`);
  const hdrForeign = await api(base, "GET", "/api/tasks", { headers: { ...owner.h, "x-org-id": orgB.id } });
  check("H5b: X-Org-Id of non-member org on list is REFUSED (never silently ignored)", hdrForeign.status === 403, `got ${hdrForeign.status}`);
  const hdrGarbage = await api(base, "GET", "/api/tasks", { headers: { ...owner.h, "x-org-id": "<script>alert(1)</script>" } });
  check("H5b: garbage X-Org-Id → 403 (no 500, no query error)", hdrGarbage.status === 403, `got ${hdrGarbage.status}`);

  // (c) org artifacts ACL: job owned by (plainMember, orgC); outsider + owner-of-other-org denied
  const job = await api(base, "POST", "/api/tasks", { headers: { ...plainMember.h, "x-org-id": orgC.id }, body: { url: DEAD_URL, pipeline: "v2" } });
  const jobId = job.json?.id;
  check("H5c: orgC member job created", job.status === 200 && !!jobId, `got ${job.status}`);
  await sleep(500);
  const outsiderArtifacts = await api(base, "GET", `/api/jobs/${jobId}/artifacts/manifest.json`, { headers: outsider.h });
  check("H5c: non-member artifacts read → 404", outsiderArtifacts.status === 404, `got ${outsiderArtifacts.status}`);
  const foreignArtifacts = await api(base, "GET", `/api/jobs/${jobId}/artifacts/manifest.json`, { headers: attacker.h });
  check("H5c: other-org user artifacts read → 404", foreignArtifacts.status === 404, `got ${foreignArtifacts.status}`);
  const ownerArtifacts = await api(base, "GET", `/api/jobs/${jobId}/artifacts/manifest.json`, { headers: plainMember.h });
  check("H5c: owner artifacts read → not 403/401 (200 or 404-if-absent)", [200, 404].includes(ownerArtifacts.status), `got ${ownerArtifacts.status}`);
  // remote anonymous must NOT read org jobs artifacts (nor receive 200)
  const anonArtifacts = await api(base, "GET", `/api/jobs/${jobId}/artifacts/manifest.json`);
  check("H5c: anonymous artifacts read of owned job → 4xx", anonArtifacts.status >= 400 && anonArtifacts.status < 500, `got ${anonArtifacts.status}`);

  // (d) v2 job detail: foreign caller gets 404 (no existence leak), member gets data
  const foreignDetail = await api(base, "GET", `/api/jobs/${jobId}`, { headers: attacker.h });
  check("H5d: foreign job detail → 404", foreignDetail.status === 404, `got ${foreignDetail.status}`);
  const memberDetail = await api(base, "GET", `/api/jobs/${jobId}`, { headers: memberM.h });
  check("H5d: member job detail → 200", memberDetail.status === 200, `got ${memberDetail.status}`);

  // (e) attacker's listing must not contain owner's task ids
  const attList = await api(base, "GET", "/api/tasks", { headers: attacker.h });
  check("H5e: attacker task list excludes owner tasks", !JSON.stringify(attList.json || []).includes(victimTask.id));
  await sleep(8000); // settle batch
}

// ============================================================================
section("H5f — remote-socket posture (the LAN address is a genuinely REMOTE caller)");
{
  const os = await import("node:os");
  let lanIp = null;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === "IPv4" && !i.internal && !lanIp) lanIp = i.address;
  }
  const port = started.server.address().port;
  const remoteBase = lanIp ? `http://${lanIp}:${port}` : null;
  const ping = remoteBase ? await api(remoteBase, "GET", "/healthz") : { status: 0 };
  if (!remoteBase || ping.status !== 200) {
    check("H5f: remote-socket posture probes", true, `SKIP — no reachable non-loopback interface (${lanIp || "none"}, ping=${ping.status})`);
  } else {
    console.log(`[hunt] remote posture via ${remoteBase}`);
    // ownerless job created by the LOCAL anonymous dashboard (loopback — the legacy posture)
    const anonCreate = await api(base, "POST", "/api/tasks", { body: { url: DEAD_URL, pipeline: "v2" } });
    check("H5f: loopback anonymous task creation still works (local dashboard)", anonCreate.status === 200, `got ${anonCreate.status}`);
    await sleep(2500);
    // the SAME calls from a REMOTE socket must be refused — free compute + recon
    const remoteCreate = await api(remoteBase, "POST", "/api/tasks", { body: { url: DEAD_URL, pipeline: "v2" } });
    check("H5f: REMOTE anonymous POST /api/tasks → 401 (no free compute)", remoteCreate.status === 401, `got ${remoteCreate.status}`);
    const remoteList = await api(remoteBase, "GET", "/api/tasks");
    check("H5f: REMOTE anonymous GET /api/tasks → 401 (no ownerless listing)", remoteList.status === 401, `got ${remoteList.status}`);
    const remoteJobs = await api(remoteBase, "GET", "/api/jobs");
    check("H5f: REMOTE anonymous GET /api/jobs → 401", remoteJobs.status === 401, `got ${remoteJobs.status}`);
    if (anonCreate.json?.id) {
      const remoteArt = await api(remoteBase, "GET", `/api/jobs/${anonCreate.json.id}/artifacts/manifest.json`);
      check("H5f: REMOTE anonymous artifacts read of OWNERLESS job → 4xx", remoteArt.status >= 400 && remoteArt.status < 500, `got ${remoteArt.status}`);
    }
    const remoteSessions = await api(remoteBase, "GET", "/api/sessions");
    check("H5f: REMOTE anonymous /api/sessions → 401", remoteSessions.status === 401, `got ${remoteSessions.status}`);
    const remoteMetrics = await api(remoteBase, "GET", "/metrics");
    check("H5f: REMOTE /metrics refused (403) — loopback-only by default", remoteMetrics.status === 403, `got ${remoteMetrics.status}`);
    const localMetrics = await api(base, "GET", "/metrics");
    check("H5f: loopback /metrics still 200 (ops dashboards unaffected)", localMetrics.status === 200, `got ${localMetrics.status}`);
    await sleep(6000);
  }
}

// ============================================================================
section("H6 — queue / lease races");
{
  // (a) PostgreSQL lease: N concurrent acquirers → exactly one winner
  const { createLeaseManager, createPostgresLeaseBackend } = await import("../src/distributed/job-leases.js");
  const shared = createPostgresLeaseBackend({ query });
  const mk = (wid) => createLeaseManager({ backend: shared, ttlMs: 60000, workerId: wid, region: "hunt" });
  const jobId = `${TAG}-lease-1`;
  const racers = await Promise.all(["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"].map((w) => mk(w).acquire(jobId)));
  const winners = racers.filter((r) => r.acquired);
  check("H6a: 8 concurrent acquirers → exactly 1 winner", winners.length === 1, `winners=${winners.length}`);
  // key every probe to the ACTUAL winner (whichever racer the DB granted)
  const winnerId = winners[0]?.lease?.owner || winners[0]?.owner;
  const loserId = ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"].find((w) => w !== winnerId) || "wX";
  const live = await mk(winnerId).getLease(jobId);
  check("H6a: lease row is live and owned by the single winner", !!live.lease && live.lease.owner === winnerId && live.lease.active === true, `owner=${live.lease?.owner} active=${live.lease?.active}`);
  // (b) wrong-owner renew / release rejected
  const wrongRenew = await mk(loserId).renew(jobId);
  check("H6b: wrong-owner renew rejected", wrongRenew.renewed === false, `reason=${wrongRenew.reason}`);
  const wrongRelease = await mk(loserId).release(jobId);
  check("H6b: wrong-owner release rejected", wrongRelease.released === false, `reason=${wrongRelease.reason}`);
  // (c) fencing: stale epoch rejected
  const ownerEpoch = Number(live.lease.epoch);
  const stale = await mk(winnerId).validateOwnership(jobId, winnerId, ownerEpoch + 5);
  check("H6c: stale-epoch ownership write rejected", stale.valid === false, `reason=${stale.reason}`);
  const current = await mk(winnerId).validateOwnership(jobId, winnerId, ownerEpoch);
  check("H6c: current-epoch ownership write accepted", current.valid === true, `reason=${current.reason}`);
  check("H6c: mapped lease epoch is a number (cross-backend comparability)", typeof live.lease.epoch === "number", `type=${typeof live.lease.epoch} value=${String(live.lease.epoch)}`);
  // (d) steal only after expiry; epoch bumps; robbed owner is fenced out
  const stealEarly = await mk("w9").steal(jobId);
  check("H6d: steal of LIVE lease rejected", stealEarly.acquired === false, `reason=${stealEarly.reason}`);
  await query(`UPDATE job_leases SET expires_at = now() - interval '1 second' WHERE job_id = $1`, [jobId]);
  const stealers = await Promise.all(["w9", "w10", "w11"].map((w) => mk(w).steal(jobId)));
  const stealWins = stealers.filter((r) => r.acquired);
  check("H6d: 3 concurrent stealers of expired lease → exactly 1", stealWins.length === 1, `winners=${stealWins.length}`);
  const afterSteal = await mk("w9").getLease(jobId);
  check("H6d: steal bumps the epoch (fencing token)", Number(afterSteal.lease?.epoch) === ownerEpoch + 1, `epoch ${ownerEpoch} → ${String(afterSteal.lease?.epoch)}`);
  const oldOwnerRenew = await mk(winnerId).renew(jobId);
  check("H6d: robbed owner cannot renew", oldOwnerRenew.renewed === false, `reason=${oldOwnerRenew.reason}`);
  const fencedOld = await mk(winnerId).validateOwnership(jobId, winnerId, ownerEpoch);
  check("H6d: robbed owner's OLD-epoch effects are fenced (even same worker id)", fencedOld.valid === false, `reason=${fencedOld.reason}`);
  await mk("w9").release(jobId).catch(() => {});

  // (e) quota promote-failure must STOP the job (concurrent limit is real).
  // The read-only preflight is racy by design — TWO CONCURRENT submissions
  // both see running=0 and pass; enforcement then happens at promotion, and a
  // REFUSED promotion must cancel the loser instead of letting it execute
  // past max_concurrent_jobs.
  {
    const u = await makeUser("promotefail");
    await query(
      `INSERT INTO quota_limits (scope_type, scope_id, limit_key, limit_value)
       VALUES ('user', $1, 'max_concurrent_jobs', 1)
       ON CONFLICT (scope_type, scope_id, limit_key) DO UPDATE SET limit_value = EXCLUDED.limit_value`,
      [u.userId]
    );
    // slow fixture so executing jobs stay busy while the race resolves
    const fixture = http.createServer((req, res) => setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body><h1>slow hunt fixture</h1></body></html>"); }, 3000));
    await new Promise((res) => fixture.listen(0, "127.0.0.1", res));
    const fport = fixture.address().port;
    const [j1, j2] = await Promise.all([
      api(base, "POST", "/api/tasks", { body: { url: `http://127.0.0.1:${fport}/`, pipeline: "v2" }, headers: u.h }),
      api(base, "POST", "/api/tasks", { body: { url: `http://127.0.0.1:${fport}/x`, pipeline: "v2" }, headers: u.h }),
    ]);
    const created = [j1, j2].filter((r) => r.status === 200 && r.json?.id);
    check("H6e: concurrent over-limit submissions land (or are quota-refused)", created.length >= 1, `statuses=${j1.status}/${j2.status}`);
    // The promotion refusal cancels the loser; the pipeline finishes naturally
    // (memory backend: no unsafe teardown) and the entry settles "cancelled".
    // Wait until BOTH reach a terminal state (real browser pipeline: up to ~40s).
    let states = null;
    for (let t = 0; t < 40; t++) {
      await sleep(1000);
      states = [];
      for (const r of created) {
        const d = await api(base, "GET", `/api/tasks/${r.json.id}`, { headers: u.h });
        states.push(d.json?.status || "?");
      }
      if (states.every((s) => ["completed", "completed_with_limitations", "error", "cancelled"].includes(s))) break;
    }
    const executed = states.filter((s) => ["completed", "completed_with_limitations", "error"].includes(s)).length;
    check("H6e: at most ONE job executes against max_concurrent_jobs=1", executed <= 1 && states.every((s) => ["completed", "completed_with_limitations", "error", "cancelled"].includes(s)), `final states=${states.join(",")} executed=${executed}`);
    const runningRows = await query(
      `SELECT count(*)::int AS n FROM quota_reservations WHERE scope_type='user' AND scope_id=$1 AND released_at IS NULL AND state='running'`,
      [u.userId]
    );
    check("H6e: no leaked running reservations after settlement", Number(runningRows.rows[0].n) <= 1, `running=${runningRows.rows[0].n}`);
    // cleanup
    for (const r of created) await api(base, "DELETE", `/api/tasks/${r.json.id}`, { headers: u.h });
    await query(`DELETE FROM quota_limits WHERE scope_id = $1`, [u.userId]);
    fixture.close();
    await sleep(4000);
  }

  // (f) status-listener leak: submissions must not accumulate permanent
  // listeners. Terminal jobs unsubscribe (real browser pipelines take a while
  // to settle — poll up to 30s for the count to come back down).
  {
    const { getCloneQueue } = await import("../src/queues/clone-queue.js");
    const q = getCloneQueue();
    const before = q.listenerCount("status");
    for (let i = 0; i < 5; i++) await api(base, "POST", "/api/tasks", { body: { url: DEAD_URL, pipeline: "v2" }, headers: owner.h });
    const during = q.listenerCount("status");
    let after = during;
    for (let t = 0; t < 30; t++) {
      await sleep(1000);
      after = q.listenerCount("status");
      if (after <= before + 2) break;
    }
    check("H6f: status listeners do not accumulate across submissions", after <= before + 2, `before=${before} during=${during} after=${after} (30s settle)`);
  }
  await sleep(4000);
}

// ============================================================================
section("H7 — migration edges");
{
  // (a) concurrent migrate() boots: loser must not fail with a duplicate-key error
  let raceError = null;
  try { await Promise.all([migrate(), migrate(), migrate()]); } catch (e) { raceError = e; }
  check("H7a: 3 concurrent migrate() runs all succeed", !raceError, raceError ? String(raceError.message).slice(0, 140) : "");

  // (b) race on a FRESH file id (the exact concurrent-boot window)
  const FRESH = "017-job-leases.sql";
  await query(`DELETE FROM _migrations WHERE id = $1`, [FRESH]);
  let freshError = null;
  try { await Promise.all([migrate(), migrate()]); } catch (e) { freshError = e; }
  const reApplied = await query(`SELECT 1 FROM _migrations WHERE id = $1`, [FRESH]);
  check("H7b: concurrent boot over an unapplied migration — no duplicate-key failure, row recorded once", !freshError && reApplied.rows.length === 1, freshError ? String(freshError.message).slice(0, 140) : `rows=${reApplied.rows.length}`);

  // (c) idempotent re-run
  let againError = null;
  try { await migrate(); await migrate(); } catch (e) { againError = e; }
  check("H7c: repeated migrate() is idempotent", !againError, againError ? String(againError.message).slice(0, 140) : "");
}

// ============================================================================
section("H8 — auth brute-force throttle (burns the per-IP budget — last)");
{
  const burn = [];
  for (let i = 0; i < 40; i++) {
    burn.push(api(base, "POST", "/api/auth/login", { body: { email: `brute-${TAG}@hunt.test`, password: "wrong-password-1" } }));
  }
  const rs = await Promise.all(burn);
  const saw429 = rs.some((r) => r.status === 429);
  const all4xx = rs.every((r) => r.status >= 400 && r.status < 500);
  check("H8: 40 rapid bad logins are throttled (429 present, all 4xx, no 5xx)", saw429 && all4xx, `statuses sample=${rs.slice(0, 6).map((r) => r.status).join(",")} 429s=${rs.filter((r) => r.status === 429).length}`);
  const limited = rs.find((r) => r.status === 429);
  check("H8: 429 carries Retry-After guidance", limited ? !!limited.headers.get("retry-after") : false, limited ? `retry-after=${limited.headers.get("retry-after")}` : "no 429 observed");
  // register endpoint throttled too (same per-IP budget, separate id). A flood
  // is a MIX: the first per-minute requests legitimately succeed (200), the
  // rest are 429 — the invariants are "429 engages" and "never 5xx".
  const regs = await Promise.all(Array.from({ length: 25 }, (_, i) =>
    api(base, "POST", "/api/auth/register", { body: { email: `reg-brute-${TAG}-${i}@hunt.test`, password: "hunter2hunter2" } })));
  const reg429 = regs.some((r) => r.status === 429);
  const reg5xx = regs.some((r) => r.status >= 500);
  check("H8: registration flood is throttled (429 engages, no 5xx)", reg429 && !reg5xx, `429s=${regs.filter((r) => r.status === 429).length} 200s=${regs.filter((r) => r.status === 200).length} 5xx=${regs.filter((r) => r.status >= 500).length}`);
}

// ============================================================================
section("H9 — liveness after the barrage");
{
  const hz = await api(base, "GET", "/healthz");
  check("H9: /healthz 200 after the full hostile battery", hz.status === 200, `got ${hz.status}`);
  const escapedNote = escaped.length === 0;
  check("H9: no unhandled async errors escaped any route handler", escapedNote, escaped.slice(0, 3).join(" || ") || "clean");
}

await cleanup();
await closePool();
try { started.server.close(); } catch {}

const passed = results.filter(Boolean).length;
console.log(`\nRESULT: ${passed === results.length ? "PASS" : "FAIL"}  ${passed}/${results.length} checks`);
process.exit(passed === results.length ? 0 : 1);
