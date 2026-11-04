#!/usr/bin/env node
// Ad provider core REAL-integration suite (task 4.5.4 ad-provider-core).
//
// What this suite proves, and HOW:
//   • PRODUCT PATH IS REAL: src/monetization/ad-providers.js + ad-slots.js
//     render the OFFICIAL Monetag / Adsterra tags from env zone ids and probe
//     the real loader URLs over HTTP. This suite points the loader envs at a
//     LOCAL REMOTE-END SIMULATOR (the only mock in this file — a local http
//     server standing in for the networks' CDN edges, per repo rule 3).
//     Product code is exercised unmodified: same builders, same probes,
//     same fallback chain, same DB writes.
//   • FALLBACK CHAIN IS REAL: primary failure → the other network serves, the
//     rotation persists (round-robin on failure), and vice-versa primaries
//     work in both directions. Both networks down → ZERO ad output with an
//     honest log line, no crash.
//   • POLICY GUARDRAILS ARE ENFORCED: greps over the product sources prove
//     there is NO traffic-generation code of any kind (no timer-driven
//     re-rendering, no synthetic interactions, no fabricated events), and
//     structural markup checks prove slots never mimic UI controls.
//   • CAPS ARE REAL: frequency capping is enforced against the PostgreSQL
//     serving ledger (fail-closed on ledger outage), configurable via env and
//     the admin settings API.
//   • ENV-ABSENT POSTURE: with no zone envs the product answers with zero ad
//     output + honest logs; nothing crashes.
//   • REAL NETWORK SMOKE: when the owner's REAL zone envs are present the
//     suite probes the real official loader once per configured network.
//     Without them it prints a loud SKIP and continues.
//
// Exit: 0 all pass, 1 any fail. PostgreSQL unreachable → whole-suite SKIP
// (repo rule 3; caps + delivery ledger need the database).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

// capture the operator's REAL ad env BEFORE the simulator overrides it
const REAL_ENV = {};
for (const key of Object.keys(process.env)) {
  if (/^(MONETAG_ZONE_ID_|ADSTERRA_ZONE_ID_|ADSTERRA_ZONE_KEY_|ADSTERRA_LOADER_DOMAIN|MONETAG_LOADER_URL|AD_PROVIDER_PRIMARY|PGPORT)/.test(key)) {
    REAL_ENV[key] = process.env[key];
  }
}
const had = (k) => Object.prototype.hasOwnProperty.call(REAL_ENV, k);
const restoreEnv = (k) => {
  if (had(k)) process.env[k] = REAL_ENV[k];
  else delete process.env[k];
};

const { query, closePool } = await import("../src/database/client.js");
const { default: express } = await import("express");
const { registerUser, loginUser } = await import("../src/auth/auth-service.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (title) => console.log(`\n── ${title} ${"─".repeat(Math.max(4, 66 - title.length))}`);

// ---- postgres reachability (SKIP posture per repo rule 3) -------------------
try {
  await query("SELECT 1");
} catch (e) {
  console.log("SKIP  ad-providers suite — PostgreSQL unreachable (" + String(e?.message || e).split("\n")[0] + ")");
  console.log("SKIP  hint: docker compose up -d postgres, then re-run");
  process.exit(0);
}

// ---- own-schema boot (integrator owns the full ordered set; we ensure ours) --
async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const users = await query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'users'`);
  if (!users.rows.length) {
    const sql = fs.readFileSync(path.join(PROJECT, "src/database/migrations/001-initial.sql"), "utf8");
    await query(sql);
    await query(`INSERT INTO _migrations (id) VALUES ('001-initial.sql') ON CONFLICT DO NOTHING`);
  }
}
await ensureSchema();

// ===========================================================================
// local remote-end simulator — stands in for the networks' loader CDNs
// (TEST FILE ONLY; product code never contains or imports this)
// ===========================================================================
const sim = { server: null, port: null, calls: [] };
const simCount = (prefix) => sim.calls.filter((p) => p.startsWith(prefix)).length;

const SIM_BASE = await new Promise((resolve) => {
  sim.server = http.createServer((req, res) => {
    sim.calls.push(req.url.split("?")[0]);
    const url = req.url.split("?")[0];
    const respond = (status, body) => {
      res.writeHead(status, { "content-type": "application/javascript" });
      res.end(body);
    };
    if (url === "/monetag-ok/tag.min.js") return respond(200, "/* monetag official loader (simulated) */");
    if (url === "/monetag-down/tag.min.js") return respond(503, "simulated outage");
    if (url === "/monetag-slow/tag.min.js") {
      return setTimeout(() => respond(200, "/* slow loader */"), 1500);
    }
    if (url === "/adsterra-ok/z1/invoke.js") return respond(200, "/* adsterra official invoke (simulated) */");
    if (url === "/adsterra-down/z1/invoke.js") return respond(503, "simulated outage");
    if (url === "/adsterra-slow/z1/invoke.js") {
      return setTimeout(() => respond(200, "/* slow invoke */"), 1500);
    }
    respond(404, "not found");
  });
  sim.server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${sim.server.address().port}`));
});

