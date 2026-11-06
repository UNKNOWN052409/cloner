#!/usr/bin/env node
// Offline shell test for platform-ui (pages 1-4) — real browser, fake network.
//
//   node scripts/test-platform-ui-shell.mjs
//
// Harness: a static file server rooted at platform-ui/ on 127.0.0.1 plus a
// page-side fetch mock layer (addInitScript, installed BEFORE any module runs)
// that answers the platform API contract read from src/platform/server.js:
//   POST /api/tasks → {id,status,pipeline:"v2"} · GET /api/tasks → v1+v2 list
//   GET /api/jobs/:id → job + manifest · GET /api/jobs/:id/artifacts/* → files
//   GET /api/sessions → {active,ids} · /api/auth/me → 401 (signed-out posture)
// WebSocket is replaced by a FakeWS that opens immediately and records sends,
// so the /ws join + catchup/live event contract is exercised without a server.
// Screenshot bytes are a 1x1 PNG served by the harness for the artifact paths
// (the /ws whitelist carries no images — exploration.js polls the artifacts).
// Prints PASS/FAIL per check; exits 1 on any failure.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(HERE, "..", "platform-ui");
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==", "base64");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

// ---- fixtures (shapes read from the real backend: server.js routes,
// exploration-runner.js getExplorationJob, real artifacts/<jobId>/ files) ----
const MOCK = {
  tasks: [
    { id: "t1", url: "https://legacy.example.test/", status: "done", createdAt: "2026-11-06T10:00:00.000Z", verification: { passed: true } },
    { jobId: "j1", id: "j1", url: "https://shop.example.test/", status: "exploring", createdAt: "2026-11-06T11:00:00.000Z" },
    { jobId: "j2", id: "j2", url: "https://docs.example.test/", status: "completed", createdAt: "2026-11-06T09:00:00.000Z" },
    { jobId: "j3", id: "j3", url: "https://broken.example.test/", status: "error", createdAt: "2026-11-06T08:00:00.000Z", error: "boom" },
  ],
  jobJ1: {
    jobId: "j1", url: "https://shop.example.test/", status: "exploring",
    manifest: { status: "exploring", coverage: { routesExplored: 2, routesDiscovered: 5, statesRecorded: 4 }, pages: 2, metrics: {} },
    credentialsProvided: false, hasCookies: false,
  },
  manifest: {
    schemaVersion: 1, jobId: "j1", status: "exploring", originalUrl: "https://shop.example.test/",
    coverage: { routesExplored: 2, routesDiscovered: 5, statesRecorded: 4 },
    pages: [
      { pageId: "page-001", url: "https://shop.example.test/", route: { url: "https://shop.example.test/", source: "seed" } },
      { pageId: "page-002", url: "https://shop.example.test/pricing", route: { url: "https://shop.example.test/pricing", source: "spa" } },
    ],
    metrics: { navigationMs: 800, domExtractionMs: 20, screenshotMs: 90, assetMs: 5, crashes: 0, timeouts: 0, failedInteractions: 0 },
    warnings: ["slow asset on /pricing"], errors: [],
  },
  routes: { routes: [
    { url: "https://shop.example.test/", source: "seed", score: 2 },
    { url: "https://shop.example.test/pricing", source: "spa", score: 1 },
  ], policy: {} },
  tokens: {
    colors: [["#fafafa", 12], ["#1a1a1a", 4]], backgrounds: [["#ffffff", 9]],
    fonts: [["Georgia, serif", 7]], fontSizes: [["16px", 9]], radii: [["4px", 3]],
    bodyBackground: "#ffffff", bodyColor: "#1a1a1a",
  },
  summary: { jobId: "j1", status: "exploring", pages: 2, routes: 2, states: 4, interactions: 6, coveragePct: 40 },
  sessions: { active: 1, ids: ["local"] },
  postTask: { id: "pending-x1", status: "queued", pipeline: "v2" },
};

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  const send = (status, type, buf) => { res.writeHead(status, { "content-type": type }); res.end(req.method === "HEAD" ? undefined : buf); };
  if (p === "/favicon.ico") return send(200, "image/png", PNG_1PX);
  if (p.startsWith("/api/")) {
    if (p.endsWith(".png")) return send(200, "image/png", PNG_1PX); // artifact screenshot bytes
    return send(404, "application/json", Buffer.from('{"error":"not found"}')); // API JSON answered browser-side only
  }
  const file = path.resolve(UI_DIR, p.replace(/^\/+/, "") || "index.html");
  if (!file.startsWith(UI_DIR + path.sep) && file !== UI_DIR) return send(403, "text/plain", Buffer.from("forbidden"));
  try {
    send(200, MIME[path.extname(file).toLowerCase()] || "application/octet-stream", await readFile(file));
  } catch {
    send(404, "text/plain", Buffer.from("not found: " + p));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port + "/";

// ---- browser-side mock layer (runs before any module script) ----
const initScript = `(function () {
  const M = ${JSON.stringify(MOCK)};
  const real = window.fetch.bind(window);
  const j = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const p = url.startsWith("http") ? new URL(url).pathname : url;
    const method = (init && init.method) || "GET";
    if (!p.startsWith("/api/")) return real(input, init);
    if (p === "/api/tasks" && method === "POST") return Promise.resolve(j(200, M.postTask));
    if (p === "/api/auth/me") return Promise.resolve(j(401, { error: "authentication required" }));
    if (p === "/api/tasks") return Promise.resolve(j(200, M.tasks));
    if (p === "/api/jobs/j1") return Promise.resolve(j(200, M.jobJ1));
    if (p === "/api/sessions") return Promise.resolve(j(200, M.sessions));
    if (p === "/api/jobs/j1/artifacts/manifest.json") return Promise.resolve(j(200, M.manifest));
    if (p === "/api/jobs/j1/artifacts/graph/routes.json") return Promise.resolve(j(200, M.routes));
    if (p === "/api/jobs/j1/artifacts/design-tokens.json") return Promise.resolve(j(200, M.tokens));
    if (p === "/api/jobs/j1/artifacts/reports/exploration-summary.json") return Promise.resolve(j(200, M.summary));
    if (p === "/api/jobs/j1/artifacts/blueprint.json") return Promise.resolve(j(404, { error: "not found" }));
    return Promise.resolve(j(404, { error: "not found" }));
  };
  window.__wsInstances = [];
  window.WebSocket = class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 1; this.__sent = [];
      window.__wsInstances.push(this);
      setTimeout(() => { this.onopen && this.onopen(); }, 0);
    }
    send(s) { this.__sent.push(String(s)); }
    close() { this.readyState = 3; }
    __emit(msg) { this.onmessage && this.onmessage({ data: JSON.stringify(msg) }); }
  };
})();`;

let failed = 0;
const check = (label, ok, detail) => {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? "  — " + detail : ""));
  if (!ok) failed++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
