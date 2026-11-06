#!/usr/bin/env node
// LIVE platform-UI gate — supersedes the offline-mock walk for the shell
// (bin/platform.js is the real product shell, ADR-0004). Boots the actual
// platform as a child process on an ephemeral port (memory queue — Redis env
// stripped; PG 127.0.0.1:5433 per src/database/client.js defaults), waits for
// /healthz, then Playwright-walks all 8 platform-ui pages:
//   1 /#/  dashboard          2 /#/new New Clone  → creates a task via the UI form
//   3 /#/projects/:id/exploration   4 /#/projects/:id/intelligence
//   5-8 standalone: pages/blueprint|reconstruction|comparison|final.html?job=:id
// then lands on /progress/:id (swarm build viewer) for the created task.
// Login is a real temp user via /api/auth (context.request → shared cookies).
// Asserts: zero JS console errors per page (network "Failed to load resource"
// logs are the designed honest-404 states, counted separately — same
// convention as scripts/test-platform-ui-pages.mjs). Screenshots →
// artifacts/platform-ui-gate/. Prints PASS/FAIL lines, exits 1 on failure.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);
const SHOTS = path.join(PROJECT, "artifacts", "platform-ui-gate");
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

// ---- clone target fixture: one small page the pipeline can actually reach
// (127.0.0.1 literal + CLONER_ALLOW_PRIVATE_TARGETS=1 is the documented local
// fixture path in src/security/url-guard.js). Existence is not a gate
// condition — task creation and page rendering are — but a reachable target
// keeps the job's live surfaces honest instead of DNS-fail artifacts.
async function startFixture() {
  const app = express();
  app.get("/", (_req, res) => res.type("html").send(`<!doctype html><html><head><title>Gate Fixture</title>
<style>body{font-family:sans-serif;background:#fff;color:#111}h1{color:#0a4}</style></head>
<body><h1 id="fx-title">Gate Fixture Home</h1><p class="fx-copy">One page, inline styles, one nav link.</p>
<a class="fx-nav" href="/pricing.html">Pricing</a></body></html>`));
  app.get("/pricing.html", (_req, res) => res.type("html").send(`<!doctype html><html><head><title>Pricing</title></head>
<body><h1>Pricing</h1><p class="fx-copy">$0 forever.</p></body></html>`));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

// ---- boot the real platform --------------------------------------------------
const PORT = await freePort();
const base = `http://127.0.0.1:${PORT}`;
const { server: fixture, url: targetUrl } = await startFixture();
const childEnv = { ...process.env, PORT: String(PORT), PGHOST: "127.0.0.1", PGPORT: "5433",
  PGDATABASE: "cloner", PGUSER: "cloner", PGPASSWORD: "cloner_dev_password",
  CLONER_ALLOW_PRIVATE_TARGETS: "1" };
delete childEnv.REDIS_URL; delete childEnv.CLONER_REDIS_URL; // memory queue, per ask
const child = spawn(process.execPath, [path.join(PROJECT, "bin", "platform.js"), "--port", String(PORT)],
  { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
const bootLog = [];
child.stdout.on("data", (d) => { bootLog.push(String(d)); if (bootLog.length > 80) bootLog.shift(); });
child.stderr.on("data", (d) => { bootLog.push("stderr: " + String(d)); if (bootLog.length > 80) bootLog.shift(); });
const killPlatform = () => {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch { /* already gone */ }
};

try {
  section("boot: bin/platform.js (memory queue, PG 127.0.0.1:5433)");
  let healthy = false;
  for (let i = 0; i < 180 && !healthy; i++) { // 90s budget: migrate + persistent sessions
    try { const r = await fetch(base + "/healthz"); healthy = r.ok; } catch { /* not up yet */ }
    if (!healthy) await new Promise((r) => setTimeout(r, 500));
  }
  ok("/healthz answered", healthy, healthy ? "" : "platform did not become healthy in 90s — boot tail:\n" + bootLog.join("").slice(-1500));
  if (!healthy) throw new Error("platform boot failed");

  section("auth: temp user via /api/auth (register API + product login form)");
  const email = `gate-live-${Date.now()}@example.test`, password = "gate-live-password-1";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const reg = await ctx.request.post(base + "/api/auth/register", { data: { email, password } });
  ok("POST /api/auth/register 2xx", reg.ok(), `status ${reg.status()}`);
  // /api/auth/me is header-only (hunt G5.3) — the documented API-caller path is
  // the Bearer token the login response carries.
  const login = await ctx.request.post(base + "/api/auth/login", { data: { email, password } });
  ok("POST /api/auth/login 2xx (sets cloner_session cookie + Bearer token)", login.ok(), `status ${login.status()}`);
  const tok = (await login.json().catch(() => ({}))).token || "";
  const me = await ctx.request.get(base + "/api/auth/me", { headers: { authorization: "Bearer " + tok } });
  ok("GET /api/auth/me with Bearer from login response", me.ok(), `status ${me.status()}`);

  // ---- shared page walker: fresh page per step, console-error bucket --------
  const visit = async (name, url, waitSel, extraChecks) => {
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text() || "";
      if (/Failed to load resource/.test(text)) return; // honest-404 resource states, as designed
      errs.push(text + " @ " + (m.location()?.url || "?"));
    });
    let failed = false;
    try {
      await page.goto(base + url, { waitUntil: "domcontentloaded", timeout: 20000 });
      if (waitSel) await page.waitForSelector(waitSel, { timeout: 15000 });
      await page.waitForTimeout(1500); // settle async fetches before screenshot
    } catch (e) {
      failed = true; errs.push("goto/wait failed: " + String(e?.message || e).split("\n")[0]);
    }
    await page.screenshot({ path: path.join(SHOTS, name.replace(/[^a-z0-9-]/gi, "_") + ".png") }).catch(() => {});
    ok(`${name}: page loaded`, !failed);
    if (extraChecks) await extraChecks(page).catch((e) => ok(`${name}: checks`, false, String(e?.message || e)));
    ok(`${name}: no JS console errors`, errs.length === 0, errs.join(" | ").slice(0, 600));
    await page.close();
    return !failed;
  };

  section("page 1 — /#/ Projects (dashboard) — sign in via the product form");
  await visit("01-dashboard", "/#/", "#dash-body", async (p) => {
    await p.click("#auth-chip summary"); // open the sign-in popover
    await p.fill("#li-email", email);
    await p.fill("#li-pass", password);
    await p.click("#auth-chip #login-form button[type=submit]");
    await p.waitForSelector("#auth-chip .who.mono", { timeout: 10000 });
    ok("dashboard: auth chip shows session email after UI sign-in", (await p.textContent("#auth-chip")).includes(email));
  });

  section("page 2 — /#/new New Clone → create task via the UI form");
  let taskId = "";
  {
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await page.goto(base + "/#/new", { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector("#clone-form", { timeout: 15000 });
    await page.fill("#nc-url", targetUrl);
    await page.fill("#nc-instructions", "gate fixture task");
    await page.click("#nc-start");
    await page.waitForSelector("#nc-result:not([hidden])", { timeout: 20000 });
    taskId = String(await page.textContent("#nc-result b.mono")).trim();
    ok("task created via page-2 form (task id shown)", /^[A-Za-z0-9._:-]+$/.test(taskId), `got "${taskId}"`);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(SHOTS, "02-new-clone-queued.png") });
    ok("page 2: no JS console errors", errs.length === 0, errs.join(" | ").slice(0, 600));
    await page.close();
  }

  section("page 3 — /#/projects/:id/exploration (live exploration workspace)");
  await visit(`03-exploration`, `/#/projects/${encodeURIComponent(taskId)}/exploration`, "#ex-id", async (p) => {
    ok("exploration: workspace bound to the task id", (await p.textContent("#ex-id")).includes(taskId));
  });

  section("page 4 — /#/projects/:id/intelligence");
  await visit("04-intelligence", `/#/projects/${encodeURIComponent(taskId)}/intelligence`, "#wi-id", async (p) => {
    ok("intelligence: bound to the task id", (await p.textContent("#wi-id")).includes(taskId));
  });

  // Pages 5-8 are standalone documents taking ?job=:id. The task is mid-flight
  // (queued), so missing artifacts render the pages' designed honest states.
  section("page 5 — /pages/blueprint.html?job=:id");
  await visit("05-blueprint", `/pages/blueprint.html?job=${encodeURIComponent(taskId)}`, "body");

  section("page 6 — /pages/reconstruction.html?job=:id (swarm embed)");
  await visit("06-reconstruction", `/pages/reconstruction.html?job=${encodeURIComponent(taskId)}`, "body");

  section("page 7 — /pages/comparison.html?job=:id (QA)");
  await visit("07-comparison", `/pages/comparison.html?job=${encodeURIComponent(taskId)}`, "body");

  section("page 8 — /pages/final.html?job=:id");
  await visit("08-final", `/pages/final.html?job=${encodeURIComponent(taskId)}`, "body");

  section("land on /progress/:id (swarm build viewer)");
  await visit("09-progress", `/progress/${encodeURIComponent(taskId)}`, "#hud", async (p) => {
    ok("progress viewer: HUD present for the created task", (await p.textContent("#hud")).length > 0);
  });

  await browser.close();
} catch (e) {
  fail++;
  console.log(`FAIL  gate aborted — ${String(e?.message || e).slice(0, 400)}`);
} finally {
  killPlatform();
  fixture.close();
  const shots = fs.readdirSync(SHOTS).filter((f) => f.endsWith(".png"));
  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}  screenshots: ${shots.length} in artifacts/platform-ui-gate/`);
  if (fail > 0) process.exit(1);
}
