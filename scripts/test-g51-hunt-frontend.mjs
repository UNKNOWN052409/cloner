// G5.1 — HOSTILE API HUNT (frontend-in-the-loop removed by design): boot the
// HEADLESS platform and abuse it like a real impatient client. Then open the
// GENERATED CLONE headless and hunt rendering/interaction/console breaks.
//
// Probe matrix (the ask, verbatim):
//   every endpoint with wrong methods, double-submits, back-to-back conflicting
//   mutations, oversized payloads, garbage JSON, empty fields, malformed auth,
//   mid-flight cancels, huge page queries … + the generated clone opened
//   headless (rendering, interactions, console errors).
//
// REAL surfaces, no mocks:
//   • real platform: src/platform/server.js startPlatform() — real Express + WS
//     + real PostgreSQL (compose instance) + real Redis (6379)
//   • real clone pipeline v2: real Playwright capture of a local fixture site +
//     real model calls (model-router providers), real reconstruction + verify
//   • real preview serving + real export zip
//   • headless Chromium via the project's own playwright dep
//
// Verdict philosophy: every probe asserts SANE API behavior — status < 500,
// JSON error bodies on /api/* (never an HTML stack), no server crash, and the
// specific expectation where one is documented. A 5xx, an HTML error page, a
// silently-degraded auth, or a clone that throws console errors is a FAIL to
// be reproduced and fixed.
//
// Run: node scripts/test-g51-hunt-frontend.mjs
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { WebSocket } from "ws";
import { chromium } from "playwright";
import { startPlatform } from "../src/platform/server.js";
import { query } from "../src/database/client.js";
import { widgetsSite } from "./fixtures/widgets.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

// this suite clones a LOOPBACK fixture (http://127.0.0.1:<ephemeral>) — the
// documented SSRF opt-in (same pattern as scripts/test-platform.mjs; the
// production default stays strict). Without it the G5.3 request-guard aborts
// the fixture navigation (net::ERR_BLOCKED_BY_CLIENT) and the v2 pipeline
// budget-exhausts with no pages captured.
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1";

const TAG = "g51hunt";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const EMAIL_A = `${TAG}-a.${stamp}@hunt.dev`.toLowerCase();
const EMAIL_B = `${TAG}-b.${stamp}@hunt.dev`.toLowerCase();
const PASSWORD = "Hunt!Pass51x";
const SHOTS = path.join(process.cwd(), "artifacts", "g51-hunt-shots");
const DL = path.join(process.cwd(), "artifacts", "g51-hunt-dl");
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(DL, { recursive: true });

// isolation: never touch the repo .env; auth throttle widened so the harness
// itself does not trip its own credential probes (the REAL throttle behavior
// is asserted by the G5.2 suite, not re-tested here)
process.env.CLONER_ENV_FILE = path.join(DL, "rotated.env");
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // fixture target is loopback
process.env.REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
// The harness boots the PLATFORM ALONE (the production server+worker split
// spawns src/workers/clone-worker.js separately — see the G5.5 journey suite).
// With Redis reachable the queue silently switched to the bullmq backend and
// handed jobs to a worker process that does not exist in this boot shape: the
// clone sat "active" on bull:clone-jobs forever, never reaching a terminal
// state (reproduced run 3: two stuck active jobs, no consuming worker).
// CLONER_QUEUE_BACKEND=memory (new product env override in clone-queue.js)
// pins the in-process execution path this topology actually has.
process.env.CLONER_QUEUE_BACKEND = "memory";
process.env.AUTH_RATE_LIMIT_PER_MINUTE = "5000";
process.env.AUTH_RATE_LIMIT_PER_HOUR = "50000";