await page.addInitScript(initScript);

const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); };

// ---- 1. shell + dashboard ----
await page.goto(base + "#/");
await page.waitForSelector("#dash-body table.grid", { timeout: 10000 }).catch(() => {});
const navCount = await page.locator(".topnav nav a").count();
check("shell: top nav carries the 8 page routes", navCount === 8, "nav links=" + navCount);
const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const probeBg = await page.evaluate(() => {
  const probe = document.createElement("div");
  probe.style.background = "var(--bg-canvas)";
  document.body.appendChild(probe);
  const v = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return v;
});
check("tokens: body background resolves through the semantic --bg-canvas var",
  bodyBg !== "rgba(0, 0, 0, 0)" && bodyBg === probeBg, `bg=${bodyBg} var-resolved=${probeBg}`);
const dashText = await page.textContent("#dash-body").catch(() => "");
check("dashboard: mocked task list rendered (all 4 targets)",
  ["legacy.example.test", "shop.example.test", "docs.example.test", "broken.example.test"].every((u) => dashText.includes(u)),
  "rows=" + (dashText.match(/example\.test/g) || []).length);
const sum = await page.textContent("#dash-summary").catch(() => "");
check("dashboard: status buckets (1 running / 2 completed / 1 failed of 4)",
  /\b4\s*total\b/.test(sum) && /\b1\s*running\b/.test(sum) && /\b2\s*completed\b/.test(sum) && /\b1\s*failed\b/.test(sum),
  sum.replace(/\s+/g, " ").trim().slice(0, 120));
check("dashboard: running v2 row shows progress from /api/jobs manifest coverage",
  await page.locator("#dash-body .meter i[style*='width:40%']").count() > 0, "40% meter");

