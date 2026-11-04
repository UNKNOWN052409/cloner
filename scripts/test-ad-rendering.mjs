#!/usr/bin/env node
// Task 4.5.5 — ad-clone-integration, full human-journey Playwright suite
// against a REAL booted platform (startPlatform, src/platform/server.js).
// No product path is mocked:
//
//   • the platform is the real server booted from a throwaway sandbox cwd so
//     the developer's real platform-data / artifacts / config are never touched;
//   • the ONLY simulated third party is the local fixture HTTP server standing
//     in as (a) the clone TARGET site and (b) the ad network's official loader
//     file (MONETAG_LOADER_URL points at the fixture) — the sanctioned
//     remote-end simulator pattern. The emitted markup is the REAL official
//     Monetag tag shape from src/monetization/ad-providers.js; nothing about
//     the tag is faked, only the file it points at is local.
//   • POLICY (the 4.5.5 brief): ads live ONLY inside generated clones — the
//     platform itself renders no ad inventory (backend-only feature). Every
//     journey below therefore exercises CLONE surfaces and the per-task
//     monetize flag API (src/monetization/ad-config-api.js); there is no
//     platform-UI ad journey by design.
//   • INTEGRATOR MOUNT LINES applied dynamically to the booted server (same
//     listeners("request") pattern as test-ui-onboarding.mjs) until the
//     integrator merges them:
//       app.use(express.json());                 // for the middleware's body read
//       app.use(monetizeOptInMiddleware());      // src/platform/ads-optin.js
//       app.use("/api/ads", adsRouter());        // src/monetization/ad-slots.js
//       app.use("/api/ad-config", adConfigRouter()); // src/monetization/ad-config-api.js
//
// Journeys exercised the way a human would (real HTTP, real clicks in the
// browser for the RENDERED clone, visible elements, screenshots + layout
// sanity at every step):
//   1. monetize opt-in with NO ad zones configured → clean 400, task NOT created
//   2. opt-OUT clone task (real v1 pipeline) → the served clone has ZERO ad markup
//   3. opt-IN clone task (real v1 pipeline, flag in the creation request) → the
//      served clone renders BOTH designated zone containers + the official
//      provider scripts, and the browser REALLY fetches the loader (fixture hit
//      counter)
//   4. opt-IN clone via pipeline v2 (queueExploration → payload →
//      reconstruction → generator) → same ad contract on the v2 output
//   5. per-task monetize flag API (ad-config): read is derived truth; owner-only
//      writes; flipping the flag on an ALREADY-GENERATED clone rewrites its
//      artifacts (ads in ↔ ads out) and the served preview follows immediately;
//      opt-in without zones → clean 400
//   6. no uncaught page errors anywhere
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(PROJECT, "output", "ad-rendering");
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
};
const section = (t) => console.log(`\n──── ${t} ────`);