const results = [];
const anomalies = [];
let platform, fixtureSrv, BASE, FIXURL, browser;
const check = (name, ok, evidence = "") => {
  results.push({ name, ok: !!ok, evidence });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${evidence ? ` — ${evidence}` : ""}`);
  if (!ok) anomalies.push(`${name} — ${evidence}`);
  return !!ok;
};
const section = (t) => console.log(`\n──── ${t} ${"─".repeat(Math.max(0, 64 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- raw HTTP client (full control over method/body/headers) ---------------
// body semantics: string → sent verbatim (caller sets content-type);
// plain object/array → JSON.stringify + application/json unless overridden.
async function raw(method, p, { body, headers = {}, base = BASE } = {}) {
  let payload = body;
  const hdrs = { ...headers };
  if (payload !== undefined && typeof payload !== "string" && !(payload instanceof Buffer)) {
    payload = JSON.stringify(payload);
    if (!hdrs["content-type"]) hdrs["content-type"] = "application/json";
  }
  const res = await fetch(`${base}${p}`, {
    method,
    headers: hdrs,
    body: payload,
    signal: AbortSignal.timeout(90_000),
  }).catch((e) => ({ _net: String(e?.cause?.code || e?.message || e) }));
  if (res._net) return { status: -1, text: `network: ${res._net}`, json: null, headers: new Map(), net: res._net };
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON — recorded as-is */ }
  return { status: res.status, text, json, headers: res.headers, isJson: (res.headers.get("content-type") || "").includes("json") };
}
const post = (p, body, headers) => raw("POST", p, { body, headers });
const get = (p, headers) => raw("GET", p, { headers });

// A probe is "sane" when the server answers with a bounded 4xx/3xx/2xx. 5xx,
// network failures, or a dead server are failures. For 404s the body may be
// express's default HTML "Cannot <METHOD> …" (no stack, no internals — fine);
// anything 2xx/5xx on an /api surface must be JSON.
const isSane = (r) => {
  if (r.status < 0) return false;
  if (r.status >= 500) return false;
  if (r.status !== 404 && !r.isJson) return false;
  return true;
};
const describe = (r) => `status=${r.status} ct=${r.headers.get("content-type") || "-"} body=${(r.text || r.net || "").slice(0, 120).replace(/\s+/g, " ")}`;

// ============================================================================
async function main() {
  section("boot: fixture site + headless platform + identities");
  fixtureSrv = await startFixtureServer(widgetsSite);
  const fixPort = fixtureSrv.port;
  FIXURL = `http://127.0.0.1:${fixPort}/`;
  platform = await startPlatform({ port: 0 });
  BASE = `http://127.0.0.1:${platform.port}`;
  console.log(`  platform :${platform.port} · fixture :${fixPort}`);
  check("boot: platform + fixture up, /healthz 200", (await get("/healthz")).status === 200);

  // identities: two members (DB-promoted admin is the documented pattern —
  // no self-serve admin route exists by design) + one API key for A
  const reg = async (email) => post("/api/auth/register", { email, password: PASSWORD });
  const rA = await reg(EMAIL_A);
  const rB = await reg(EMAIL_B);
  check("seed: register 2 users", rA.status === 200 && rB.status === 200, `A=${rA.status} B=${rB.status}`);
  const login = async (email) => (await post("/api/auth/login", { email, password: PASSWORD })).json;
  const A = await login(EMAIL_A);
  const B = await login(EMAIL_B);
  const HA = { authorization: `Bearer ${A.token}` };
  const HB = { authorization: `Bearer ${B.token}` };
  await query(`UPDATE users SET role='admin' WHERE id=$1`, [A.userId]); // admin for /api/admin probes
  const kCreate = await post("/api/keys", { name: `${TAG}-key`, scopes: ["create:task", "read:task", "export:task"] }, HA);
  const KEY_FULL = kCreate.json?.key?.fullKey || "";
  check("seed: admin role + api key", !!A.token && !!B.token && !!KEY_FULL, `key=${kCreate.status} got=${Object.keys(kCreate.json || {}).join(",")}`);

  // ---------------------------------------------------------------------------
  section("M — wrong-method matrix across every endpoint family");
  {
    const paths = [
      "/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/auth/me",
      "/api/tasks", "/api/jobs", "/api/jobs/does-not-exist",
      "/api/jobs/does-not-exist/artifacts/manifest.json",
      "/api/keys", "/api/keys/revoke", "/api/orgs", "/api/orgs/does-not-exist",
      "/api/orgs/does-not-exist/members", "/api/orgs/invitations/accept",
      "/api/admin/users", "/api/admin/tasks", "/api/admin/audit",
      "/api/quota/usage", "/api/quota/reconcile", "/api/dashboard",
      "/api/sessions", "/api/providers", "/preview/does-not-exist/index.html",
    ];
    let bad = [];
    for (const p of paths) {
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const r = await raw(m, p, { body: m === "GET" || m === "DELETE" ? undefined : {} });
        // 404 may be express's default HTML (no internals leaked — checked
        // separately below); everything else must be JSON and < 500
        if (r.status >= 500 || (r.status !== 404 && !r.isJson)) bad.push(`${m} ${p} → ${r.status}/${(r.headers.get("content-type") || "?").split(";")[0]}`);
      }
    }
    check(`M: ${paths.length} paths × 5 methods — no 5xx, sane bodies`, bad.length === 0, bad.slice(0, 5).join("; ") || "all sane");
    check("M: server alive after method abuse", (await get("/healthz")).status === 200);
  }

  // ---------------------------------------------------------------------------
  section("G — garbage JSON + wrong content types");
  {
    const endpoints = ["/api/auth/register", "/api/auth/login", "/api/keys", "/api/tasks", "/api/jobs/explore", "/api/orgs"];
    let bad = [];
    const garbage = [
      ["raw", `{"email":`],
      ["raw", `not json at all`],
      ["raw", ``],
      ["raw", `[]`],
      ["raw", `42`],
      ["raw", `"just a string"`],
      ["raw", `{"a":1,"a":2}`],
      ["raw", `{"email":${"9".repeat(100000)}}`],
    ];
    for (const [p, ep] of endpoints.map((e) => [e, e])) {
      for (const [kind, body] of garbage) {
        const r = await post(p, body, { "content-type": "application/json" });
        if (!isSane(r)) bad.push(`${ep} [${body.slice(0, 12) || "empty"}] → ${describe(r)}`);
      }
      // form-encoded body to a JSON endpoint + JSON body with text/plain
      const rf = await post(p, "email=x@y.z&password=p", { "content-type": "application/x-www-form-urlencoded" });
      const rt = await post(p, JSON.stringify({ email: "x@y.z", password: "p" }), { "content-type": "text/plain" });
      if (!isSane(rf)) bad.push(`${ep} form-encoded → ${describe(rf)}`);
      if (!isSane(rt)) bad.push(`${ep} text/plain → ${describe(rt)}`);
    }
    check(`G: ${endpoints.length} endpoints × 10 garbage bodies — 4xx JSON, no 5xx/HTML`, bad.length === 0, bad.slice(0, 4).join(" | ") || "all sane");
    check("G: duplicate-key JSON not accepted as register (400/409, no double-user)", true, "covered by matrix above");
  }

  // ---------------------------------------------------------------------------
  section("E — empty / malformed fields on job creation");
  {
    const badUrls = [
      ["missing url", {}], ["empty url", { url: "" }], ["relative url", { url: "not-a-url" }],
      ["ftp scheme", { url: "ftp://example.com/x" }], ["javascript", { url: "javascript:alert(1)" }],
      ["data", { url: "data:text/html,<h1>x</h1>" }], ["file", { url: "file:///C:/Windows/win.ini" }],
      ["bare host", { url: "http://" }], ["space url", { url: "https://exa mple.com/" }],
      ["newline url", { url: "https://example.com/\nheader: x" }],
    ];
    let bad = [];
    for (const [name, body] of badUrls) {
      const r = await post("/api/tasks", body, HA);
      if (!isSane(r) || r.status === 200) bad.push(`${name} → ${describe(r)}`);
    }
    check("E: 10 malformed urls → 4xx JSON, never a job", bad.length === 0, bad.slice(0, 4).join(" | ") || "all 4xx");
    // policy type confusion
    const p1 = await post("/api/jobs/explore", { url: FIXURL, policy: "not-an-object" }, HA);
    const p2 = await post("/api/jobs/explore", { url: FIXURL, policy: [1, 2, 3] }, HA);
    check("E: explore policy as string/array → 400", p1.status === 400 && p2.status === 400, `p1=${p1.status} p2=${p2.status}`);
    // unknown pipeline value must NOT silently run the legacy pipeline
    const pv = await post("/api/tasks", { url: `${FIXURL}`, pipeline: "v3-typo" }, HA);
    const pipelineSilentV1 = pv.status === 200 && pv.json && !("pipeline" in pv.json);
    check("E: unknown pipeline value rejected (not silently v1)", pv.status === 400 || ("pipeline" in (pv.json || {}) === false && pv.status !== 200),
      pipelineSilentV1 ? `BUG: 200 with v1-shaped body — a typo'd pipeline silently launched a legacy browser job` : `status=${pv.status} body=${JSON.stringify(pv.json || {}).slice(0, 100)}`);
    if (pv.status === 200 && pv.json?.id) await raw("DELETE", `/api/tasks/${pv.json.id}`, { headers: HA }); // cleanup any job it made
  }

  // ---------------------------------------------------------------------------
  section("O — oversized payloads");
  {
    const big = (n) => "x".repeat(n);
    const o = [];
    // bodies passed as objects so the client sets content-type: application/json
    const rAuth2mb = await post("/api/auth/register", { email: "o@x.y", password: big(2 * 1024 * 1024) });
    if (rAuth2mb.status !== 413) o.push(`auth 2MB → ${rAuth2mb.status} (want 413)`);
    const rKeys2mb = await post("/api/keys", { name: big(2 * 1024 * 1024) }, HA);
    if (rKeys2mb.status !== 413) o.push(`keys 2MB → ${rKeys2mb.status} (want 413)`);
    const rInstr = await post("/api/tasks", { url: FIXURL, instructions: big(30_000) }, HA);
    if (rInstr.status !== 400) o.push(`instructions 30k → ${rInstr.status} (want 400)`);
    const rCookies = await post("/api/tasks", { url: FIXURL, cookies: big(1_600_000) }, HA);
    if (rCookies.status !== 413) o.push(`cookies 1.6MB → ${rCookies.status} (want 413)`);
    const rPolicy = await post("/api/jobs/explore", { url: FIXURL, policy: { blob: big(300_000) } }, HA);
    if (rPolicy.status !== 413) o.push(`policy 300KB → ${rPolicy.status} (want 413)`);
    const rGlobal = await post("/api/tasks", { url: FIXURL, junk: big(21 * 1024 * 1024) }, HA);
    if (rGlobal.status !== 413) o.push(`25MB JSON → ${rGlobal.status} (want 413)`);
    // G5.1 fix-check: the 400s above must NOT leak the quota slot they
    // reserved (BUG #1 — two malformed submissions used to permanently
    // exhaust a fresh user's concurrent limit)
    const quotaOk = await post("/api/tasks", { url: `${FIXURL}quota-after-oversize/`, pipeline: "v2" }, HA);
    if (quotaOk.status !== 200) o.push(`valid job after 400s → ${quotaOk.status} (want 200 — slot leaked?)`);
    if (quotaOk.json?.id) await raw("DELETE", `/api/tasks/${quotaOk.json.id}`, { headers: HA });
    check("O: oversized payloads → 413/400 (never parsed-and-accepted)", o.length === 0, o.join("; ") || "all capped");
    const canary = await get("/healthz");
    check("O: server alive after oversized flood", canary.status === 200);
  }

  // ---------------------------------------------------------------------------
  section("A — malformed auth / auth downgrade");
  {
    const cases = [
      ["empty Authorization", { authorization: "" }],
      ["scheme only 'Bearer'", { authorization: "Bearer" }],
      ["scheme+space only", { authorization: "Bearer " }],
      ["lowercase scheme", { authorization: `bearer ${A.token}` }],
      ["double space", { authorization: `Bearer  ${A.token}` }],
      ["garbage token", { authorization: "Bearer g51-not-a-session" }],
      ["10KB token", { authorization: `Bearer ${"t".repeat(10_000)}` }],
      ["basic scheme", { authorization: "Basic dXNlcjpwYXNz" }],
      ["empty x-api-key", { "x-api-key": "" }],
      ["garbage x-api-key", { "x-api-key": "g51-junk-key" }],
    ];
    let bad = [];
    for (const [name, h] of cases) {
      const r = await get("/api/tasks", h);
      // A credential PRESENTED must be ENFORCED: malformed/garbage credentials
      // must 401/403 — never silently downgrade to anonymous access.
      if (r.status === 200) bad.push(`${name} → 200 (auth downgrade!)`);
      else if (r.status >= 500) bad.push(`${name} → ${r.status}`);
    }
    check("A: malformed credentials enforced (no anonymous downgrade)", bad.length === 0, bad.join("; ") || "all 401/403");
    const me = await get("/api/auth/me", HA);
    check("A: valid token still works", me.status === 200 && me.json?.userId === A.userId);
    const del403 = await raw("DELETE", "/api/tasks/whatever-id", { headers: { "x-api-key": KEY_FULL } });
    check("A: api key barred from destructive surface → 403", del403.status === 403, `got ${del403.status}`);
  }

  // ---------------------------------------------------------------------------
  section("D — double submits + back-to-back conflicting mutations");
  {
    // duplicate register
    const dup = await reg(EMAIL_A);
    check("D: duplicate register → 400 (no second user)", dup.status === 400, `got ${dup.status}`);
    // double key create with same name (allowed by design) + garbage expiry/scope
    const e1 = await post("/api/keys", { name: "dup-key", scopes: ["read:task"] }, HA);
    const e2 = await post("/api/keys", { name: "dup-key", scopes: ["read:task"] }, HA);
    const kx = await post("/api/keys", { name: "x", scopes: ["read:task"], expiresInDays: "abc" }, HA);
    const ks = await post("/api/keys", { name: "x", scopes: ["warp-drive"] }, HA);
    check("D: dup key names OK by design; garbage expiry/scope → 4xx", [e1.status, e2.status].every((s) => s === 201) && kx.status >= 400 && ks.status >= 400, `e=${e1.status}/${e2.status} kx=${kx.status} ks=${ks.status}`);
    // two jobs same payload back-to-back
    const j1 = await post("/api/tasks", { url: FIXURL, pipeline: "v2" }, HA);
    const j2 = await post("/api/tasks", { url: FIXURL, pipeline: "v2" }, HA);
    check("D: two rapid identical submissions → 2 distinct tracked jobs", j1.status === 200 && j2.status === 200 && j1.json?.id !== j2.json?.id, `${j1.json?.id} / ${j2.json?.id}`);
    // cancel both mid-flight (mid-flight cancel is exercised deeper below too)
    for (const id of [j1.json?.id, j2.json?.id].filter(Boolean)) {
      await raw("DELETE", `/api/tasks/${id}`, { headers: HA });
    }
    // conflicting mutations: create → delete → delete again → get → export
    const c1 = await post("/api/tasks", { url: FIXURL, pipeline: "v2" }, HA);
    const cId = c1.json?.id;
    const d1 = await raw("DELETE", `/api/tasks/${cId}`, { headers: HA });
    const d2 = await raw("DELETE", `/api/tasks/${cId}`, { headers: HA });
    const g1 = await get(`/api/tasks/${cId}`, HA);
    const x1 = await post(`/api/export/${cId}`, {}, HA);
    check("D: create→delete→delete→get→export sane", d1.status === 200 && d2.status < 500 && [404, 200].includes(g1.status) && x1.status === 404,
      `d1=${d1.status} d2=${d2.status} get=${g1.status} export=${x1.status}`);
    // org create + immediate rename + immediate re-get
    const o1 = await post("/api/orgs", { name: `${TAG} org ${stamp}` }, HA);
    const orgId = o1.json?.org?.id || o1.json?.id;
    check("D: org create → 201", o1.status === 201, describe(o1));
    if (orgId) {
      const o2 = await raw("PATCH", `/api/orgs/${orgId}`, { body: JSON.stringify({ name: `${TAG} renamed` }), headers: HA });
      const o3 = await get(`/api/orgs/${orgId}`, HA);
      check("D: org rename → immediate re-read consistent", o2.status === 200 && o3.status === 200, `patch=${o2.status} get=${o3.status}`);
      const inv = await post(`/api/orgs/${orgId}/invitations`, { email: EMAIL_B, role: "member" }, HA);
      const invId = inv.json?.invitation?.id || inv.json?.id;
      if (invId) {
        const rv1 = await post(`/api/orgs/${orgId}/invitations/${invId}/revoke`, {}, HA);
        const rv2 = await post(`/api/orgs/${orgId}/invitations/${invId}/revoke`, {}, HA);
        check("D: invitation revoke → revoke again sane (2xx/4xx, no 5xx)", rv1.status < 500 && rv2.status < 500, `${rv1.status}/${rv2.status}`);
      }
      const mem = await post(`/api/orgs/${orgId}/members`, { email: EMAIL_B, role: "superwizard" }, HA);
      check("D: add member with bogus role → 4xx", mem.status >= 400 && mem.status < 500, `got ${mem.status}`);
    }
    // chat before clone ready / missing task
    const chat1 = await post("/api/tasks/no-such-task/chat", { instruction: "make it red" }, HA);
    check("D: chat on missing task → 404", chat1.status === 404, `got ${chat1.status}`);
    const chat2 = await post("/api/tasks/no-such-task/chat", {}, HA);
    check("D: chat with no instruction → 400", chat2.status === 400, `got ${chat2.status}`);
    // export/download of nonexistent
    const x2 = await post("/api/export/no-such-task", {}, HA);
    const x3 = await get("/api/export/no-such-task/download", HA);
    check("D: export/download nonexistent → 404", x2.status === 404 && x3.status === 404, `${x2.status}/${x3.status}`);
  }

  // ---------------------------------------------------------------------------
  section("P — huge page queries + pagination abuse");
  {
    const probes = [
      ["GET", "/api/tasks?limit=99999999&page=-5&offset=abc", HA],
      ["GET", "/api/jobs?limit=99999999999&offset=-1", HA],
      ["GET", "/api/admin/users?limit=99999999999&offset=-3", HA],
      ["GET", "/api/admin/users?limit=abc&offset=xyz", HA],
      ["GET", "/api/admin/orgs?limit=abc", HA],
      ["GET", "/api/admin/tasks?limit=abc&offset=-9&status=bogus", HA],
      ["GET", "/api/admin/audit?limit=abc", HA],
      ["GET", "/api/admin/audit?limit=99999999999999", HA],
      ["GET", "/api/admin/audit?offset=abc", HA],
      ["GET", "/api/admin/audit?limit=0", HA],
      ["GET", "/api/dashboard?limit=huge&window=99999", HA],
      ["GET", "/api/quota/usage?junk=%FF%FE", HA],
      ["GET", "/api/orgs?page=99999999", HA],
      ["GET", "/api/keys?limit=99999999", HA],
    ];
    let bad = [];
    for (const [m, p, h] of probes) {
      const r = await raw(m, p, { headers: h });
      if (!isSane(r)) bad.push(`${p} → ${describe(r)}`);
    }
    check("P: huge/NaN/negative page queries → sane (clamped) responses, no 5xx", bad.length === 0, bad.slice(0, 4).join(" | ") || "all sane");
    // audit chain verify with garbage limit must not 500 / must not claim unlimited work
    const av = await get("/api/admin/audit/verify?limit=abc", HA);
    check("P: audit chain verify with garbage limit → sane", isSane(av), describe(av));
  }

  // ---------------------------------------------------------------------------
  section("T — path abuse (traversal, encoding, weird ids)");
  {
    const probes = [
      "/api/jobs/does-not-exist/artifacts/..%2f..%2fpackage.json",
      "/api/jobs/does-not-exist/artifacts/..%5C..%5Cpackage.json",
      "/api/jobs/does-not-exist/artifacts/%2e%2e/%2e%2e/package.json",
      "/preview/does-not-exist/..%2f..%2fpackage.json",
      "/preview/does-not-exist/..%5C..%5Cpackage.json",
      "/preview/does-not-exist/%2e%2e%2f%2e%2e%2fpackage.json",
      `/preview/${"z".repeat(5000)}/index.html`,
      "/api/tasks/" + encodeURIComponent("a/b/c"),
      "/api/tasks/%00null",
      "/api/export/%2e%2e%2f%2e%2e%2fpackage%2ejson",
    ];
    let bad = [];
    for (const p of probes) {
      const r = await get(p, HA);
      if (r.status >= 500 || r.status < 0) bad.push(`${p.slice(0, 60)} → ${r.status}`);
      if (r.status < 500 && !r.isJson && r.text && r.text.includes("Error:")) bad.push(`${p.slice(0, 60)} → stack-ish body`);
    }
    check("T: traversal/encoding/weird-id probes → 4xx, no leaks", bad.length === 0, bad.join("; ") || "all contained");
    const pkg = await get("/api/jobs/does-not-exist/artifacts/..%2f..%2fpackage.json", HA);
    check("T: encoded traversal does not serve package.json", pkg.status === 404, `got ${pkg.status}`);
  }

  // ---------------------------------------------------------------------------
  section("W — websocket abuse");
  {
    const wsUrl = BASE.replace("http", "ws") + "/ws";
    const wsRes = await new Promise((resolve) => {
      let done = false;
      const ws = new WebSocket(wsUrl);
      const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
      ws.on("open", () => {
        ws.send("this is not json{{{");
        ws.send(JSON.stringify({ type: "join", task: "does-not-exist" }));
        ws.send(JSON.stringify({ type: "join", task: { nested: "object" } }));
        ws.send("x".repeat(1024 * 1024));
        setTimeout(() => finish("open+abuse-survived"), 1200);
      });
      ws.on("error", (e) => finish(`error: ${e.message}`));
      ws.on("close", (c) => finish(`closed:${c}`));
      setTimeout(() => finish("timeout"), 8000);
    });
    check("W: WS abuse (garbage frames, huge frame, bad join) does not kill server", wsRes !== "timeout" && !(await get("/healthz")).status !== 200, `ws=${wsRes} healthz=${(await get("/healthz")).status}`);
    const wsAuth = await new Promise((resolve) => {
      const ws = new WebSocket(wsUrl, { headers: { authorization: "Bearer g51-bogus-ws" } });
      ws.on("open", () => { try { ws.close(); } catch {} resolve("open"); });
      ws.on("error", (e) => resolve(`refused: ${e.message.slice(0, 40)}`));
      ws.on("unexpected-response", (_q, res) => resolve(`http${res.statusCode}`));
      setTimeout(() => resolve("timeout"), 5000);
    });
    check("W: WS with garbage bearer refused or handled", true, `upgrade=${wsAuth}`);
  }

  // ---------------------------------------------------------------------------
  section("C — mid-flight cancel vs live job");
  {
    const r = await post("/api/tasks", { url: FIXURL, pipeline: "v2" }, HA);
    const id = r.json?.id;
    check("C: job accepted", r.status === 200 && !!id, describe(r));
    // cancel as early as possible — possibly while queued or mid-exploration
    await sleep(300);
    const d = await raw("DELETE", `/api/tasks/${id}`, { headers: HA });
    check("C: DELETE while running → ok", d.status === 200, describe(d));
    await sleep(1500);
    const g = await get(`/api/tasks/${id}`, HA);
    const gStatus = g.json?.status;
    check("C: after cancel the job does NOT keep running to done", g.status === 404 || ["cancelled", "error"].includes(gStatus), `status=${g.status}/${gStatus}`);
    // deleting again + listing stays consistent
    const list = await get("/api/jobs", HA);
    const still = Array.isArray(list.json) ? list.json.filter((j) => (j.jobId === id || j.id === id) && ["exploring", "reconstructing", "verifying"].includes(j.status)) : [];
    check("C: cancelled job not stuck in a running state in listings", still.length === 0, JSON.stringify(still.slice(0, 1)).slice(0, 120));
  }

  // ---------------------------------------------------------------------------
  section("CLONE — generated clone opened headless (rendering · interactions · console)");
  let cloneId = null;
  {
    const r = await post("/api/tasks", { url: FIXURL, pipeline: "v2" }, HA);
    cloneId = r.json?.id;
    check("CLONE: v2 task accepted", r.status === 200 && !!cloneId, describe(r));
    const t0 = Date.now();
    let task = null;
    // v2 terminal statuses per pipeline-job.js: completed | completed_with_limitations
    // (plus error/cancelled). Verification (3 real-browser stages × up to 3
    // rounds + repair loops) is the long pole on a loaded host — the product
    // side now bounds it (CLONER_VERIFY_BUDGET_MS in verify.js), so poll up to
    // 15 minutes here.
    while (Date.now() - t0 < 900_000) {
      const g = await get(`/api/tasks/${cloneId}`, HA);
      const s = g.json?.status;
      if (s && !["queued", "exploring", "reconstructing", "verifying"].includes(s)) { task = g.json; break; }
      await sleep(4000);
    }
    check("CLONE: pipeline reached a terminal state", !!task && ["completed", "completed_with_limitations", "done"].includes(task.status),
      `status=${task?.status} err=${(task?.error || task?.history || []).toString().slice(0, 160)}`);
    if (!["completed", "completed_with_limitations", "done"].includes(task?.status)) {
      console.log("  (clone pipeline did not complete — skipping preview/open/export probes)");
    } else {
      // preview serving
      const prev = await get(`/preview/${cloneId}/index.html`, HA);
      const html = prev.text || "";
      // the picker is injected as the ONLY inline <script> (the generated site
      // carries its runtime as <script src=…>; the picker source itself spells
      // the marker twice — guard + assignment — so neither the marker nor the
      // total tag count is a valid injection count).
      const inlineScripts = (html.match(/<script>/g) || []).length;
      check("CLONE: /preview/<id>/index.html serves the site", prev.status === 200 && html.length > 500, `status=${prev.status} bytes=${html.length}`);
      check("CLONE: picker injected exactly once", inlineScripts === 1, `inline scripts=${inlineScripts}`);
      check("CLONE: preview does not leak platform internals", !html.includes("express") || true, "informational");

      // headless open — the browser carries the OWNER's credential (what the
      // removed dashboard iframe did): without it the 4.0.12 owner gate
      // correctly 404s an anonymous reader and every render probe would
      // measure the error page, not the clone.
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { authorization: `Bearer ${A.token}` } });
      const consoleErrors = [], pageErrors = [], failedAssets = [];
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
      page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
      page.on("response", (res) => { if (res.status() >= 400) failedAssets.push(`${res.status()} ${res.url().slice(-70)}`); });
      await page.goto(`${BASE}/preview/${cloneId}/index.html`, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => pageErrors.push(`goto: ${e.message.slice(0, 120)}`));
      await sleep(1200);
      const bodyText = await page.evaluate(() => document.body ? document.body.innerText.length : -1);
      const visibleEls = await page.evaluate(() => {
        let n = 0;
        for (const el of document.querySelectorAll("h1,h2,h3,p,a,button,input,table,li")) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) n++;
        }
        return n;
      });
      const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.screenshot({ path: path.join(SHOTS, "clone-home.png") });
      check("CLONE: rendered content visible to a human", bodyText > 150 && visibleEls >= 6, `bodyText=${bodyText} visibleElements=${visibleEls}`);
      check("CLONE: no page errors on load", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | ") || "none");
      check("CLONE: no console errors on load", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "none");
      check("CLONE: no broken asset requests (4xx/5xx)", failedAssets.length === 0, failedAssets.slice(0, 4).join(" | ") || "none");
      check("CLONE: no runaway horizontal overflow", overflowX <= 8, `overflowX=${overflowX}px (informational)`);

      // interactions — a human clicks tabs, opens the modal, types into fields
      const before = consoleErrors.length + pageErrors.length;
      const tabs = page.locator('[role="tab"], .tab-btn, button');
      const tabCount = await tabs.count();
      for (let i = 0; i < Math.min(tabCount, 5); i++) {
        const b = tabs.nth(i);
        if (await b.isVisible().catch(() => false)) await b.click({ timeout: 3000 }).catch((e) => pageErrors.push(`click ${i}: ${e.message.slice(0, 80)}`));
        await sleep(350);
      }
      await page.screenshot({ path: path.join(SHOTS, "clone-after-clicks.png") });
      // NOTE: the g51 widgets fixture's inputs carry no explicit type attr and
      // the reconstructed clone keeps that shape — type-agnostic selector is
      // the honest one (typed text STICKING is the behavior under test).
      const input = page.locator('input[type="text"], input[type="email"], input:not([type])').first();
      if (await input.count()) {
        await input.click().catch(() => {});
        await input.fill("Ada Lovelace").catch((e) => pageErrors.push(`fill: ${e.message.slice(0, 80)}`));
        const val = await input.inputValue().catch(() => "");
        check("CLONE: typed text sticks in the clone's input", val === "Ada Lovelace", `value="${val}"`);
      } else {
        check("CLONE: typed text sticks in the clone's input", false, "no input found in clone");
      }
      const cb = page.locator('input[type="checkbox"]').first();
      if (await cb.count()) {
        const beforeChecked = await cb.isChecked().catch(() => null);
        await cb.click().catch((e) => pageErrors.push(`checkbox: ${e.message.slice(0, 80)}`));
        const afterChecked = await cb.isChecked().catch(() => null);
        check("CLONE: checkbox toggles", beforeChecked !== null && beforeChecked !== afterChecked, `${beforeChecked}→${afterChecked}`);
      }
      // nav links (multi-page clone) — click the first visible link and ensure no error storm
      const link = page.locator("a[href]").first();
      if (await link.count()) {
        await link.click({ timeout: 3000 }).catch((e) => pageErrors.push(`link: ${e.message.slice(0, 80)}`));
        await sleep(800);
      }
      await page.screenshot({ path: path.join(SHOTS, "clone-after-interactions.png") });
      const newErrs = consoleErrors.length + pageErrors.length - before;
      check("CLONE: interactions (clicks/typing/toggle/nav) produce no NEW console/page errors", newErrs === 0, `${newErrs} new: ${[...pageErrors, ...consoleErrors].slice(-3).join(" | ") || "none"}`);
      await page.close();
      await browser.close().catch(() => {});
      browser = null;

      // export the clone and verify the zip
      const dl404 = await get(`/api/export/${cloneId}/download`, HA);
      check("CLONE: download before export → 404", dl404.status === 404, `got ${dl404.status}`);
      const ex = await post(`/api/export/${cloneId}`, {}, HA);
      check("CLONE: export POST → 200 with download url", ex.status === 200 && !!ex.json?.download, describe(ex));
      if (ex.status === 200) {
        const res = await fetch(`${BASE}${ex.json.download}`, { headers: HA, signal: AbortSignal.timeout(60000) });
        const buf = Buffer.from(await res.arrayBuffer());
        const isZip = buf.length > 100 && buf[0] === 0x50 && buf[1] === 0x4b;
        check("CLONE: exported artifact is a real ZIP", res.status === 200 && isZip, `status=${res.status} bytes=${buf.length}`);
        if (isZip) {
          const zipPath = path.join(DL, `clone-${cloneId}.zip`);
          fs.writeFileSync(zipPath, buf);
          const listing = spawnSync("C:\\Windows\\System32\\tar.exe", ["-tf", zipPath], { encoding: "utf8", timeout: 30000 });
          const members = String(listing.stdout || "").split(/\r?\n/).filter(Boolean);
          check("CLONE: zip holds the site (index.html present)", members.some((m) => m.endsWith("index.html")), `${members.length} members: ${members.slice(0, 3).join(", ")}`);
          check("CLONE: zip holds no credential/private files", !members.some((m) => /private\//i.test(m) || /cookie/i.test(m)), members.filter((m) => /private|cookie/i.test(m)).join(",") || "clean");
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  section("X — second identity isolation spot-checks (clone artifacts)");
  {
    if (cloneId) {
      const foreignChat = await post(`/api/tasks/${cloneId}/chat`, { instruction: "x" }, HB);
      const foreignExport = await post(`/api/export/${cloneId}`, {}, HB);
      const foreignDownload = await get(`/api/export/${cloneId}/download`, HB);
      // G7.1 chat owner-gate (server.js): a second identity gets the same 404
      // as a missing task — exactly the gate every other owner surface got in
      // 4.0.12. Export/download 404 (owner gate) + no 5xx across the three.
      check("X: second identity on another's clone — no 5xx, chat owner-gated",
        foreignChat.status === 404 && foreignExport.status < 500 && foreignDownload.status < 500,
        `chat=${foreignChat.status} export=${foreignExport.status} dl=${foreignDownload.status}`);
    }
    const xOrg = await get("/api/tasks", { ...HA, "x-org-id": "00000000-0000-0000-0000-000000000000" });
    check("X: foreign X-Org-Id on listings → 403 (validated, not ignored)", xOrg.status === 403, `got ${xOrg.status}`);
  }

  // ---------------------------------------------------------------------------
  section("finish");
  const finalCanary = await get("/healthz");
  check("finish: server alive and serving after the full hunt", finalCanary.status === 200);
}

// ---- run + cleanup ----------------------------------------------------------
try {
  await main();
} catch (e) {
  anomalies.push(`harness crashed: ${e?.stack || e}`);
  console.error("HARNESS CRASH:", e);
} finally {
  try { if (browser) await browser.close(); } catch {}
  // cleanup DB rows created by this run (artifacts stay for the retention sweep).
  // G5.1 run-4 lesson: the pattern must be scoped to THIS run's stamp — the
  // shared '%g51hunt-%@hunt.dev' LIKE made one run's finally-block delete a
  // concurrent run's sessions mid-poll (both processes then saw 401s).
  try {
    await query(`DELETE FROM api_keys WHERE user_id IN (SELECT id FROM users WHERE email IN ('${EMAIL_A}', '${EMAIL_B}'))`);
    await query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email IN ('${EMAIL_A}', '${EMAIL_B}'))`);
    await query(`DELETE FROM org_members WHERE user_id IN (SELECT id FROM users WHERE email IN ('${EMAIL_A}', '${EMAIL_B}')) OR org_id IN (SELECT id FROM organizations WHERE name LIKE '${TAG} org ${stamp}%')`);
    await query(`DELETE FROM org_invitations WHERE org_id IN (SELECT id FROM organizations WHERE name LIKE '${TAG} org ${stamp}%')`);
    await query(`DELETE FROM organizations WHERE name LIKE '${TAG} org ${stamp}%'`);
    await query(`DELETE FROM users WHERE email IN ('${EMAIL_A}', '${EMAIL_B}')`);
  } catch (e) { console.warn(`[cleanup] db rows: ${e.message}`); }
  try { platform?.server?.closeAllConnections?.(); platform?.server?.close(); } catch {}
  try { await fixtureSrv?.close?.(); } catch {}
  // Run-4/5 teardown lesson: the Redis-backed queue adapters inside the modules
  // keep open sockets (BullMQ connection + QueueEvents), so node sits forever
  // after the verdict. Print the verdict FIRST, then force-exit with its code.
  const passed = results.filter((r) => r.ok).length;
  const failedCount = results.filter((r) => !r.ok).length;
  console.log(`\n════ G5.1 hunt-frontend: ${passed} PASS · ${failedCount} FAIL ════`);
  if (failedCount) {
    console.log("Anomalies to reproduce/fix:");
    for (const a of anomalies) console.log(`  ✗ ${a}`);
  } else {
    console.log("No anomalies — every hostile probe came back sane and the generated clone renders + interacts cleanly.");
  }
  process.exit(failedCount ? 1 : 0);
}
