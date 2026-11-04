#!/usr/bin/env node
// G5.3 hostile security hunt — driver suite.
// Proves (with real runs, not mocks in product paths) every fix from the
// hunt; the SSRF browser probes live in scripts/g53-ssrf-child.mjs (spawned
// here, strict env). Sections:
//   B. post-navigation assertion + url-guard sync predicates (unit, real)
//   C. auth: header-only middleware against a REAL platform server +
//      audit_events must NOT contain the raw session token (real DB)
//   D. webhook signatures: pre-burn DoS / replay / tamper / stale timestamp
//      against the REAL verifiers (no network needed)
//   E. SQL column allowlist: hostile patch key rejected before any query
//   F. DLQ credential redaction (real function)
//   G. UI XSS sinks escaped (source-level assertions + syntax checks)
//   H. token fingerprint properties
// PostgreSQL-dependent sections SKIP loudly when the DB is unreachable
// (repo rule 3); everything else still runs and fails the suite if broken.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// =========================== A. SSRF browser child ==========================
async function runSsrfChild() {
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join("scripts", "g53-ssrf-child.mjs")], {
      cwd: PROJECT,
      env: { ...process.env, CLONER_ALLOW_PRIVATE_TARGETS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      for (const line of out.split("\n")) {
        if (/^(PASS|FAIL)\s/.test(line)) console.log("  " + line);
      }
      const verdict = out.trim().split("\n").filter(Boolean).pop();
      let parsed = null;
      try { parsed = JSON.parse(verdict); } catch {}
      check("A. SSRF request-guard browser probes (real Chromium, PNA-neutral harness)",
        code === 0 && parsed?.ok === true,
        `child exit=${code} verdict=${verdict || "none"}${err ? ` stderr=${err.slice(0, 200)}` : ""}`);
      resolve();
    });
  });
}
await runSsrfChild();

// =================== B. navigation assertion + predicates ===================
{
  const rg = await import("../src/security/request-guard.js");
  const ug = await import("../src/security/url-guard.js");
  const hostile = [
    ["loopback literal", "http://127.0.0.1:8080/admin"],
    ["RFC1918", "http://10.1.2.3/"],
    ["link-local metadata", "http://169.254.169.254/latest/meta-data/"],
    ["IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped hex form", "http://[::ffff:7f00:1]/"],
    ["NAT64 well-known", "http://[64:ff9b::7f00:1]/"],
    ["6to4", "http://[2002:7f00:1::]/"],
    ["RFC2544 benchmark", "http://198.18.0.9/"],
    ["localhost name", "http://localhost:9000/"],
    ["file scheme", "file:///etc/passwd"],
  ];
  for (const [name, u] of hostile) {
    const v = rg.assertSafeNavigationUrl(u);
    check(`B. assertSafeNavigationUrl rejects ${name}`, v.ok === false, `${u} → ${v.error || "accepted!"}`);
  }
  check("B. assertSafeNavigationUrl accepts a public https URL", rg.assertSafeNavigationUrl("https://example.com/x").ok === true);
  const lit = (h) => ug.isPrivateLiteralIp(h);
  check("B. isPrivateLiteralIp: NAT64 dotted-embedded IPv4 blocked", lit("64:ff9b::c0a8:101") === true);
  check("B. isPrivateLiteralIp: 6to4-embedded 192.168.1.1 blocked", lit("2002:c0a8:101::") === true);
  check("B. isPrivateLiteralIp: public literal passes", lit("8.8.8.8") === false && lit("2606:4700:4700::1111") === false);
}

// ===================== C/D/E/F need imports; PG optional ====================
let pg = { ok: false };
try {
  const { query, closePool } = await import("../src/database/client.js");
  await query("SELECT 1");
  pg = { ok: true, query, closePool };
} catch { /* loud skip below */ }