// ---- env helpers (product code reads env per call, so tests can toggle) ----
const ZONE_KEYS = [
  "MONETAG_ZONE_ID_HEADER", "MONETAG_ZONE_ID_MID_CONTENT", "MONETAG_ZONE_ID_SIDEBAR", "MONETAG_ZONE_ID_FOOTER",
  "ADSTERRA_ZONE_ID_HEADER", "ADSTERRA_ZONE_ID_MID_CONTENT", "ADSTERRA_ZONE_ID_SIDEBAR", "ADSTERRA_ZONE_ID_FOOTER",
  "ADSTERRA_ZONE_KEY_HEADER", "ADSTERRA_ZONE_KEY_SIDEBAR", "ADSTERRA_LOADER_DOMAIN",
];
function clearZoneEnvs() {
  for (const k of Object.keys(process.env)) {
    if (/^(MONETAG_ZONE_ID_|ADSTERRA_ZONE_ID_|ADSTERRA_ZONE_KEY_|ADSTERRA_LOADER_DOMAIN)/.test(k)) delete process.env[k];
  }
}
const setEnv = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };

// default test posture: fast probes, no cache, both networks healthy
function healthyEnv() {
  clearZoneEnvs();
  setEnv("MONETAG_LOADER_URL", `${SIM_BASE}/monetag-ok/tag.min.js`);
  setEnv("MONETAG_ZONE_ID_HEADER", "1110001");
  setEnv("MONETAG_ZONE_ID_MID_CONTENT", "1110002");
  setEnv("MONETAG_ZONE_ID_SIDEBAR", "1110003");
  setEnv("MONETAG_ZONE_ID_FOOTER", "1110004");
  setEnv("ADSTERRA_ZONE_ID_HEADER", `${SIM_BASE}/adsterra-ok/z1/invoke.js`);
  setEnv("ADSTERRA_ZONE_ID_MID_CONTENT", `${SIM_BASE}/adsterra-ok/z1/invoke.js`);
  setEnv("ADSTERRA_ZONE_ID_SIDEBAR", `${SIM_BASE}/adsterra-ok/z1/invoke.js`);
  setEnv("ADSTERRA_ZONE_ID_FOOTER", `${SIM_BASE}/adsterra-ok/z1/invoke.js`);
  setEnv("AD_PROBE_TIMEOUT_MS", "300");
  setEnv("AD_PROBE_CACHE_MS", "0");
  setEnv("AD_PROVIDER_PRIMARY", "monetag");
}

// capture [ads] console lines for honest-log assertions (async-safe: the hook
// stays installed until the awaited body finishes; returns { value, lines })
async function captureAdLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[ads]")) lines.push(line);
    orig(...args);
  };
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.log = orig;
  }
}

// ---- import PRODUCT modules (after env posture is set) ----------------------
healthyEnv();
const { SLOT_POSITIONS, buildOfficialTag, resolveAd, probeProvider, providerHealthState, resetProviderState, primaryProviderId } =
  await import("../src/monetization/ad-providers.js");
const {
  adsRouter, ADS_CSS, buildPageMarkup, resolveSlotForRender, ensureAdSchema,
  hashSessionToken, getSlotSettings,
} = await import("../src/monetization/ad-slots.js");
await ensureAdSchema();

// fresh state per run
await query("TRUNCATE ad_slot_settings");
await query("TRUNCATE ad_serving_events");
await query("TRUNCATE ad_delivery_log");

