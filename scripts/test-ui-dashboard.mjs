#!/usr/bin/env node
// G2.1 ui-dashboard — REAL Playwright test of the platform dashboard screens.
//
// What it does (no mocks anywhere — every byte on screen comes from the booted
// platform's real endpoints):
//   1. boots a real fixture HTTP server + the real platform (startPlatform),
//      from an isolated temp cwd so the task store is this run's own (the
//      vision model is switched to provider "none" there so the seed task does
//      not depend on an external LLM endpoint — the platform's documented
//      no-model posture; all other data is real),
//   2. opens /ui/dist/dashboard/index.html (the built Vue dashboard) in
//      headless Chromium,
//   3. registers + signs in a real user through the UI form (real
//      /api/auth/register + /api/auth/login + real quota scope in Postgres),
//   4. seeds a real clone task as that user through POST /api/tasks (v1
//      pipeline: real headless-browser clone of the local fixture),
//   5. asserts the task history table renders the REAL row and its status
//      badge transitions live (queued → running → verifying → done) via the
//      dashboard's own polling,
//   6. asserts the quota widgets render the REAL usage numbers (jobs started
//      today ≥ 1 after the seeded task, storage bytes, limits) and
//      cross-checks them against GET /api/dashboard,
//   7. opens the per-task detail: stages timeline (real history events),
//      artifacts (real artifact table), verification cards (real 3-stage
//      verification report), clone preview,
//   8. walks the legacy workspace → Dashboard button link,
//   9. screenshots every step into output/ui-dashboard/ and runs human-eye
//      layout checks (no horizontal overflow, cards visible/non-overlapping).
//
// SKIP contract: if the compose Postgres (5433) is unreachable, prints SKIP
// lines and exits 0 (auth + quota need the database).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// isolated run dir FIRST: platform-data, artifacts and cloner.config.json are
// cwd-relative and resolved at module load, so nothing may import the platform
// before this chdir. provider "none" + polish off keeps the seeded clone on the
// deterministic no-model path (cloneUrl.js skips vision polish entirely).
const RUNDIR = fs.mkdtempSync(path.join(os.tmpdir(), "cloner-ui-dash-"));
fs.writeFileSync(path.join(RUNDIR, "cloner.config.json"), JSON.stringify({
  model: { provider: "none" },
  polish: { enabled: false },
}));
process.chdir(RUNDIR);
// the fixture target is loopback — the SSRF guard would (correctly) reject it;
// this test explicitly opts in (same posture as scripts/test-platform.mjs)
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1";

const SHOTS = path.join(PROJECT, "output", "ui-dashboard");
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n-- ${t} --`);

const watchdog = setTimeout(() => { console.log("FAIL  global timeout (420s)"); process.exit(1); }, 420_000);
watchdog.unref();

const TAG = "dashg21" + Math.random().toString(36).slice(2, 8);
const EMAIL = `${TAG}@ui.test`;
const PASSWORD = "dashboard-pass-1";

// ---------- database probe (SKIP contract) ----------
try {
  const { query } = await import("../src/database/client.js");
  await query("SELECT 1");
} catch (e) {
  const msg = `docker compose Postgres unreachable (${String(e?.message || e).slice(0, 120)}) — start it with: docker compose up -d postgres`;
  for (let i = 0; i < 40; i++) console.log(`SKIP  dashboard check ${i + 1}/40 — ${msg}`);
  console.log(`\nRESULT: SKIP  (0/40 checks run — database unavailable)`);
  process.exit(0);
}
// quota/auth tables must exist before the platform uses them (boot migrate()
// is fire-and-forget; this ordered run is idempotent)
try {
  const { migrate } = await import("../src/database/client.js");
  await migrate();
} catch (e) {
  console.log("FAIL  migrations failed — " + String(e?.message || e).slice(0, 200));
  process.exit(1);
}

// ---------- boot: fixture server + real platform ----------
const fixture = await new Promise((resolve, reject) => {
  const srv = http.createServer((req, res) => {
    const body = `<!doctype html><html><head><title>dashboard fixture ${TAG}</title>