// ---------- fixture: the simulated third party (remote-end simulator) ----------
// serves (a) the clone-target site and (b) the official Monetag loader file.
const loaderHits = { tag: 0 };
const FIXTURE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Fixture Retail — Ad Journey Demo</title>
<style>body{font-family:system-ui;margin:0;background:#fafafa;color:#1c2430}header{padding:18px 28px;background:#101828;color:#fff;font-size:20px}main{max-width:760px;margin:32px auto;padding:0 20px}h1{font-size:26px}button{padding:10px 22px;border:0;border-radius:6px;background:#2e6bff;color:#fff;font-size:15px;cursor:pointer}p{line-height:1.6}</style>
</head><body><header>Fixture Retail</header><main><h1>Welcome to Fixture Retail</h1>
<p>This tiny site is the clone target for the ad-rendering journey test.</p>
<button id="buy" type="button">Add to cart</button><p id="cart">cart is empty</p></main>
<script>document.getElementById("buy").addEventListener("click",function(){document.getElementById("cart").textContent="cart has 1 item"});</script>
</body></html>`;

async function startFixture() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/ads/tag.min.js") {
        loaderHits.tag++;
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end('window.__MONETAG_LOADER_LOADED = true; // remote-end simulator: official loader file\n');
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

// ---------- boot the REAL platform from a sandbox cwd ----------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cloner-ads-"));
process.chdir(sandbox); // data paths (platform-data/, artifacts/, cloner.config.json) resolve here
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // sanctioned fixture-testing opt-in (url-guard.js)
process.env.CLONER_ENV_FILE = path.join(sandbox, ".env");
delete process.env.REDIS_URL; // memory backend: deterministic in-process pipeline execution
delete process.env.CLONER_REDIS_URL;
// deterministic onboarding-free posture: no inherited provider keys
for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CUSTOM_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "CUSTOM_BASE_URL"]) delete process.env[k];
// generous frequency cap so repeated loads serve (cap is read per call from env)
process.env.AD_FREQUENCY_CAP_MAX = "50";
process.env.AD_FREQUENCY_CAP_WINDOW_SECONDS = "3600";

const ZONE_ENV = ["MONETAG_ZONE_ID_HEADER", "MONETAG_ZONE_ID_FOOTER", "ADSTERRA_ZONE_ID_HEADER", "ADSTERRA_ZONE_ID_FOOTER", "MONETAG_LOADER_URL", "ADSTERRA_LOADER_DOMAIN", "AD_PROVIDER_PRIMARY"];
function setZoneEnv(on) {
  if (on) {
    process.env.MONETAG_ZONE_ID_HEADER = "zh-" + crypto.randomBytes(4).toString("hex");
    process.env.MONETAG_ZONE_ID_FOOTER = "zf-" + crypto.randomBytes(4).toString("hex");
    process.env.MONETAG_LOADER_URL = `http://127.0.0.1:${fixturePort}/ads/tag.min.js`;
  } else {
    for (const k of ZONE_ENV) delete process.env[k];
  }
}

const { startPlatform } = await import("../src/platform/server.js");
const { srv: fixtureSrv, port: fixturePort } = await startFixture();
const FIXTURE_URL = `http://127.0.0.1:${fixturePort}/`;
console.log(`[fixture] remote-end simulator on ${FIXTURE_URL}`);
console.log(`[sandbox] ${sandbox}`);

setZoneEnv(false); // phase A: nothing configured — the policy-safe default
const platform = await startPlatform({ port: 0 });
const { port: P } = platform;
const BASE = `http://127.0.0.1:${P}`;
console.log(`[platform] booted at ${BASE}`);

// ---- integrator mount lines applied to the real booted server ----
const platformApp = platform.server.listeners("request")[0];
const composed = express();
composed.use(express.json({ limit: "20mb" }));
const { monetizeOptInMiddleware } = await import("../src/platform/ads-optin.js");
const { adsRouter, ensureAdSchema } = await import("../src/monetization/ad-slots.js");
const { adConfigRouter } = await import("../src/monetization/ad-config-api.js");
composed.use(monetizeOptInMiddleware());
composed.use("/api/ads", adsRouter());
composed.use("/api/ad-config", adConfigRouter());
composed.use((req, res) => platformApp(req, res)); // everything else → the real platform
platform.server.removeAllListeners("request");
platform.server.on("request", composed);
await ensureAdSchema(); // migration 050 tables (idempotent; boot's migrate() races the first fetch)
console.log("[mount] monetizeOptInMiddleware + /api/ads + /api/ad-config routers attached (integrator mount lines)");

const nodeApi = async (p, opts = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    method: opts.method || "GET",
    headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

// real activation (register + login) — the task owner identity. The login
// response carries BOTH the bearer token (API calls) and the real
// cloner_session cookie — browser NAVIGATIONS (/preview/...) authenticate
// through that cookie (ws-auth G5.5: navigations cannot set an Authorization
// header), so the Playwright contexts ride the exact cookie a human gets.
const stamp = Date.now();
const OWNER = `ads-owner-${crypto.randomBytes(4).toString("hex")}@test.local`;
const reg = await nodeApi("/api/auth/register", { method: "POST", body: { email: OWNER, password: "correct-horse-9" } });
const ownerLoginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: OWNER, password: "correct-horse-9" }),
});
const ownerLogin = await ownerLoginRes.json().catch(() => null);
const TOK = ownerLogin?.token;
const authz = { authorization: `Bearer ${TOK}` };
const OWNER_COOKIE_PAIR = (ownerLoginRes.headers.get("set-cookie") || "").split(";")[0] || ""; // "cloner_session=…"
const OWNER_COOKIE = OWNER_COOKIE_PAIR.includes("=") ? OWNER_COOKIE_PAIR.slice(OWNER_COOKIE_PAIR.indexOf("=") + 1) : "";
console.log(`[owner] ${OWNER} registered=${reg.status === 200} login=${ownerLoginRes.status === 200}`);