// ---- 2. new clone ----
await go("#/new");
await page.waitForSelector("#clone-form", { timeout: 10000 });
const masked = await page.getAttribute("#nc-pass", "type");
check("new-clone: password field is masked", masked === "password", "type=" + masked);
await page.selectOption("#nc-scope", "single-page");
const eff = await page.textContent("#nc-effective");
check("new-clone: scope composes into the instructions the pipeline parses",
  (eff || "").includes("limit to this page only"), (eff || "").trim().slice(0, 80));
await page.fill("#nc-url", "https://example.test/");
await page.click("#nc-start");
await page.waitForSelector("#nc-result:not([hidden])", { timeout: 10000 }).catch(() => {});
const res = await page.textContent("#nc-result").catch(() => "");
check("new-clone: POST /api/tasks result links the live workspace + /progress viewer",
  res.includes("pending-x1") && (await page.locator('#nc-result a[href*="/progress/pending-x1"]').count()) > 0 &&
  (await page.locator('#nc-result a[href="#/projects/pending-x1/exploration"]').count()) > 0,
  res.replace(/\s+/g, " ").trim().slice(0, 80));

// ---- 3. live exploration ----
await go("#/projects/j1/exploration");
await page.waitForSelector("#ex-shot img[src*='page-002']", { timeout: 10000 }).catch(() => {});
const shotSrc = await page.getAttribute("#ex-shot img", "src").catch(() => "");
check("exploration: latest captured screenshot shown (artifact read, newest page)",
  shotSrc.includes("/api/jobs/j1/artifacts/pages/page-002/screenshot-viewport.png"), shotSrc);
const wsSent = await page.evaluate(() => (window.__wsInstances[0] ? window.__wsInstances[0].__sent.join("|") : ""));
check("exploration: /ws joined with the job id", wsSent.includes('"join"') && wsSent.includes("j1"), wsSent.slice(0, 80));
await page.evaluate(() => window.__wsInstances[0].__emit({
  type: "catchup",
  data: { meta: null, events: [{ type: "step", data: { id: "open", status: "done", msg: "opening https://shop.example.test" }, t: 1730000000000, job: "j1" }] },
}));
await page.waitForFunction(() => { const t = (document.querySelector("#ex-timeline") || {}).textContent || ""; return t.includes("opening"); }, null, { timeout: 5000 }).catch(() => {});
check("exploration: catchup replay backfills the event timeline",
  (await page.textContent("#ex-timeline").catch(() => "")).includes("opening"));
await page.evaluate(() => window.__wsInstances[0].__emit({
  type: "page:goto", task: "j1",
  data: { type: "page:goto", data: { url: "https://shop.example.test/checkout" }, t: Date.now(), job: "j1" },
}));
await page.waitForFunction(() => { const t = (document.querySelector("#ex-current") || {}).textContent || ""; return t.includes("/checkout"); }, null, { timeout: 5000 }).catch(() => {});
check("exploration: live page:goto updates current position", (await page.textContent("#ex-current")).includes("checkout"));
const sess = await page.textContent("#ex-session").catch(() => "");
check("exploration: session/auth status block rendered", sess.includes("anonymous exploration") && sess.includes("1 active"), sess.replace(/\s+/g, " ").slice(0, 100));

// ---- 4. website intelligence ----
await go("#/projects/j1/intelligence");
await page.waitForFunction(() => { const t = (document.querySelector("#wi-cov") || {}).textContent || ""; return t.includes("2/5"); }, null, { timeout: 10000 }).catch(() => {});
check("intelligence: manifest coverage metered (2/5 routes)", (await page.textContent("#wi-cov")).includes("2/5"));
check("intelligence: routes table from graph/routes.json",
  (await page.locator("#wi-routes table tr").count()) >= 3, "rows incl header");
const tok = await page.textContent("#wi-tokens").catch(() => "");
check("intelligence: measured design tokens (fonts + colors)", tok.includes("Georgia") && tok.includes("#fafafa"), tok.replace(/\s+/g, " ").slice(0, 100));
const bp = await page.textContent("#wi-blueprint").catch(() => "");
check("intelligence: missing blueprint.json degrades gracefully (404 path)",
  bp.includes("not in the artifacts yet"), bp.replace(/\s+/g, " ").trim().slice(0, 90));

// ---- 5. console errors + mobile tolerance ----
await go("#/");
await page.waitForSelector("#dash-body table.grid", { timeout: 10000 }).catch(() => {});
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check("mobile (390px): no horizontal overflow", overflow <= 2, "overflowPx=" + overflow);
check("no console errors across the whole run", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();
server.close();
console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