// users for the settings/status API posture
const stamp = Date.now();
const adminEmail = `ad-admin-${stamp}@test.local`;
const userEmail = `ad-user-${stamp}@test.local`;
const admin = await registerUser(adminEmail, "ad-suite-password-1");
const user = await registerUser(userEmail, "ad-suite-password-2");
await query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
const adminTok = (await loginUser(adminEmail, "ad-suite-password-1")).token;
const userTok = (await loginUser(userEmail, "ad-suite-password-2")).token;
const auth = (tok) => ({ authorization: `Bearer ${tok}` });

// HTTP app with the REAL router mounted exactly as documented
const app = express();
app.use("/api/ads", adsRouter());
const httpServer = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const APP_BASE = `http://127.0.0.1:${httpServer.address().port}`;

async function getPage(pageKey, { cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie.includes("=") ? cookie : `cloner_ad_sid=${cookie}`;
  const resp = await fetch(`${APP_BASE}/api/ads/page/${pageKey}`, { headers });
  const setCookie = resp.headers.get("set-cookie");
  const body = await resp.json();
  let sid = cookie;
  if (setCookie) {
    const m = setCookie.match(/cloner_ad_sid=([^;]+)/);
    if (m) sid = m[1];
  }
  return { status: resp.status, body, sid };
}

// ===========================================================================
section("migration 050 — applied for real, idempotent");

{
  const file = path.join(PROJECT, "src/database/migrations/050-ad-settings.sql");
  const sql = fs.readFileSync(file, "utf8");
  let ok1 = true, ok2 = true;
  try { await query(sql); } catch (e) { ok1 = false; console.error(e.message); }
  try { await query(sql); } catch (e) { ok2 = false; console.error(e.message); }
  await query(`INSERT INTO _migrations (id) VALUES ('050-ad-settings.sql') ON CONFLICT DO NOTHING`);
  const recorded = await query(`SELECT 1 FROM _migrations WHERE id='050-ad-settings.sql'`);
  const tables = await query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('ad_slot_settings','ad_serving_events','ad_delivery_log')`);
  check("050 migration applies twice without error (IF NOT EXISTS)", ok1 && ok2);
  check("050 creates all three tables", tables.rows.length === 3, `found ${tables.rows.length}/3`);
  check("050 recorded in _migrations ledger", recorded.rows.length === 1);
}

// ===========================================================================
section("official tag builders — exact network shapes from env zones");

{
  healthyEnv();
  resetProviderState();
  const m = buildOfficialTag("monetag", "header");
  check("monetag tag: official script shape", !!m && m.html.startsWith('<script async="async" data-cfasync="false"') && m.html.includes(`src="${SIM_BASE}/monetag-ok/tag.min.js"`) && m.html.includes('data-zone="1110001"'), m?.html || "null");
  const a = buildOfficialTag("adsterra", "footer");
  check("adsterra tag: invoke.js script + container div", !!a && a.html.includes(`src="${SIM_BASE}/adsterra-ok/z1/invoke.js"`) && a.html.includes('<div id="container-z1"'), a?.html || "null");

  clearZoneEnvs();
  setEnv("ADSTERRA_ZONE_ID_SIDEBAR", "7654321");
  setEnv("ADSTERRA_LOADER_DOMAIN", "profitablecpmrate.com");
  setEnv("ADSTERRA_ZONE_KEY_SIDEBAR", "abc123def");
  const bare = buildOfficialTag("adsterra", "sidebar");
  check("adsterra bare-zone form builds official pl{zone}.{domain}/{key}/invoke.js", !!bare && bare.html.includes("https://pl7654321.profitablecpmrate.com/abc123def/invoke.js") && bare.html.includes('id="container-abc123def"'), bare?.html || "null");

  setEnv("ADSTERRA_ZONE_KEY_SIDEBAR", undefined);
  check("adsterra bare-zone form without key → honest null (no fabricated URL)", buildOfficialTag("adsterra", "sidebar") === null);

  setEnv("MONETAG_ZONE_ID_HEADER", 'x" onerror="alert(1)');
  check("malformed zone value rejected (never reaches markup)", buildOfficialTag("monetag", "header") === null);

  clearZoneEnvs();
  check("unset zone env → null tag (zero output, no crash)", buildOfficialTag("monetag", "header") === null && buildOfficialTag("adsterra", "header") === null);
}

// ===========================================================================
section("env-absent posture — zero ad output + honest log, no crash");

{
  healthyEnv();
  clearZoneEnvs();
  resetProviderState();
  let out = null, threw = null, cap = null;
  try {
    cap = await captureAdLogs(() => resolveSlotForRender("header", { sessionHash: hashSessionToken("anon-absent") }));
    out = cap.value;
  } catch (e) { threw = e; }
  check("env-absent resolve does not crash", threw === null, threw ? String(threw) : "");
  check("env-absent → skipped_not_configured with empty markup", out && out.status === "skipped_not_configured" && out.html === "", out && out.status);
  const log = (cap?.lines || []).join("\n");
  check("env-absent honest log names the exact env vars", log.includes("outcome=not_configured") && log.includes("MONETAG_ZONE_ID_HEADER") && log.includes("ADSTERRA_ZONE_ID_HEADER"), (cap?.lines || [])[0] || "no [ads] log");
  const rows = await query(`SELECT outcome FROM ad_delivery_log WHERE slot_key='header' AND outcome='not_configured'`);
  check("env-absent decision persisted in ad_delivery_log", rows.rows.length >= 1, `${rows.rows.length} rows`);
}

// ===========================================================================
section("fallback chain — monetag primary fails → adsterra serves (round-robin)");

{
  healthyEnv();
  resetProviderState();
  setEnv("MONETAG_LOADER_URL", `${SIM_BASE}/monetag-down/tag.min.js`);
  const r1 = await resolveAd("header");
  check("primary probe fails → fallback provider serves", r1.ok === true && r1.provider === "adsterra", `provider=${r1.provider} attempts=${JSON.stringify(r1.attempts)}`);
  check("failed attempt recorded with HTTP status", r1.attempts.some((a) => a.provider === "monetag" && a.outcome === "probe_failed" && a.status === 503), JSON.stringify(r1.attempts));
  check("health ledger recorded the failure", (providerHealthState().monetag?.consecutiveFailures || 0) >= 1, JSON.stringify(providerHealthState().monetag || {}));
  const monetagHitsAfterR1 = simCount("/monetag-down");
  const r2 = await resolveAd("header");
  check("next resolution STILL leads with the fallback (round-robin memory)", r2.ok === true && r2.provider === "adsterra");
  check("round-robin: failed primary not re-probed while fallback healthy", simCount("/monetag-down") === monetagHitsAfterR1, `monetag-down hits=${simCount("/monetag-down")}`);
}

// ===========================================================================
section("vice versa — adsterra primary fails → monetag serves");

{
  resetProviderState();
  setEnv("AD_PROVIDER_PRIMARY", "adsterra");
  setEnv("MONETAG_LOADER_URL", `${SIM_BASE}/monetag-ok/tag.min.js`);
  clearZoneEnvs();
  setEnv("MONETAG_ZONE_ID_HEADER", "1110001");
  setEnv("ADSTERRA_ZONE_ID_HEADER", `${SIM_BASE}/adsterra-down/z1/invoke.js`);
  const r = await resolveAd("header");
  check("adsterra primary down → monetag serves", r.ok === true && r.provider === "monetag", `provider=${r.provider} attempts=${JSON.stringify(r.attempts)}`);
  check("primaryProviderId honors env", primaryProviderId() === "adsterra");
  const out = await resolveSlotForRender("header", { sessionHash: hashSessionToken("anon-vice") });
  check("render path serves monetag markup after adsterra failure", out.status === "served" && out.provider === "monetag" && out.html.includes('data-zone="1110001"'), out.status);
  setEnv("AD_PROVIDER_PRIMARY", "monetag");
}

// ===========================================================================
section("both networks down — zero output, honest log, clean degradation");

{
  healthyEnv();
  resetProviderState();
  setEnv("MONETAG_LOADER_URL", `${SIM_BASE}/monetag-down/tag.min.js`);
  setEnv("ADSTERRA_ZONE_ID_FOOTER", `${SIM_BASE}/adsterra-down/z1/invoke.js`);
  let out = null, threw = null, cap = null;
  try {
    cap = await captureAdLogs(() => resolveSlotForRender("footer", { sessionHash: hashSessionToken("anon-both-down") }));
    out = cap.value;
  } catch (e) { threw = e; }
  check("both networks down does not crash", threw === null, threw ? String(threw) : "");
  check("both down → skipped_no_provider_available with empty markup", out && out.status === "skipped_no_provider_available" && out.html === "", out && out.status);
  const log = (cap?.lines || []).join("\n");
  check("both-down honest log names both providers and outcomes", log.includes("outcome=no_provider_available") && log.includes("monetag:probe_failed") && log.includes("adsterra:probe_failed"), (cap?.lines || [])[0] || "no [ads] log");
  const pure = await resolveAd("footer");
  check("pure resolution reports all_providers_failed", pure.ok === false && pure.reason === "all_providers_failed" && pure.attempts.length === 2, JSON.stringify(pure.attempts));
}

// ===========================================================================
section("probe cache — a busy page never generates extra network traffic");

{
  healthyEnv();
  resetProviderState();
  setEnv("MONETAG_LOADER_URL", `${SIM_BASE}/monetag-down/tag.min.js`);
  setEnv("ADSTERRA_ZONE_ID_HEADER", `${SIM_BASE}/adsterra-down/z1/invoke.js`);
  setEnv("AD_PROBE_CACHE_MS", "4000");
  const before = simCount("/monetag-down");
  const p1 = await probeProvider("monetag", "header");
  const p2 = await probeProvider("monetag", "header");
  const p3 = await probeProvider("monetag", "header");
  check("first probe really hits the loader", p1.cached === false && p1.healthy === false, `cached=${p1.cached}`);
  check("repeat probes inside the cache window are served from cache", p2.cached === true && p3.cached === true);
  check("cache window: exactly one network request for 3 probes", simCount("/monetag-down") === before + 1, `hits=${simCount("/monetag-down") - before}`);
  const p4 = await probeProvider("monetag", "header", { forceProbe: true });
  check("forceProbe bypasses the cache", p4.cached === false && simCount("/monetag-down") === before + 2);
  setEnv("AD_PROBE_CACHE_MS", "0");
}

// ===========================================================================
section("probe timeout — a hung loader degrades to the fallback");

{
  healthyEnv();
  resetProviderState();
  setEnv("MONETAG_LOADER_URL", `${SIM_BASE}/monetag-slow/tag.min.js`);
  const t0 = Date.now();
  const r = await resolveAd("mid-content");
  const dt = Date.now() - t0;
  check("hung loader → fallback serves", r.ok === true && r.provider === "adsterra", `provider=${r.provider}`);
  check("probe aborted at the configured timeout (300ms), not the loader's 1.5s", dt < 1200, `${dt}ms`);
}

// ===========================================================================
section("HTTP surface — real router, real requests, human-visible markup");

{
  healthyEnv();
  resetProviderState();
  const p1 = await getPage("index");
  check("GET /api/ads/page/index → 200", p1.status === 200);
  check("page carries ALL four slots (header/mid-content/sidebar/footer)", Array.isArray(p1.body.slots) && p1.body.slots.length === 4 && JSON.stringify(p1.body.slots.map((s) => s.key)) === JSON.stringify(SLOT_POSITIONS), p1.body.slots?.map((s) => `${s.key}:${s.status}`).join(","));
  check("session cookie set for anonymous cap identity", typeof p1.sid === "string" && p1.sid.length >= 8, p1.sid);
  const served = p1.body.slots.filter((s) => s.status === "served");
  check("all slots served with both networks healthy", served.length === 4, served.map((s) => s.key).join(","));
  const headerHtml = p1.body.slots.find((s) => s.key === "header").html;
  check("markup wrapper: labelled <aside>, Advertisement label, provider marker", headerHtml.startsWith('<aside class="cloner-ad-slot"') && headerHtml.includes('aria-label="Advertisement"') && headerHtml.includes(">Advertisement</span>") && headerHtml.includes('data-ad-provider="monetag"'), headerHtml.slice(0, 120));
  check("markup contains the OFFICIAL monetag tag only (data-zone present)", headerHtml.includes(`data-zone="1110001"`));
  check("browser-side one-shot fallback bootstrap present when both networks configured", headerHtml.includes("data-ad-fallback=") && headerHtml.includes('addEventListener("error"'), "");
  check("markup never mimics UI controls: no buttons/links/inputs", !/<button|<a\s|<input|<select|type="button"/i.test(headerHtml));
  check("CSS: wrapper can never intercept page controls (pointer-events:none)", ADS_CSS.includes(".cloner-ad-slot { display: block; margin: 12px 0; pointer-events: none; }") && !/cursor:\s*pointer/.test(ADS_CSS));
  const bad = await getPage("BAD KEY!");
  check("invalid page key → 400", bad.status === 400);
  const unknown = await fetch(`${APP_BASE}/api/ads/slot/nope`);
  check("unknown slot → 404 with valid-slot list", unknown.status === 404 && (await unknown.json()).error.includes("header"));
}

// ===========================================================================
section("frequency caps — enforced on the real ledger, configurable");

{
  healthyEnv();
  resetProviderState();
  const first = await getPage("dashboard");
  const sid = first.sid;
  check("first view: every slot served", first.body.slots.every((s) => s.status === "served"), first.body.slots.map((s) => `${s.key}:${s.status}`).join(","));
  const second = await getPage("dashboard", { cookie: sid });
  check("second view within the window: every slot frequency-capped", second.body.slots.every((s) => s.status === "skipped_frequency_capped"), second.body.slots.map((s) => `${s.key}:${s.status}`).join(","));
  const capLog = await query(`SELECT detail FROM ad_delivery_log WHERE outcome='frequency_capped' AND slot_key='header' ORDER BY id DESC LIMIT 1`);
  check("honest cap log carries served/cap/window", capLog.rows[0] && /served=1 cap=1 window=3600s/.test(capLog.rows[0].detail), capLog.rows[0]?.detail);

  // admin raises the header cap to 2
  const put = await fetch(`${APP_BASE}/api/ads/settings/header`, { method: "PUT", headers: { ...auth(adminTok), "content-type": "application/json" }, body: JSON.stringify({ capMax: 2 }) });
  const putBody = await put.json();
  check("admin PUT settings → 200 with merged settings", put.status === 200 && putBody.settings.capMax === 2, JSON.stringify(putBody.settings || {}));
  const third = await getPage("dashboard", { cookie: sid });
  const h3 = third.body.slots.find((s) => s.key === "header");
  const others3 = third.body.slots.filter((s) => s.key !== "header");
  check("after cap raise to 2: header serves again, others stay capped", h3.status === "served" && others3.every((s) => s.status === "skipped_frequency_capped"), third.body.slots.map((s) => `${s.key}:${s.status}`).join(","));
  const fourth = await getPage("dashboard", { cookie: sid });
  check("header capped again at 2 serves (cap really counts)", fourth.body.slots.find((s) => s.key === "header").status === "skipped_frequency_capped");
  const ledger = await query(`SELECT count(*)::int AS n FROM ad_serving_events WHERE slot_key='header' AND session_hash=$1`, [hashSessionToken(sid)]);
  check("serving ledger holds one row per real serve (this session)", ledger.rows[0].n === 2, `session header rows=${ledger.rows[0].n}`);

  // settings validation + auth posture
  const badCap = await fetch(`${APP_BASE}/api/ads/settings/header`, { method: "PUT", headers: { ...auth(adminTok), "content-type": "application/json" }, body: JSON.stringify({ capMax: 999 }) });
  check("capMax out of range → 400", badCap.status === 400);
  const badProv = await fetch(`${APP_BASE}/api/ads/settings/header`, { method: "PUT", headers: { ...auth(adminTok), "content-type": "application/json" }, body: JSON.stringify({ providerOverride: "bogus" }) });
  check("bogus providerOverride → 400", badProv.status === 400);
  const unauthPut = await fetch(`${APP_BASE}/api/ads/settings/header`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ capMax: 2 }) });
  check("settings PUT without auth → 401", unauthPut.status === 401);
  const nonAdminPut = await fetch(`${APP_BASE}/api/ads/settings/header`, { method: "PUT", headers: { ...auth(userTok), "content-type": "application/json" }, body: JSON.stringify({ capMax: 2 }) });
  check("settings PUT as non-admin → 403", nonAdminPut.status === 403);
  const statusUnauth = await fetch(`${APP_BASE}/api/ads/status`);
  check("status without auth → 401", statusUnauth.status === 401);
  const statusResp = await fetch(`${APP_BASE}/api/ads/status`, { headers: auth(userTok) });
  const status = await statusResp.json();
  check("status (any authed user): flags + health, no secrets", statusResp.status === 200 && status.slots.length === 4 && status.slots[0].monetag.configured === true && !JSON.stringify(status).includes("invoke.js") && !JSON.stringify(status).includes("1110001"), `primary=${status.primary}`);
}

// ===========================================================================
section("provider pin via settings — honored, but availability still wins");

{
  healthyEnv();
  resetProviderState();
  const put = await fetch(`${APP_BASE}/api/ads/settings/mid-content`, { method: "PUT", headers: { ...auth(adminTok), "content-type": "application/json" }, body: JSON.stringify({ providerOverride: "adsterra", capMax: 50 }) });
  check("pin to adsterra accepted", put.status === 200);
  const s1 = await resolveSlotForRender("mid-content", { sessionHash: hashSessionToken("anon-pin") });
  check("pinned provider serves when healthy", s1.status === "served" && s1.provider === "adsterra", `${s1.status}/${s1.provider}`);
  setEnv("ADSTERRA_ZONE_ID_MID_CONTENT", `${SIM_BASE}/adsterra-down/z1/invoke.js`);
  await query("DELETE FROM ad_serving_events WHERE slot_key='mid-content'");
  await putSlotSettingsCleanup("mid-content", { capMax: 50 });
  const s2 = await resolveSlotForRender("mid-content", { sessionHash: hashSessionToken("anon-pin-2") });
  check("pinned provider down → fallback (monetag) still serves", s2.status === "served" && s2.provider === "monetag", `${s2.status}/${s2.provider}`);
  // cleanup for later sections
  await query("DELETE FROM ad_slot_settings WHERE slot_key='mid-content'");
  await getSlotSettings("mid-content");
}

async function putSlotSettingsCleanup(slotKey, patch) {
  // invalidate the settings cache by writing through the module (keeps the
  // scenario hermetic without touching HTTP auth again)
  const { putSlotSettings } = await import("../src/monetization/ad-slots.js");
  await putSlotSettings(slotKey, patch);
}

// ===========================================================================
section("clean degradation — ledger outage fails CLOSED, never crashes");

{
  healthyEnv();
  resetProviderState();
  const hadPort = had("PGPORT");
  const origPort = REAL_ENV.PGPORT;
  await closePool();
  process.env.PGPORT = "1"; // dead port
  let out = null, threw = null;
  try {
    out = await buildPageMarkup("index", { sessionHash: hashSessionToken("anon-dbdown") });
  } catch (e) { threw = e; }
  check("ledger outage: buildPageMarkup does not crash", threw === null, threw ? String(threw) : "");
  check("ledger outage: every slot honestly skipped (fail-closed caps)", out && out.slots.length === 4 && out.slots.every((s) => s.status === "skipped_cap_check_unavailable" && s.html === ""), out ? out.slots.map((s) => s.status).join(",") : "null");
  // restore
  if (hadPort) process.env.PGPORT = origPort;
  else delete process.env.PGPORT;
  await closePool();
  await query("SELECT 1");
  check("database connection restored after degradation test", true);
}

// ===========================================================================
section("GUARDRAIL GREPS — zero traffic-generation code in product sources");

{
  const files = [
    "src/monetization/ad-providers.js",
    "src/monetization/ad-slots.js",
    "src/database/migrations/050-ad-settings.sql",
  ];
  const forbidden = [
    ["timer-driven re-render (setInterval)", /setInterval/i],
    ["timer-driven re-render (setTimeout)", /setTimeout/i],
    ["frame-loop re-render (rAF)", /requestAnimationFrame/i],
    ["synthetic DOM events", /dispatchEvent/i],
    ["synthetic pointer interaction", /\.click\s*\(/i],
    ["forced popups", /window\.open/i],
    ["automated re-render wording", /auto[-_ ]?refresh|autorefresh/i],
    ["re-render-on-timer helpers", /refreshad|reloadad|rerender/i],
    ["click-fraud tooling wording", /click[\s_-]?bot|fake[\s_-]?click|synthetic[\s_-]?click|simulat\w*[\s_-]?click|cpm[\s_-]?boost/i],
    ["ad-view count wording (delivery wording only)", /impression/i],
  ];
  for (const file of files) {
    const src = fs.readFileSync(path.join(PROJECT, file), "utf8");
    for (const [label, re] of forbidden) {
      const m = src.match(re);
      check(`guardrail ${file}: no ${label}`, m === null, m ? `matched "${m[0]}"` : "");
    }
  }
  // the markup contract itself, asserted from the CSS + a freshly built slot
  const sample = await (async () => {
    healthyEnv();
    resetProviderState();
    return resolveSlotForRender("sidebar", { sessionHash: hashSessionToken("anon-guardrail") });
  })();
  const html = sample.html || "";
  const interactive = [
    ["no <button", /<button/i],
    ["no <a link", /<a\s/i],
    ["no <input", /<input/i],
    ["no onclick attribute", /onclick=/i],
    ["no pointer affordance", /cursor:\s*pointer/i],
  ];
  for (const [label, re] of interactive) {
    check(`guardrail markup: ${label}`, re.test(html) === false);
  }
  check("guardrail markup: clearly labelled Advertisement", html.includes('aria-label="Advertisement"') && html.includes(">Advertisement</span>"));
}

// ===========================================================================
section("REAL network smoke (official loaders, owner zone envs)");

{
  const realMonetagZones = Object.keys(REAL_ENV).filter((k) => k.startsWith("MONETAG_ZONE_ID_") && REAL_ENV[k]);
  const realAdsterraZones = Object.keys(REAL_ENV).filter((k) => k.startsWith("ADSTERRA_ZONE_ID_") && REAL_ENV[k]);
  const smokeEnabled = process.env.AD_REAL_SMOKE !== "0";
  if (!smokeEnabled) {
    console.log("SKIP  real-network smoke — AD_REAL_SMOKE=0");
    console.log("SKIP  (this is the only advertised skip; core chain already proven against the simulator)");
  } else if (!realMonetagZones.length && !realAdsterraZones.length) {
    console.log("SKIP  real-network smoke — no MONETAG_ZONE_ID_* / ADSTERRA_ZONE_ID_* env configured by the operator");
    console.log("SKIP  hint: paste the owner's dashboard zone ids into env and re-run for a live loader probe");
  } else {
    // save the simulator posture, restore the operator's REAL env for the smoke
    const saved = {};
    for (const k of Object.keys(process.env)) {
      if (/^(MONETAG_ZONE_ID_|ADSTERRA_ZONE_ID_|ADSTERRA_ZONE_KEY_|ADSTERRA_LOADER_DOMAIN|MONETAG_LOADER_URL|AD_PROVIDER_PRIMARY)/.test(k)) saved[k] = process.env[k];
    }
    for (const k of Object.keys(saved)) delete process.env[k];
    for (const k of Object.keys(REAL_ENV)) {
      if (/^(MONETAG_ZONE_ID_|ADSTERRA_ZONE_ID_|ADSTERRA_ZONE_KEY_|ADSTERRA_LOADER_DOMAIN|MONETAG_LOADER_URL|AD_PROVIDER_PRIMARY)/.test(k)) process.env[k] = REAL_ENV[k];
    }
    resetProviderState();
    let anyHealthy = false;
    const attempts = [];
    for (const providerId of ["monetag", "adsterra"]) {
      const zones = providerId === "monetag" ? realMonetagZones : realAdsterraZones;
      if (!zones.length) continue;
      const slotKey = zones[0].replace(/^(MONETAG|ADSTERRA)_ZONE_ID_/, "").replace(/_/g, "-").toLowerCase();
      const p = await probeProvider(providerId, slotKey, { forceProbe: true, timeoutMs: 5000, cacheMs: 0 });
      attempts.push(`${providerId}/${slotKey}: ${p.skipped === "not_configured" ? "not configured" : p.healthy ? `healthy (HTTP ${p.status})` : `unreachable (${p.error})`}`);
      if (p.healthy) anyHealthy = true;
    }
    for (const k of Object.keys(saved)) process.env[k] = saved[k];
    resetProviderState();
    if (anyHealthy) {
      check("real official loader reachable from this host", true, attempts.join("; "));
    } else {
      console.log(`WARN  real official loader not reachable from this host (informational, not a suite failure): ${attempts.join("; ")}`);
      console.log("SKIP  real-network smoke — treat as skipped; the chain itself is proven above");
    }
  }
}

// ===========================================================================
// summary
// ===========================================================================
const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(`\n${"═".repeat(70)}`);
console.log(`ad-providers suite: ${passed} passed, ${failed} failed (${results.length} checks)`);
if (failed > 0) {
  console.log("FAILED checks:");
  let i = 0;
  for (const line of results) {
    if (!line) console.log(`  - check #${i + 1}`);
    i++;
  }
}
httpServer.close();
sim.server.close();
await closePool();
process.exit(failed > 0 ? 1 : 0);