// second identity — must NOT be able to flip someone else's monetize flag
const OTHER = `ads-other-${crypto.randomBytes(4).toString("hex")}@test.local`;
await nodeApi("/api/auth/register", { method: "POST", body: { email: OTHER, password: "correct-horse-9" } });
const otherLogin = await nodeApi("/api/auth/login", { method: "POST", body: { email: OTHER, password: "correct-horse-9" } });
const TOK2 = otherLogin.json?.token;
const authz2 = { authorization: `Bearer ${TOK2}` };

// wait for a v1 task to finish (real pipeline: browser capture → clone → verify).
// Verification's exhaustive click-everywhere stage is legitimately slow (measured
// ~270s on the fixture clone) — the deadline covers it honestly.
async function waitTask(id, timeoutMs = 480000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await nodeApi(`/api/tasks/${id}`, { headers: authz });
    const st = r.json?.status;
    if (st && !["queued", "running", "verifying"].includes(st)) return r.json;
    await new Promise((s) => setTimeout(s, 1500));
  }
  return { status: "timeout" };
}
async function waitJob(id, timeoutMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await nodeApi(`/api/jobs/${id}`, { headers: authz });
    const st = r.json?.status;
    if (st && ["completed", "completed_with_limitations", "error", "cancelled", "failed"].includes(st)) return r.json;
    await new Promise((s) => setTimeout(s, 1500));
  }
  return { status: "timeout" };
}

const AD_MARKUP_RE = /data-cloner-ad-zone|cloner-ad-slot|data-ad-provider|data-cloner-ad-css/;

// ---------- browser journey ----------
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
const pageErrors = [];

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  // the owner's real session cookie — preview navigations are cookie-authed
  if (OWNER_COOKIE) {
    await context.addCookies([{ name: "cloner_session", value: OWNER_COOKIE, url: BASE }]);
  }
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e).slice(0, 200)));
  return { context, page };
}
async function shot(page, name) { await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); }

// layout sanity: what a human sees — no horizontal overflow, element visible with real size
async function layoutOk(page, selector, label) {
  const el = page.locator(selector).first();
  const visible = await el.isVisible().catch(() => false);
  if (!visible) return { ok: false, detail: `${label} not visible` };
  const box = await el.boundingBox();
  if (!box || box.width < 2 || box.height < 2) return { ok: false, detail: `${label} zero/undefined size` };
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 2) {
    // diagnose: which elements extend past the viewport?
    const offenders = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      return [...document.querySelectorAll("body *")]
        .map((n) => { const r = n.getBoundingClientRect(); return { t: n.tagName + (n.className && typeof n.className === "string" ? "." + n.className.split(" ")[0] : ""), r: Math.round(r.right), w: Math.round(r.width) }; })
        .filter((x) => x.r > vw + 2)
        .sort((a, b) => b.r - a.r)
        .slice(0, 5)
        .map((x) => `${x.t}@r${x.r}(w${x.w})`);
    });
    return { ok: false, detail: `${label} box ${Math.round(box.width)}x${Math.round(box.height)}, hOverflow ${overflow}px offenders: ${offenders.join(", ") || "none-found"}` };
  }
  return { ok: true, detail: `${label} box ${Math.round(box.width)}x${Math.round(box.height)}, hOverflow ${overflow}px` };
}