<style>body{font-family:sans-serif;margin:40px}h1{color:#2244aa}button{padding:8px 14px}</style></head>
<body><h1 id="hd">Fixture ${TAG}</h1><p id="p1">A tiny page for the dashboard e2e clone.</p>
<button id="b1" onclick="document.getElementById('p1').textContent='clicked'">click me</button></body></html>`;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  srv.listen(0, "127.0.0.1", () => resolve(srv));
  srv.on("error", reject);
});
const FIXTURE_URL = `http://127.0.0.1:${fixture.address().port}/fixture-dashboard.html`;

const { startPlatform } = await import("../src/platform/server.js");
const platform = await startPlatform({ port: 0 });
const PORT = platform.port;
console.log(`fixture on :${fixture.address().port} · platform on :${PORT} · rundir ${RUNDIR}`);

async function api(p, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// ---------- playwright ----------
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const consoleErrors = [];
page.on("pageerror", (e) => {
  // attribution: pageerror is only a dashboard-surface failure when the page is
  // ON the dashboard app at fire time (the legacy workspace page is a different
  // task's deliverable — its noise is out of scope for this gate)
  const url = page.url();
  const onDashboard = url.includes("/ui/dist/dashboard/");
  console.log(`[pageerror@${onDashboard ? "dashboard" : "other"}] url=${url.slice(0, 90)} err=${String(e).slice(0, 160)}`);
  if (onDashboard) consoleErrors.push("pageerror: " + String(e).slice(0, 200));
});
// the console gate judges the DASHBOARD surfaces only (the legacy workspace
// page is a different task's deliverable and may carry unrelated noise)
page.on("console", (m) => {
  if (m.type() !== "error") return;
  if (!page.url().includes("/ui/dist/dashboard/")) return;
  consoleErrors.push("console: " + m.text().slice(0, 200));
});

const shot = (name) => page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
const DASH_URL = `http://127.0.0.1:${PORT}/ui/dist/dashboard/index.html#/`;
let seededId = null;
let uiToken = null;

try {
  // ============================================================
  section("A. dashboard boots and renders the real empty state");
  await page.goto(DASH_URL, { waitUntil: "load" });
  await page.waitForSelector('[data-testid="dashboard-root"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="summary-cards"]', { timeout: 15000 });
  // wait for the first real fetch to land (cards show numbers, not "…")
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="card-total"] .stat-num');
    return el && el.textContent !== "…";
  }, { timeout: 15000 });
  check("A1: dashboard root + summary cards render with fetched data", true);
  const total0 = (await page.textContent('[data-testid="card-total"] .stat-num'))?.trim();
  check("A2: real empty store → total tasks 0", total0 === "0", `total=${total0}`);
  const overflowDash = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("A3: no horizontal overflow at 1280×800", overflowDash <= 1, `scrollWidth-clientWidth=${overflowDash}`);
  await shot("01-dashboard-initial.png");

  // human-eye layout: the five summary cards visible, non-overlapping, ordered
  const cardBoxes = await page.$$eval('[data-testid="summary-cards"] > .card',
    (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
  check("A4: five summary cards visible with sane boxes",
    cardBoxes.length === 5 && cardBoxes.every((b) => b.w > 40 && b.h > 30),
    JSON.stringify(cardBoxes.map((b) => `${Math.round(b.w)}x${Math.round(b.h)}`)));
  const overlap = cardBoxes.some((a, i) => cardBoxes.some((b, j) => j > i &&
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
  check("A5: summary cards do not overlap", !overlap);

  // ============================================================
  section("B. real register + sign-in through the UI form");
  await page.fill('[data-testid="auth-email"]', EMAIL);
  await page.fill('[data-testid="auth-password"]', PASSWORD);
  await shot("02-auth-filled.png");
  await page.click('[data-testid="auth-register"]');
  await page.waitForSelector('[data-testid="auth-state"]', { timeout: 20000 });
  const authState = (await page.textContent('[data-testid="auth-state"]')) || "";
  check("B1: register+login through UI lands a signed-in state", authState.includes(EMAIL), authState.trim().slice(0, 80));
  uiToken = await page.evaluate(() => localStorage.getItem("cloner_token") || "");
  check("B2: real session token stored", uiToken.length >= 32, `len=${uiToken.length}`);
  const meRes = await api("/api/auth/me", { token: uiToken });
  check("B3: /api/auth/me accepts the UI session", meRes.status === 200 && meRes.json?.email === EMAIL, `status=${meRes.status}`);
  await shot("03-auth-signed-in.png");

  // quota widgets appear for the real scope
  await page.waitForSelector('[data-testid="quota-meters"]', { timeout: 10000 });
  const quotaBefore = await api("/api/dashboard", { token: uiToken });
  check("B4: /api/dashboard returns ok + available quota for the session",
    quotaBefore.status === 200 && quotaBefore.json?.ok === true && quotaBefore.json?.quota?.available === true,
    `status=${quotaBefore.status}`);
  const meterTexts = await page.$$eval('[data-testid="quota-meters"] .meter-value', (els) => els.map((e) => e.textContent?.trim()));
  check("B5: five real quota meters render", meterTexts.length === 5, JSON.stringify(meterTexts));
  check("B6: storage meter shows real bytes (starts at 0)",
    meterTexts.some((t) => /^0(\.\d+)? (B|KB)\b/.test(t || "")), JSON.stringify(meterTexts));
  const dayInUi = await page.textContent('[data-testid="quota-panel"] .card-title');
  check("B7: quota panel stamps the real scope + UTC day", /scope user:/.test(dayInUi || "") && /day \d{4}-\d{2}-\d{2}/.test(dayInUi || ""), (dayInUi || "").trim().slice(0, 100));

  // ============================================================
  section("C. seed a real task; table renders it with live status transitions");
  const created = await api("/api/tasks", { method: "POST", token: uiToken, body: { url: FIXTURE_URL, instructions: `g2.1 dashboard seed ${TAG}` } });
  check("C1: POST /api/tasks (v1) accepted", created.status === 200 && !!created.json?.id, `status=${created.status} ${JSON.stringify(created.json).slice(0, 120)}`);
  seededId = created.json?.id || null;

  const rowSel = `[data-testid="task-row-${seededId}"]`;
  await page.waitForSelector(rowSel, { timeout: 15000 });
  check("C2: seeded task row appears in the table without manual reload", true);

  // live statuses: poll the real badge until done; require ≥2 distinct states
  const seenStatuses = new Set();
  const deadline = Date.now() + 240_000;
  let finalStatus = "";
  while (Date.now() < deadline) {
    const el = await page.$(`[data-testid="task-status-${seededId}"]`);
    const s = el ? (await el.textContent())?.trim() : "";
    if (s) seenStatuses.add(s);
    if (s === "done" || s === "error") { finalStatus = s; break; }
    await page.waitForTimeout(600);
  }
  check("C3: task reaches terminal status 'done' in the UI", finalStatus === "done",
    `statuses=[${[...seenStatuses].join(" → ")}]`);
  check("C4: live status transitions observed (≥2 distinct states)", seenStatuses.size >= 2,
    `[${[...seenStatuses].join(", ")}]`);
  await shot("04-dashboard-task-done.png");

  // the whole store is this run's own → exact counts are assertable
  await page.click('[data-testid="btn-refresh"]');
  await page.waitForTimeout(1200);
  const totalAfter = (await page.textContent('[data-testid="card-total"] .stat-num'))?.trim();
  const doneAfter = (await page.textContent('[data-testid="card-done"] .stat-num'))?.trim();
  const rowCount = await page.$$eval('[data-testid="task-table"] tbody tr.task-row', (els) => els.length);
  check("C5: summary cards match the real store (1 task, done)",
    totalAfter === "1" && doneAfter === "1" && rowCount === 1, `total=${totalAfter} done=${doneAfter} rows=${rowCount}`);

  // verification badge on the row
  const rowVerify = await page.$(`[data-testid="task-verify-${seededId}"] .badge`);
  const rowVerifyText = rowVerify ? (await rowVerify.textContent())?.trim() : "";
  check("C6: row verification badge renders a real verdict", rowVerifyText === "passed" || rowVerifyText === "failed", `badge="${rowVerifyText}"`);

  // ============================================================
  section("D. quota widgets reflect the real accounting");
  const dashAfter = await api("/api/dashboard", { token: uiToken });
  const usage = dashAfter.json?.quota?.usage;
  check("D1: quota usage counts the seeded job (jobsStartedToday ≥ 1)",
    !!usage && Number(usage.jobsStartedToday) >= 1,
    usage ? `started=${usage.jobsStartedToday} completed=${usage.jobsCompletedToday} storage=${usage.storageBytesUsed}` : "no usage block");
  const dailyText = (await page.textContent('[data-testid="quota-value-daily"]'))?.trim() || "";
  const startedInUi = parseInt(dailyText, 10);
  check("D2: UI 'jobs today' meter shows the real count", startedInUi >= 1, `meter="${dailyText}" api=${usage?.jobsStartedToday}`);
  check("D3: UI meters agree with /api/dashboard usage",
    usage ? startedInUi === Number(usage.jobsStartedToday) : false, `ui=${startedInUi}`);
  await shot("05-quota-after-usage.png");

  // ============================================================
  section("E. per-task detail: timeline, artifacts, verification, preview");
  await page.click(rowSel);
  await page.waitForSelector('[data-testid="task-detail-root"]', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="detail-loading"]'), { timeout: 15000 });
  check("E1: row click opens the detail screen", (await page.evaluate(() => location.hash)).startsWith(`#/tasks/${seededId}`));
  const detailId = (await page.textContent('[data-testid="detail-id"]'))?.trim();
  check("E2: detail renders the real task id", detailId === seededId, `id=${detailId}`);
  const detailStatus = (await page.textContent('[data-testid="detail-status"]'))?.trim();
  check("E3: detail renders the real status", detailStatus === "done", `status=${detailStatus}`);

  const eventCount = await page.$$eval('[data-testid="detail-timeline"] .tl-item', (els) => els.length);
  check("E4: stages timeline shows real history events (≥3)", eventCount >= 3, `events=${eventCount}`);
  const tlTexts = await page.$$eval('[data-testid="detail-timeline"] .tl-title', (els) => els.slice(0, 6).map((e) => e.textContent?.trim()));
  check("E5: timeline carries the real pipeline events",
    tlTexts.some((t) => /clone started/i.test(t || "")) && tlTexts.some((t) => /verif/i.test(t || "")),
    JSON.stringify(tlTexts));
  await shot("06-detail-timeline.png");

  await page.click('[data-testid="detail-tab-artifacts"]');
  await page.waitForSelector('[data-testid="artifact-table"]', { timeout: 10000 });
  const artifactRows = await page.$$eval('[data-testid="artifact-row"]', (els) => els.map((e) => e.querySelector("td")?.textContent?.trim()));
  check("E6: real artifact table (≥4 entries incl. index.html)", artifactRows.length >= 4 && artifactRows.includes("index"),
    JSON.stringify(artifactRows));
  await shot("07-detail-artifacts.png");

  await page.click('[data-testid="detail-tab-verification"]');
  await page.waitForSelector('[data-testid="detail-verification"]', { timeout: 10000 });
  const verCards = await page.$$eval('[data-testid="detail-verification"] .ver-card', (els) =>
    els.map((e) => ({ stage: e.getAttribute("data-testid"), status: e.querySelector(".badge")?.textContent?.trim() })));
  check("E7: three real verification stage cards render",
    verCards.length === 3 && verCards.every((c) => c.status === "passed" || c.status === "failed"),
    JSON.stringify(verCards));
  const checkLines = await page.$$eval('[data-testid="detail-verification"] .check', (els) => els.length);
  check("E8: verification cards carry real check lines (≥3)", checkLines >= 3, `lines=${checkLines}`);
  await shot("08-detail-verification.png");

  await page.click('[data-testid="detail-tab-preview"]');
  await page.waitForSelector('[data-testid="preview-frame"]', { timeout: 10000 });
  await page.waitForFunction(() => {
    const f = document.querySelector('[data-testid="preview-frame"]');
    try { return !!(f && f.contentDocument && f.contentDocument.readyState === "complete" && f.contentDocument.body); } catch { return false; }
  }, { timeout: 15000 }).catch(() => {});
  const frameText = await page.evaluate(() => {
    try { return document.querySelector('[data-testid="preview-frame"]').contentDocument.body.innerText || ""; } catch { return ""; }
  });
  check("E9: clone preview iframe serves the real clone content", frameText.includes("Fixture"), `frameText="${frameText.slice(0, 60)}"`);
  await shot("09-detail-preview.png");

  // back to dashboard via the router link
  await page.click('[data-testid="back-to-dashboard"]');
  await page.waitForSelector('[data-testid="dashboard-root"]', { timeout: 10000 });
  check("E10: back-to-dashboard returns to the table", true);

  // ============================================================
  section("F. session persistence + workspace → Dashboard link");
  // dashboard-owned session persistence: a plain reload of the dashboard page
  // must keep the session (localStorage token + /api/auth/me)
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector('[data-testid="dashboard-root"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="auth-state"]', { timeout: 15000 });
  const authAfterReload = (await page.textContent('[data-testid="auth-state"]')) || "";
  check("F1: dashboard reload keeps the session signed-in", authAfterReload.includes(EMAIL), authAfterReload.trim().slice(0, 80));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
  const dashBtn = await page.$('#btn-dashboard');
  check("F2: workspace top bar carries the Dashboard link", !!dashBtn);
  if (dashBtn) {
    await dashBtn.click();
    await page.waitForSelector('[data-testid="dashboard-root"]', { timeout: 15000 });
    check("F3: Dashboard link opens the built dashboard app", true);
    await shot("10-workspace-to-dashboard.png");
    // CROSS-PAGE FINDING (outside this task's ownership): the legacy workspace
    // page's auth chip (platform-ui/auth.js:131) renders `me.email` while only
    // `currentMe` is defined — the ReferenceError lands in its catch, which
    // calls setToken("") and WIPES the dashboard session. Logged here as a
    // WARN so the integrator / frontend-hunt pass has the exact evidence.
    const tokenAfterWorkspace = await page.evaluate(() => localStorage.getItem("cloner_token") || "");
    if (!tokenAfterWorkspace) {
      console.log("WARN  crossing the workspace page clears the dashboard session — platform-ui/auth.js:131 uses `me.email` (ReferenceError → catch → setToken(\"\",\"\")); fix is `currentMe.email` (owner: auth.js author / G5.1)");
      try {
        await page.fill('[data-testid="auth-email"]', EMAIL);
        await page.fill('[data-testid="auth-password"]', PASSWORD);
        await page.click('[data-testid="auth-login"]');
        await page.waitForSelector('[data-testid="auth-state"]', { timeout: 15000 });
        console.log("WARN  re-signed-in on the dashboard to continue the journey");
      } catch {}
    }
  }

  // ============================================================
  section("G. human-eye console gate (dashboard pages)");
  check("G1: zero page/console errors on dashboard surfaces", consoleErrors.length === 0,
    consoleErrors.slice(0, 4).join(" | "));
} catch (e) {
  check("UNEXPECTED failure", false, String(e?.message || e).slice(0, 300));
  try { await shot("99-unexpected.png"); } catch {}
} finally {
  // ---------- cleanup: seeded task + the test user ----------
  try {
    if (seededId && uiToken) {
      const del = await api(`/api/tasks/${seededId}`, { method: "DELETE", token: uiToken });
      console.log(`cleanup: DELETE task ${seededId} → ${del.status}`);
    }
  } catch {}
  try {
    const { query, closePool } = await import("../src/database/client.js");
    await query("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)", [EMAIL]);
    await query("DELETE FROM quota_usage_events WHERE scope_id IN (SELECT id FROM users WHERE email = $1)", [EMAIL]);
    await query("DELETE FROM quota_usage_daily WHERE scope_id IN (SELECT id FROM users WHERE email = $1)", [EMAIL]);
    await query("DELETE FROM quota_reservations WHERE scope_id IN (SELECT id FROM users WHERE email = $1)", [EMAIL]);
    await query("DELETE FROM users WHERE email = $1", [EMAIL]);
    await closePool();
    console.log(`cleanup: removed test user ${EMAIL}`);
  } catch (e) {
    console.log(`cleanup: user cleanup failed (non-fatal): ${String(e?.message || e).slice(0, 120)}`);
  }
  try { await browser.close(); } catch {}
  try { platform.server.close(); } catch {}
  try { fixture.close(); } catch {}
  try { fs.rmSync(RUNDIR, { recursive: true, force: true }); } catch {}
}

const passed = results.filter(Boolean).length;
console.log(`\nRESULT: ${passed}/${results.length} checks passed — screenshots in ${path.relative(PROJECT, SHOTS)}`);
process.exit(passed === results.length ? 0 : 1);