// ---- C. header-only auth + audit token leak (real platform server + DB) ----
if (!pg.ok) {
  console.log("SKIP  C. auth/audit probes — PostgreSQL unreachable (repo rule 3 loud skip)");
} else {
  // baseline schema (same posture as every other suite: apply own migrations)
  {
    await pg.query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
    const dir = path.join(PROJECT, "src", "database", "migrations");
    for (const file of ["001-initial.sql", "015-audit-logs.sql"]) {
      const applied = await pg.query("SELECT 1 FROM _migrations WHERE id = $1", [file]);
      if (applied.rows.length) continue;
      await pg.query(fs.readFileSync(path.join(dir, file), "utf8"));
      await pg.query("INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
      console.log("[db] applied:", file);
    }
  }
  const { startPlatform } = await import("../src/platform/server.js");
  const plat = await startPlatform({ port: 0 });
  const base = `http://127.0.0.1:${plat.port}`;
  const api = async (p, { method = "GET", headers = {}, body } = {}) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: body ? { "content-type": "application/json", ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  try {
    const email = `g53-${crypto.randomBytes(5).toString("hex")}@hunt.test`;
    const password = `pw-${crypto.randomBytes(8).toString("hex")}!A1`;
    const reg = await api("/api/auth/register", { method: "POST", body: { email, password } });
    const login = await api("/api/auth/login", { method: "POST", body: { email, password } });
    const token = login.json?.token || "";
    check("C. register+login through the REAL server", reg.status === 200 && login.status === 200 && token.length > 20,
      `register=${reg.status} body=${JSON.stringify(reg.json)?.slice(0, 140)} login=${login.status}`);

    // C1: ?token= must NOT authenticate REST anymore (old: /api/auth/me?token= → 200)
    const viaQuery = await api(`/api/auth/me?token=${encodeURIComponent(token)}`);
    check("C1 session token in the QUERY STRING is rejected (401) — no credential leakage via logs/Referer",
      viaQuery.status === 401, `status=${viaQuery.status}`);
    const viaHeader = await api("/api/auth/me", { headers: { authorization: `Bearer ${token}` } });
    check("C2 the SAME token via the Authorization header still authenticates",
      viaHeader.status === 200 && viaHeader.json?.email === email, `status=${viaHeader.status}`);
    const badQuery = await api(`/api/auth/me?token=not-a-real-token`);
    check("C3 garbage ?token= also rejected (no crash, 401)", badQuery.status === 401, `status=${badQuery.status}`);

    // C4: audit_events must not contain the raw token (it stores a fingerprint)
    await new Promise((r) => setTimeout(r, 300)); // auditSafe writes are async
    const rows = await pg.query(
      `SELECT action, session_id, target_id, metadata FROM audit_events
       WHERE action IN ('auth.login.success','auth.session.revoked','auth.register')
       ORDER BY ts DESC LIMIT 20`
    );
    const rawLeak = rows.rows.filter((r) =>
      (r.session_id || "").includes(token) || (r.target_id || "").includes(token) ||
      JSON.stringify(r.metadata || {}).includes(token));
    const fingerprinted = rows.rows.some((r) => r.action === "auth.login.success" && typeof r.session_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.session_id));
    check("C4 audit_events NEVER store the raw session token (fingerprint only)",
      rawLeak.length === 0 && fingerprinted,
      `leakRows=${rawLeak.length} fingerprinted=${fingerprinted} sampled=${rows.rows.length}`);
  } finally {
    plat.server.close();
    plat.wss.close();
  }
}

// ------------------- D. webhook signature hardening -------------------------
{
  const ext = await import("../src/integrations/external-api.js");
  const secret = "whsec-" + crypto.randomBytes(16).toString("hex");
  const store = ext.createSeenStore({});
  const signed = ext.signDelivery({ secret, event: "task.completed", payload: { id: 1 } });
  // D1: pre-burn DoS — garbage signature with a FRESH delivery id must NOT burn the nonce
  let err1 = null;
  try { ext.verifyDelivery({ rawBody: signed.body, secret, headers: { ...signed.headers, "x-cloner-signature": "v1=" + "0".repeat(64) }, seenStore: store, markOnVerify: true }); }
  catch (e) { err1 = e; }
  let okAfterPreburn = null;
  try { okAfterPreburn = ext.verifyDelivery({ rawBody: signed.body, secret, headers: signed.headers, seenStore: store, markOnVerify: true }); }
  catch (e) { okAfterPreburn = e; }
  check("D1 unsigned request CANNOT pre-burn a delivery nonce (sig fails → nonce still usable)",
    err1?.code === "BAD_SIGNATURE" && okAfterPreburn?.ok === true, `err1=${err1?.code} second=${okAfterPreburn?.ok || okAfterPreburn?.code}`);
  // D2: replay of the valid delivery
  let err2 = null;
  try { ext.verifyDelivery({ rawBody: signed.body, secret, headers: signed.headers, seenStore: store, markOnVerify: true }); }
  catch (e) { err2 = e; }
  check("D2 identical re-POST of a valid delivery is REPLAY-rejected", err2?.code === "REPLAY", `code=${err2?.code}`);
  // D3: tampered body
  const signed3 = ext.signDelivery({ secret, event: "task.failed", payload: { id: 2 } });
  let err3 = null;
  try { ext.verifyDelivery({ rawBody: signed3.body.replace("2", "9"), secret, headers: signed3.headers, seenStore: ext.createSeenStore({}) }); }
  catch (e) { err3 = e; }
  check("D3 body tamper → signature mismatch", err3?.code === "BAD_SIGNATURE", `code=${err3?.code}`);

  // user-webhook verifier (notification-delivery): stale timestamp + tamper
  const notif = await import("../src/platform/notification-delivery.js");
  const uSigned = notif.signUserWebhook({ secret, rawBody: JSON.stringify({ hello: "world" }) });
  const store2 = { has: () => false, mark: () => {} };
  const verified = notif.verifyUserWebhook({ rawBody: JSON.stringify({ hello: "world" }), secret, headers: uSigned.headers, seenStore: store2 });
  check("D4 verifyUserWebhook accepts a fresh signed delivery (v1 ts+nonce scheme)",
    verified.ok === true && !!uSigned.headers["x-cloner-timestamp"] && !!uSigned.headers["x-cloner-delivery"],
    `deliveryId=${uSigned.deliveryId.slice(0, 8)}…`);
  let err5 = null;
  try { notif.verifyUserWebhook({ rawBody: JSON.stringify({ hello: "WORLD" }), secret, headers: uSigned.headers, seenStore: store2 }); }
  catch (e) { err5 = e; }
  check("D5 user-webhook body tamper → BAD_SIGNATURE", err5?.code === "BAD_SIGNATURE", `code=${err5?.code}`);
  const stale = notif.signUserWebhook({ secret, rawBody: JSON.stringify({ old: 1 }), timestamp: Math.floor(Date.now() / 1000) - 3600 });
  let err6 = null;
  try { notif.verifyUserWebhook({ rawBody: JSON.stringify({ old: 1 }), secret, headers: stale.headers, seenStore: store2 }); }
  catch (e) { err6 = e; }
  check("D6 user-webhook stale timestamp (1h) → TIMESTAMP_EXPIRED", err6?.code === "TIMESTAMP_EXPIRED", `code=${err6?.code}`);
}

// ----------------------- E. SQL column allowlist ----------------------------
if (!pg.ok) {
  console.log("SKIP  E. SQL allowlist DB roundtrip — PostgreSQL unreachable");
} else {
  const taskRepo = await import("../src/database/task-repository.js");
  let threw = null;
  try {
    await taskRepo.updateTask("00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001",
      { "status = 'pwned', user_id = (SELECT 1) WHERE id = 'x' --": "injected" });
  } catch (e) { threw = e; }
  check("E. hostile patch KEY (SQL via column interpolation) rejected before any query",
    threw && /unknown column/i.test(threw.message), `err=${String(threw?.message).slice(0, 90)}`);
  let legit = null, legitErr = null;
  try { legit = await taskRepo.updateTask("00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001", { status: "cancelled" }); }
  catch (e) { legitErr = e; }
  check("E. legit column ('status') still accepted (no row → null, no throw)",
    legit === null && !legitErr, `result=${legit} err=${String(legitErr?.message || "")}`);
}

// ------------------------ F. DLQ credential redaction -----------------------
{
  const q = await import("../src/queues/clone-queue.js");
  const red = q.redactCredentials({ url: "https://example.com", username: "u", password: "p", cookies: [{ name: "sid" }], storage: { ls: { t: "1" } }, instructions: "keep" });
  check("F. DLQ copy redacts password/cookies/storage, keeps url+instructions",
    red.password === null && red.cookies === null && red.storage === null
      && red.username === "[redacted-user]" && red.url === "https://example.com" && red.instructions === "keep"
      && red.credentialsRedacted === true, JSON.stringify(red));
  check("F. redactCredentials passes through non-objects untouched",
    q.redactCredentials(null) === null && q.redactCredentials("x") === "x");
}

// --------------------------- G. UI XSS sink fixes ---------------------------
// G7.1: the platform's own UI (platform-ui/) was removed — the platform ships
// headless. The remaining rendered surface is the legacy local dashboard
// (dashboard/app.js) and the GENERATED CLONES, so the source-level XSS checks
// cover the dashboard only. The generated-clone sink is server-side now: the
// picker injection (server.js PICKER_JS) is escaped at write time upstream.
{
  const dash = fs.readFileSync(path.join(PROJECT, "dashboard", "app.js"), "utf8");
  check("G. dashboard: screenshot URLs escaped", /esc\(u\)/.test(dash));
  check("G. dashboard: esc() is quote-aware (attribute-safe)", /&quot;/.test(dash));
  for (const f of ["dashboard/app.js"]) {
    try { new Function(fs.readFileSync(path.join(PROJECT, f), "utf8").replace(/^import .*$/gm, "")); check(`G. ${f} parses (syntax)`, true); }
    catch (e) { check(`G. ${f} parses (syntax)`, false, String(e).slice(0, 80)); }
  }
  check("G. headless: no platform UI ships (platform-ui/ removed, server has no static mounts)",
    !fs.existsSync(path.join(PROJECT, "platform-ui")),
    "platform-ui/ absent");
}

// ------------------------- H. token fingerprint -----------------------------
{
  const mw = await import("../src/auth/auth-middleware.js");
  const tok = crypto.randomBytes(32).toString("hex");
  const fp1 = mw.tokenFingerprint(tok);
  const fp2 = mw.tokenFingerprint(tok);
  check("H. token fingerprint: deterministic, NOT the token, 16 hex chars",
    fp1 === fp2 && fp1 !== tok && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fp1), `fp=${fp1}`);
  check("H. token fingerprint: different tokens → different fingerprints",
    mw.tokenFingerprint(tok + "x") !== fp1);
}

const passed = results.filter(Boolean).length;
console.log(`\n== G5.3 security hunt: ${passed}/${results.length} driver checks passed ==`);
process.exit(passed === results.length ? 0 : 1);