// what a human SEES when opening a clone: the ad zones are visible boxes with
// the Advertisement label, the provider script node exists, and NOTHING sits
// outside the designated zone containers
async function cloneDomAdState(page) {
  return page.evaluate(() => {
    const zones = [...document.querySelectorAll("[data-cloner-ad-zone]")].map((z) => ({
      key: z.getAttribute("data-cloner-ad-zone"),
      visible: !!(z.offsetWidth || z.offsetHeight),
      label: z.querySelector(".cloner-ad-slot__label")?.textContent || "",
      hasScript: !!z.querySelector("script[data-ad-provider]"),
      provider: z.querySelector("[data-ad-provider]")?.getAttribute("data-ad-provider") || null,
    }));
    return {
      zones,
      outside: [...document.querySelectorAll(".cloner-ad-slot, script[data-ad-provider]")].filter((n) => !n.closest("[data-cloner-ad-zone]")).length,
      providerScripts: document.querySelectorAll("script[data-ad-provider]").length,
    };
  });
}

try {
  // =========================================================================
  section("1 — opt-in validation: monetize with NO zones configured → clean 400");
  {
    const before = await nodeApi("/api/tasks", { headers: authz });
    const taskCountBefore = Array.isArray(before.json) ? before.json.length : 0;
    const r = await nodeApi("/api/tasks", { method: "POST", headers: authz, body: { url: FIXTURE_URL, monetize: true, instructions: "must be rejected" } });
    check("opt-in without ad config → HTTP 400 (clean error, task not created)", r.status === 400, `status ${r.status}, error="${(r.json?.error || "").slice(0, 140)}"`);
    check("error names the missing zone env vars", /MONETAG_ZONE_ID|ADSTERRA_ZONE_ID/.test(r.json?.error || ""));
    const after = await nodeApi("/api/tasks", { headers: authz });
    const taskCountAfter = Array.isArray(after.json) ? after.json.length : 0;
    check("no task was created by the rejected request", taskCountAfter === taskCountBefore, `${taskCountBefore} → ${taskCountAfter}`);
  }

  // =========================================================================
  section("2 — opt-OUT clone task (real v1 pipeline) → ZERO ad markup");
  setZoneEnv(true);
  const optOut = await nodeApi("/api/tasks", { method: "POST", headers: authz, body: { url: FIXTURE_URL, instructions: "clone without monetize" } });
  check("opt-out task created", optOut.status === 200 && !!optOut.json?.id, `status ${optOut.status} id=${optOut.json?.id || "-"}`);
  const optOutTask = await waitTask(optOut.json.id);
  check("opt-out clone pipeline finished", ["done", "error"].includes(optOutTask.status), `status=${optOutTask.status}`);
  {
    const r = await fetch(`${BASE}/preview/${optOut.json.id}/index.html`, { headers: authz });
    const html = await r.text();
    check("opt-out clone served (HTTP 200)", r.status === 200, `status ${r.status}, ${html.length} bytes`);
    check("opt-out clone has ZERO ad markup", !AD_MARKUP_RE.test(html), AD_MARKUP_RE.test(html) ? "found ad markup!" : "no data-cloner-ad-zone / cloner-ad-slot / data-ad-provider / ad css");
    // what a human sees: open the clone in the browser — no ad node, layout sane
    const { context, page } = await newPage();
    await page.goto(`${BASE}/preview/${optOut.json.id}/index.html`, { waitUntil: "load" });
    const dom = await cloneDomAdState(page);
    check("opt-out clone browser view: zero ad nodes rendered", dom.zones.length === 0 && dom.providerScripts === 0 && dom.outside === 0, JSON.stringify({ zones: dom.zones.length, providerScripts: dom.providerScripts, outside: dom.outside }));
    const lo = await layoutOk(page, "main", "opt-out clone main content");
    check("layout: opt-out clone renders sanely (no ad boxes)", lo.ok, lo.detail);
    await shot(page, "01-clone-optout-no-ads.png");
    await context.close();
  }

  // =========================================================================
  section("3 — opt-IN clone task (real v1 pipeline, monetize in the creation request)");
  let optInTaskId = null;
  {
    const hitsBefore = loaderHits.tag;
    const r = await nodeApi("/api/tasks", { method: "POST", headers: authz, body: { url: FIXTURE_URL, monetize: true, instructions: "monetized clone" } });
    check("opt-in task created (monetize:true accepted with zones configured)", r.status === 200 && !!r.json?.id, `status ${r.status} id=${r.json?.id || "-"}`);
    optInTaskId = r.json.id;
    const optInTask = await waitTask(optInTaskId);
    check("opt-in clone pipeline finished", ["done", "error"].includes(optInTask.status), `status=${optInTask.status}${optInTask.error ? " error=" + String(optInTask.error).slice(0, 80) : ""}`);

    const htmlResp = await fetch(`${BASE}/preview/${optInTaskId}/index.html`, { headers: authz });
    const html = await htmlResp.text();
    const headerZones = (html.match(/data-cloner-ad-zone="header"/g) || []).length;
    const footerZones = (html.match(/data-cloner-ad-zone="footer"/g) || []).length;
    const providerScripts = (html.match(/<script async="async" data-cfasync="false" data-ad-provider="monetag"/g) || []).length;
    check("opt-in clone served with BOTH designated zones", htmlResp.status === 200 && headerZones === 1 && footerZones === 1, `header=${headerZones} footer=${footerZones} providerScripts=${providerScripts}`);
    check("official provider tag present (real Monetag shape, env zone ids)", providerScripts === 2 && html.includes(`data-zone="${process.env.MONETAG_ZONE_ID_HEADER}"`) && html.includes(`src="${process.env.MONETAG_LOADER_URL}"`), `zones h=${process.env.MONETAG_ZONE_ID_HEADER} f=${process.env.MONETAG_ZONE_ID_FOOTER}`);
    check("labelled inert wrapper (aria-label=Advertisement)", html.includes('aria-label="Advertisement"') && html.includes("Advertisement"));

    // the browser REALLY loads the official loader when viewing the clone
    const { context, page } = await newPage();
    await page.goto(`${BASE}/preview/${optInTaskId}/index.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__MONETAG_LOADER_LOADED === true, null, { timeout: 15000 }).catch(() => {});
    const loaderLoaded = await page.evaluate(() => window.__MONETAG_LOADER_LOADED === true);
    check("clone page actually fetched the official loader script (browser, real HTTP)", loaderLoaded && loaderHits.tag > hitsBefore, `loader hits ${hitsBefore} → ${loaderHits.tag}`);
    const dom = await cloneDomAdState(page);
    check("both zone containers render visibly with the Advertisement label + provider script", dom.zones.length === 2 && dom.zones.every((z) => z.visible && z.label === "Advertisement" && z.hasScript), JSON.stringify(dom.zones));
    check("no ad markup OUTSIDE designated zones in the clone", dom.outside === 0, `outside=${dom.outside}`);
    const lo = await layoutOk(page, "main", "clone main content");
    check("layout: clone content renders sanely alongside ad zones", lo.ok, lo.detail);
    await shot(page, "02-clone-optin-with-ads.png");
    await context.close();
  }

  // =========================================================================
  section("4 — opt-IN clone via pipeline v2 (payload threading to the generator)");
  const v2Id = await (async () => {
    const v2 = await nodeApi("/api/tasks", { method: "POST", headers: authz, body: { url: FIXTURE_URL, pipeline: "v2", monetize: true, instructions: "v2 monetized clone" } });
    check("v2 monetized task queued", v2.status === 200 && !!v2.json?.id, `status ${v2.status} id=${v2.json?.id || "-"}`);
    const job = await waitJob(v2.json.id);
    check("v2 pipeline reached a terminal state", ["completed", "completed_with_limitations"].includes(job.status), `status=${job.status} error=${job.error || "-"}`);
    const history = JSON.stringify(job.history || []);
    check("honest monetize history note on the job", history.includes("monetize: opted in"), history.slice(0, 160));
    const r = await fetch(`${BASE}/preview/${v2.json.id}/index.html`, { headers: authz });
    const html = await r.text();
    const headerZones = (html.match(/data-cloner-ad-zone="header"/g) || []).length;
    const footerZones = (html.match(/data-cloner-ad-zone="footer"/g) || []).length;
    check("v2 generated clone carries both designated zones + official tags", r.status === 200 && headerZones === 1 && footerZones === 1 && /data-ad-provider="monetag"/.test(html), `header=${headerZones} footer=${footerZones} (${html.length} bytes)`);
    return v2.json.id;
  })();

  // =========================================================================
  section("5 — per-task monetize flag API (src/monetization/ad-config-api.js)");
  {
    // --- reads are derived truth -------------------------------------------
    const g1 = await nodeApi(`/api/ad-config/tasks/${optOut.json.id}`);
    check("GET flag on the opt-out clone → monetize=false (derived from artifacts)", g1.status === 200 && g1.json?.monetize === false && g1.json?.source === "artifacts", `status ${g1.status} ${JSON.stringify({ monetize: g1.json?.monetize, source: g1.json?.source, taskKind: g1.json?.taskKind })}`);
    const g2 = await nodeApi(`/api/ad-config/tasks/${optInTaskId}`);
    check("GET flag on the opt-in clone → monetize=true (derived)", g2.status === 200 && g2.json?.monetize === true, `status ${g2.status} ${JSON.stringify({ monetize: g2.json?.monetize, source: g2.json?.source })}`);
    const g3 = await nodeApi(`/api/ad-config/tasks/${v2Id}`, { headers: authz2 });
    check("GET by authenticated NON-owner → 404 (no existence leak)", g3.status === 404, `status ${g3.status}`);
    const g4 = await nodeApi("/api/ad-config/tasks/does-not-exist-xyz");
    check("GET unknown task → 404", g4.status === 404, `status ${g4.status}`);

    // --- writes are owner/admin-only and validated --------------------------
    const p0 = await nodeApi(`/api/ad-config/tasks/${optOut.json.id}`, { method: "PUT", body: { monetize: true } });
    check("PUT without any identity on an owned task → 403", p0.status === 403, `status ${p0.status} error="${(p0.json?.error || "").slice(0, 90)}"`);
    const p1 = await nodeApi(`/api/ad-config/tasks/${optOut.json.id}`, { method: "PUT", headers: authz2, body: { monetize: true } });
    check("PUT by a non-owner → 403", p1.status === 403, `status ${p1.status}`);
    const p2 = await nodeApi(`/api/ad-config/tasks/${optOut.json.id}`, { method: "PUT", headers: authz, body: { monetize: "yes" } });
    check("PUT with a non-boolean body → 400", p2.status === 400, `status ${p2.status}`);
    const p3 = await nodeApi("/api/ad-config/tasks/does-not-exist-xyz", { method: "PUT", headers: authz, body: { monetize: true } });
    check("PUT unknown task → 404", p3.status === 404, `status ${p3.status}`);

    // --- flipping the flag rewrites an ALREADY-GENERATED clone --------------
    const hitsBefore = loaderHits.tag;
    const on = await nodeApi(`/api/ad-config/tasks/${optOut.json.id}`, { method: "PUT", headers: authz, body: { monetize: true } });
    check("owner PUT monetize=true → 200 + persisted state", on.status === 200 && on.json?.monetize === true && on.json?.source === "api", `status ${on.status} artifacts=${JSON.stringify(on.json?.artifacts || {})}`);
    check("artifact re-application actually rewrote the clone", (on.json?.artifacts?.changed || 0) >= 1 && (on.json?.artifacts?.scanned || 0) >= 1, JSON.stringify(on.json?.artifacts || {}));
    const htmlOn = await (await fetch(`${BASE}/preview/${optOut.json.id}/index.html`, { headers: authz })).text();
    check("served preview now carries BOTH zones + official provider scripts", /data-cloner-ad-zone="header"/.test(htmlOn) && /data-cloner-ad-zone="footer"/.test(htmlOn) && /data-ad-provider="monetag"/.test(htmlOn), `${htmlOn.length} bytes`);
    {
      const { context, page } = await newPage();
      await page.goto(`${BASE}/preview/${optOut.json.id}/index.html`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__MONETAG_LOADER_LOADED === true, null, { timeout: 15000 }).catch(() => {});
      const loaderLoaded = await page.evaluate(() => window.__MONETAG_LOADER_LOADED === true);
      check("flag flipped ON: browser really fetched the official loader again", loaderLoaded && loaderHits.tag > hitsBefore, `loader hits ${hitsBefore} → ${loaderHits.tag}`);
      const dom = await cloneDomAdState(page);
      check("flag flipped ON: both zones visible to a human with labels + scripts", dom.zones.length === 2 && dom.zones.every((z) => z.visible && z.label === "Advertisement" && z.hasScript), JSON.stringify(dom.zones));
      await shot(page, "03-clone-flag-flipped-on.png");
      await context.close();
    }
    const gOn = await nodeApi(`/api/ad-config/tasks/${optOut.json.id}`);
    check("GET after opt-in → monetize=true, source=api", gOn.status === 200 && gOn.json?.monetize === true && gOn.json?.source === "api", JSON.stringify({ monetize: gOn.json?.monetize, source: gOn.json?.source }));

    const off = await nodeApi(`/api/ad-config/tasks/${optOut.json.id}`, { method: "PUT", headers: authz, body: { monetize: false } });
    check("owner PUT monetize=false → 200", off.status === 200 && off.json?.monetize === false, `status ${off.status}`);
    const htmlOff = await (await fetch(`${BASE}/preview/${optOut.json.id}/index.html`, { headers: authz })).text();
    check("served preview is back to ZERO ad markup after opt-out", !AD_MARKUP_RE.test(htmlOff), AD_MARKUP_RE.test(htmlOff) ? "ad markup still present!" : "clean");
    const gOff = await nodeApi(`/api/ad-config/tasks/${optOut.json.id}`);
    check("GET after opt-out → monetize=false, source=api", gOff.status === 200 && gOff.json?.monetize === false && gOff.json?.source === "api", JSON.stringify({ monetize: gOff.json?.monetize, source: gOff.json?.source }));

    // --- v2 artifacts follow the flag too -----------------------------------
    const v2off = await nodeApi(`/api/ad-config/tasks/${v2Id}`, { method: "PUT", headers: authz, body: { monetize: false } });
    check("v2 clone flag flipped OFF → 200", v2off.status === 200 && v2off.json?.monetize === false, `status ${v2off.status} artifacts=${JSON.stringify(v2off.json?.artifacts || {})}`);
    const htmlV2off = await (await fetch(`${BASE}/preview/${v2Id}/index.html`, { headers: authz })).text();
    check("v2 served preview has ZERO ad markup after opt-out", !AD_MARKUP_RE.test(htmlV2off), AD_MARKUP_RE.test(htmlV2off) ? "ad markup still present!" : "clean");
    const v2on = await nodeApi(`/api/ad-config/tasks/${v2Id}`, { method: "PUT", headers: authz, body: { monetize: true } });
    const htmlV2on = await (await fetch(`${BASE}/preview/${v2Id}/index.html`, { headers: authz })).text();
    check("v2 clone flag flipped back ON → zones + official tags return", v2on.status === 200 && /data-cloner-ad-zone="header"/.test(htmlV2on) && /data-ad-provider="monetag"/.test(htmlV2on), `status ${v2on.status} changed=${v2on.json?.artifacts?.changed}`);

    // --- policy: opting in with NO configured zones stays a clean 400 -------
    let policyStatus = 0, policyError = "";
    const saved = {};
    try {
      for (const k of ZONE_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
      const r = await nodeApi(`/api/ad-config/tasks/${optOut.json.id}`, { method: "PUT", headers: authz, body: { monetize: true } });
      policyStatus = r.status; policyError = r.json?.error || "";
    } finally {
      for (const k of ZONE_ENV) if (saved[k] !== undefined) process.env[k] = saved[k];
    }
    check("PUT monetize=true with NO configured zones → clean 400 (policy)", policyStatus === 400, `status ${policyStatus} error="${policyError.slice(0, 120)}"`);
    check("policy error names the missing zone env vars", /MONETAG_ZONE_ID|ADSTERRA_ZONE_ID/.test(policyError));
  }

  // =========================================================================
  section("6 — page errors observed during every journey");
  check("no uncaught page errors in any journey", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | ") || "clean");
} catch (e) {
  check("journey completed without harness exception", false, String(e?.message || e).slice(0, 300));
  console.error(e);
} finally {
  await browser.close().catch(() => {});
  try { fixtureSrv.close(); } catch { /* already closed */ }
}

const passed = results.filter(Boolean).length;
console.log(`\n═══ RESULT: ${passed}/${results.length} checks passed — screenshots in ${SHOTS} ═══`);
process.exit(passed === results.length ? 0 : 1);
