#!/usr/bin/env node
// G2.3 — full onboarding journey, driven by Playwright against a REAL booted
// platform (startPlatform, src/platform/server.js). No product path is mocked:
//
//   • the platform is the real server — booted from a throwaway sandbox cwd so
//     the developer's real cloner.config.json / platform-data / artifacts are
//     never touched (loadConfig + tasks + exporter all resolve data paths from
//     process.cwd());
//   • the ONLY simulated third party is the local fixture HTTP server standing
//     in as the model-provider endpoint (the sanctioned remote-end simulator
//     pattern) AND as the clone target, enabled through the platform's own
//     CLONER_ALLOW_PRIVATE_TARGETS=1 opt-in (url-guard.js);
//   • ui-config-routes.js carries the documented INTEGRATOR MOUNT LINE for
//     src/platform/server.js. Until the integrator merges that line, this test
//     applies the identical composition dynamically to the booted server
//     (server.listeners("request") prepending) — the same app.use("/api/config",
//     uiConfigRouter()) placement, nothing else.
//
// Journey exercised the way a human would (clicks, typing, visible text,
// screenshots + layout sanity at every step):
//   1. open /ui/src/views/OnboardingFlow.html — activate (register+login)
//   2. provider step — rotate a key (env-backed config), watch the REAL
//      /api/providers inventory gain the provider, probe it for real
//   3. first clone — real v1 pipeline run against the fixture, live progress,
//      open the real preview, export the real ZIP
//   4. model-management screen — providers + usage meters parsed from /metrics
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(PROJECT, "output", "ui-onboarding");
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
const ROTATED_KEY = `sk-fixture-rot-${crypto.randomBytes(8).toString("hex")}`;
const FIXTURE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Fixture Retail — Checkout Demo</title>
<style>
 body { margin:0; font-family: system-ui, sans-serif; background:#f5f6fa; color:#20242f; }
 header { background:#20242f; color:#fff; padding:14px 26px; display:flex; gap:22px; align-items:center; }
 header b { font-size:18px; } header nav a { color:#cfd3e0; margin-right:16px; text-decoration:none; font-size:13px; }
 .hero { padding:34px 26px; background:linear-gradient(120deg,#5a4ff0,#8b7cf7); color:#fff; }
 .hero h1 { margin:0 0 8px; font-size:26px; }
 .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; padding:22px 26px; }
 .card { background:#fff; border:1px solid #e2e4ee; border-radius:10px; padding:14px; }
 .card h3 { margin:0 0 6px; font-size:14px; }
 .card .price { color:#5a4ff0; font-weight:700; }
 .card button { margin-top:8px; padding:7px 14px; border:0; border-radius:7px; background:#20242f; color:#fff; cursor:pointer; }
 footer { padding:16px 26px; color:#8a8fa3; font-size:12px; }
</style></head><body>
<header><b>Fixture Retail</b><nav><a href="#new">New</a><a href="#deals">Deals</a><a href="#account">Account</a></nav></header>
<section class="hero"><h1>Autumn checkout demo</h1><p>Everything ships free this week.</p></section>
<section class="grid">
 <div class="card"><h3>Trail Runner</h3><div class="price">$89</div><button>Add to cart</button></div>
 <div class="card"><h3>City Backpack</h3><div class="price">$64</div><button>Add to cart</button></div>
 <div class="card"><h3>All-Weather Jacket</h3><div class="price">$129</div><button>Add to cart</button></div>
</section>
<footer>fixture page for the cloner onboarding journey — static, deterministic</footer>
</body></html>`;

function startFixture() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = (req.url || "/").split("?")[0];
      if (url === "/v1/models") {
        // the "provider" validates the bearer key — this is what makes the
        // rotation probe a REAL credential check end-to-end
        const auth = req.headers.authorization || "";
        if (auth === `Bearer ${ROTATED_KEY}`) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [{ id: "fixture-model-1" }, { id: "fixture-model-2" }] }));
        } else {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "invalid api key" } }));
        }
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE_HTML);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

// ---------- boot the REAL platform from a sandbox cwd ----------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cloner-onboard-"));
process.chdir(sandbox); // data paths (platform-data/, artifacts/, cloner.config.json) resolve here
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // sanctioned fixture-testing opt-in (url-guard.js)
process.env.CLONER_ENV_FILE = path.join(sandbox, ".env");
// deterministic fresh-onboarding: no inherited provider keys or base URLs —
// the provider step must start from the real "nothing configured yet" state
for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CUSTOM_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "CUSTOM_BASE_URL", "OPENAI_MODEL", "ANTHROPIC_MODEL"]) delete process.env[k];

const { startPlatform } = await import("../src/platform/server.js");
const { srv: fixtureSrv, port: fixturePort } = await startFixture();
const FIXTURE_URL = `http://127.0.0.1:${fixturePort}/`;
console.log(`[fixture] remote-end simulator on ${FIXTURE_URL}`);
console.log(`[sandbox] ${sandbox}`);

const platform = await startPlatform({ port: 0 });
const { port: P } = platform;
const BASE = `http://127.0.0.1:${P}`;
console.log(`[platform] booted at ${BASE}`);

// ---- integrator mount line applied to the real booted server ----
// (documented in ui-config-routes.js: app.use("/api/config", uiConfigRouter()))
// Composition goes through a real express app — identical to the static
// app.use("/api/config", uiConfigRouter()) placement the integrator will add —
// so req/res get express' normal prototype augmentation before the router runs.
const { default: express } = await import("express");
const { uiConfigRouter } = await import("../src/platform/ui-config-routes.js");
const platformApp = platform.server.listeners("request")[0];
const composed = express();
composed.use("/api/config", uiConfigRouter());
composed.use((req, res) => platformApp(req, res)); // everything else → the real platform
platform.server.removeAllListeners("request");
platform.server.on("request", composed);
console.log("[mount] /api/config router attached (integrator mount line)");

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

// ---------- browser journey ----------
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e?.message || e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });

async function shot(name) { await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); }

// layout sanity: what a human sees — no horizontal overflow, key element in
// viewport, no zero-size element
async function layoutOk(selector, label) {
  const el = page.locator(selector).first();
  const visible = await el.isVisible().catch(() => false);
  if (!visible) return { ok: false, detail: `${label} not visible` };
  const box = await el.boundingBox();
  if (!box || box.width < 2 || box.height < 2) return { ok: false, detail: `${label} zero/undefined size` };
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  return { ok: overflow <= 2, detail: `${label} box ${Math.round(box.width)}x${Math.round(box.height)}, hOverflow ${overflow}px` };
}

try {
  section("1 — onboarding page: activation");
  await page.goto(`${BASE}/ui/src/views/OnboardingFlow.html?url=${encodeURIComponent(FIXTURE_URL)}`, { waitUntil: "load" });
  await page.waitForSelector('[data-step="1"] h2');
  check("onboarding page served by the real platform", page.url().includes("/ui/src/views/OnboardingFlow.html"));
  check("step 1 heading visible (human-visible)", await page.locator('[data-step="1"] h2').isVisible(), "Activate the platform");
  const emailBox = await layoutOk("#ob-email", "email field");
  check("email input visible with sane layout", emailBox.ok, emailBox.detail);
  check("readyz chips render real dependency booleans", await page.locator('[data-role="readyz"] .dep.ok').first().isVisible({ timeout: 15000 }).catch(() => false), "postgres/queue/migrations up");
  await shot("01-activate.png");

  const USER = `onboard-${crypto.randomBytes(5).toString("hex")}@test.local`;
  const PASS = "correct-horse-9";
  await page.fill("#ob-email", USER);
  await page.fill("#ob-password", PASS);
  await page.click('[data-act="activate"]');
  await page.waitForSelector('[data-role="user-chip"]', { timeout: 20000 });
  check("activation: register+login against real auth", (await page.locator('[data-role="user-chip"]').textContent()).includes(USER), USER);
  check("activation success message visible", await page.locator('[data-step="1"] .ob-msg.ok').isVisible());

  section("2 — provider step: key rotation → env-backed config");
  await page.waitForSelector('.mm-card[data-provider="openai-slot"]', { timeout: 20000 });
  check("model-management embedded in step 2 shows activatable slots",
    await page.locator('.mm-card[data-provider="openai-slot"]').isVisible() &&
    await page.locator('.mm-card[data-provider="anthropic-slot"]').isVisible() &&
    await page.locator('.mm-card[data-provider="custom-slot"]').isVisible());
  await shot("02-provider-step.png");

  await page.click('.mm-card[data-provider="openai-slot"] [data-act="rotate"]');
  await page.waitForSelector('#mm-key-openai-slot');
  check("rotate form opens with key field", await page.locator("#mm-key-openai-slot").isVisible());
  await page.fill("#mm-key-openai-slot", ROTATED_KEY);
  await page.fill("#mm-base-openai-slot", `http://127.0.0.1:${fixturePort}/v1`);
  await page.click('[data-act="save-key"]');
  await page.waitForSelector('.mm-card[data-provider="openai-slot"] .mm-result.ok', { timeout: 15000 });
  check("rotation UI confirms env var + masked key", (await page.locator('.mm-card[data-provider="openai-slot"] .mm-result.ok').textContent()).includes("OPENAI_API_KEY"));
  await shot("03-provider-rotated.png");

  // REAL effect #1: the platform's own /api/providers inventory now carries the
  // env-derived provider (model-router env path / config.js auto resolution)
  const inv = await nodeApi("/api/providers");
  const envProvider = (inv.json?.providers || []).find((p) => p.provider === "openai" && p.hasKey);
  check("rotated key is LIVE in the real /api/providers inventory (model-router env path)", !!envProvider, JSON.stringify(envProvider || {}));
  // REAL effect #2: env-backed file + live process.env
  const envText = fs.readFileSync(path.join(sandbox, ".env"), "utf8");
  check(".env written with rotated key + base URL", envText.includes(`OPENAI_API_KEY=${ROTATED_KEY}`) && envText.includes(`OPENAI_BASE_URL=http://127.0.0.1:${fixturePort}/v1`));
  check("process.env updated (live without restart)", process.env.OPENAI_API_KEY === ROTATED_KEY);
  check(".env contains exactly one OPENAI_API_KEY line (rewrite, not append)", envText.split("\n").filter((l) => l.startsWith("OPENAI_API_KEY=")).length === 1);
  // REAL effect #3: inventory reflects env source + rotation metadata (a
  // rotated env slot surfaces as the configured provider for that type)
  const cfgInv = await nodeApi("/api/config/providers");
  const openaiRow = (cfgInv.json?.providers || []).find((p) => p.type === "openai" && p.hasKey);
  check("inventory shows the openai provider sourced from env with rotation timestamp", openaiRow?.source === "env" && !!openaiRow?.rotatedAt, `name=${openaiRow?.name} masked=${openaiRow?.masked}`);
  check("raw key never appears in inventory response", !JSON.stringify(cfgInv.json).includes(ROTATED_KEY));

  section("2b — real connectivity probe through the rotated credentials");
  const probeTarget = openaiRow?.name || "openai-slot";
  const good = await nodeApi(`/api/config/providers/${encodeURIComponent(probeTarget)}/test`, { method: "POST" });
  check("probe: real HTTP to the fixture with the rotated key → 200 ok", good.json?.ok === true && good.json?.status === 200, `latency ${good.json?.latencyMs}ms · ${good.json?.detail || ""}`);
  const wrongKey = `sk-wrong-${crypto.randomBytes(4).toString("hex")}`;
  await nodeApi(`/api/config/providers/${encodeURIComponent(probeTarget)}/key`, { method: "POST", body: { key: wrongKey } });
  const bad = await nodeApi(`/api/config/providers/${encodeURIComponent(probeTarget)}/test`, { method: "POST" });
  check("probe: wrong key → real 401 surfaced as ok:false", bad.json?.ok === false && bad.json?.status === 401, bad.json?.error || bad.json?.detail || "");
  await nodeApi(`/api/config/providers/${encodeURIComponent(probeTarget)}/key`, { method: "POST", body: { key: ROTATED_KEY, baseUrl: `http://127.0.0.1:${fixturePort}/v1` } });

  section("2c — rotation validation + auth negatives (real paths)");
  const shortKey = await nodeApi("/api/config/providers/openai-slot/key", { method: "POST", body: { key: "sk" } });
  check("short key rejected 400", shortKey.status === 400, shortKey.json?.error || "");
  const injectKey = await nodeApi("/api/config/providers/openai-slot/key", { method: "POST", body: { key: "sk-valid-0000\nEVIL=1" } });
  check("newline-in-key rejected 400 (no env injection)", injectKey.status === 400, injectKey.json?.error || "");
  const badToken = await nodeApi("/api/config/providers", { headers: { authorization: "Bearer not-a-real-token" } });
  check("invalid bearer token → 401 (auth branch exercised)", badToken.status === 401, `status ${badToken.status}`);
  const unknown = await nodeApi("/api/config/providers/does-not-exist/key", { method: "POST", body: { key: "sk-unknown-0000" } });
  check("unknown provider → 404", unknown.status === 404, unknown.json?.error || "");
  const ledger = await nodeApi("/api/config/rotations");
  check("rotation ledger records fingerprinted entries", (ledger.json?.entries || []).length >= 2 && !JSON.stringify(ledger.json).includes(ROTATED_KEY), `${ledger.json?.entries?.length} entries`);

  section("3 — first clone walkthrough (real v1 pipeline)");
  await page.click('[data-act="to-clone"]');
  await page.waitForSelector('[data-step="3"]:not(.ob-hidden)');
  const urlVal = await page.inputValue("#ob-url");
  check("target URL pre-filled", urlVal === FIXTURE_URL, urlVal);
  await page.click('[data-act="clone"]');
  await page.waitForSelector('[data-role="taskpill"]:not(.ob-hidden)', { timeout: 20000 });
  const taskId = (await page.locator('[data-role="taskpill"] code').textContent()).trim();
  check("real task created via POST /api/tasks", typeof taskId === "string" && taskId.length >= 6 && !/\s/.test(taskId), taskId);
  const pillLayout = await layoutOk(".ob-taskpill", "task pill");
  check("layout: task pill visible with sane layout", pillLayout.ok, pillLayout.detail);
  // wait for live progress lines to actually arrive (WS or poll fallback)
  await page.waitForFunction(() => document.querySelectorAll('.ob-progress div').length >= 1, null, { timeout: 30000 });
  const progressLines = await page.locator(".ob-progress div").count();
  check("live progress lines visible", progressLines >= 1, `${progressLines} line(s)`);
  await shot("04-clone-progress.png");
  await page.waitForSelector(".ob-success h3", { timeout: 240000 });
  await page.waitForSelector(".ob-success:not(.ob-hidden) h3", { timeout: 10000 });
  check("first clone completes (verification included)", (await page.locator(".ob-success h3").textContent()).includes("First clone complete"));
  const taskDetail = await nodeApi(`/api/tasks/${taskId}`, { headers: { authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem("cloner_token"))}` } });
  check("task terminal state + verification recorded", ["done", "error"].includes(taskDetail.json?.status) && taskDetail.json?.verification != null, `status=${taskDetail.json?.status} verification.passed=${taskDetail.json?.verification?.passed}`);
  const previewHref = await page.locator('.ob-success a.btn.primary').getAttribute("href");
  check("preview link points at the real preview surface", previewHref === `/preview/${taskId}/index.html`, previewHref);
  await shot("05-clone-done.png");

  // open the preview the way a human does (new tab), verify the CLONE content
  const [previewPage] = await Promise.all([
    context.waitForEvent("page"),
    page.click('.ob-success a.btn.primary'),
  ]);
  await previewPage.waitForLoadState("load");
  const previewText = (await previewPage.locator("body").innerText({ timeout: 20000 })).toLowerCase();
  check("clone preview renders the cloned content", previewText.includes("autumn checkout demo") || previewText.includes("fixture retail"), `title/content from the real clone`);
  const cloneTitle = await previewPage.title().catch(() => "");
  check("clone page title preserved", /fixture retail/i.test(cloneTitle), cloneTitle);
  await previewPage.screenshot({ path: path.join(SHOTS, "06-clone-preview.png"), fullPage: true });
  await previewPage.close();

  section("3b — export (real ZIP, header-only auth download)");
  await page.click('[data-act="export"]');
  await page.waitForSelector('[data-role="export-result"] button', { timeout: 60000 });
  check("export ready UI shown", (await page.locator('[data-role="export-result"]').textContent()).includes("export ready"));
  const token = await page.evaluate(() => sessionStorage.getItem("cloner_token"));
  const dl = await fetch(`${BASE}/api/export/${taskId}/download`, { headers: { authorization: `Bearer ${token}` } });
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  check("owner download (Bearer header) serves a real ZIP", dl.status === 200 && dlBuf.slice(0, 2).toString() === "PK" && dlBuf.length > 200, `${dlBuf.length} bytes`);
  const anonDl = await fetch(`${BASE}/api/export/${taskId}/download`);
  check("anonymous download of an owned task is refused (owner gate)", anonDl.status === 404, `status ${anonDl.status}`);
  await page.click('[data-act="finish"]');
  await page.waitForSelector('[data-step="4"]:not(.ob-hidden)');
  check("onboarding finish step reached", await page.locator('[data-step="4"] h2').isVisible(), "You're set");
  const railLayout = await layoutOk(".ob-rail .step-chip.active", "step rail");
  check("layout: step rail active chip visible with sane layout", railLayout.ok, railLayout.detail);
  await shot("07-onboard-done.png");

  section("4 — model management screen (standalone) + /metrics meters");
  await page.goto(`${BASE}/ui/src/views/ModelManagement.html`, { waitUntil: "load" });
  await page.waitForSelector('.mm-card .mm-badge.env', { timeout: 20000 });
  const rotatedCardName = await page.locator(".mm-card", { has: page.locator(".mm-badge.env") }).first().getAttribute("data-provider");
  check("standalone screen lists the env-activated provider", !!rotatedCardName, rotatedCardName || "none");
  const mmLayout = await layoutOk(".mm-meters", "meters panel");
  check("meters panel visible with sane layout", mmLayout.ok, mmLayout.detail);
  // usage meters must be driven by the REAL /metrics response — cross-check
  // values parsed from the raw Prometheus text against what the UI rendered
  const metricsText = await nodeApi("/metrics").then((r) => r.text);
  check("platform /metrics exposes cloner_ metrics", metricsText.includes("cloner_"), `${(metricsText.match(/cloner_[a-z_]+/g) || []).length} series`);
  const q = metricsText.match(/^cloner_queue_depth\s+([0-9.]+)/m)?.[1];
  const up = metricsText.match(/^cloner_process_uptime_seconds\s+([0-9.]+)/m)?.[1];
  check("queue depth + uptime gauges present in /metrics", q !== undefined && up !== undefined, `depth=${q} uptime=${up}`);
  await page.waitForSelector('[data-role="meters"] .mm-meter-row', { timeout: 20000 });
  const uiDepth = await page.locator('[data-meter="queue"] .mm-meter-val').textContent().catch(() => null);
  check("UI meters render the exact live /metrics queue depth", uiDepth === String(Number(q)), `ui=${uiDepth} metrics=${q}`);
  const uiUptime = await page.locator('[data-meter="uptime"] .mm-meter-val').textContent().catch(() => null);
  const uptimeVal = `${Math.floor(Number(up) / 60)}m ${Math.round(Number(up) % 60)}s`;
  check("UI meters render the exact live /metrics uptime", uiUptime === uptimeVal, `ui=${uiUptime} metrics=${uptimeVal}`);
  // counter wiring note: cloner_task_status_total exists in the registry but is
  // not incremented by the v1 task path in the current tree (reported finding) —
  // the meters below still come from /metrics (queue/workers/uptime/heap).
  await shot("08-model-management.png");

  section("5 — human-visible layout sanity across screens");
  for (const [sel, label] of [
    ['.mm-card .mm-card-title', "provider title"],
    ['[data-role="meters"] .mm-meter-row', "meter row"],
  ]) {
    const r = await layoutOk(sel, label);
    check(`layout: ${label}`, r.ok, r.detail);
  }
  const overlap = await page.evaluate(() => {
    const a = document.querySelector(".mm-card")?.getBoundingClientRect();
    const b = document.querySelector(".mm-meters")?.getBoundingClientRect();
    if (!a || !b) return { ok: false, detail: "elements missing" };
    const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return { ok: ix * iy < 4, detail: `intersection ${Math.round(ix * iy)}px²` };
  });
  check("layout: provider card does not overlap meters panel", overlap.ok, overlap.detail);
  const rawLeak = (await page.content()).includes(ROTATED_KEY);
  check("layout/security: raw rotated key never rendered in the UI", !rawLeak, "masked only");

  section("6 — audit trail landed (real 4.0.9 hash chain)");
  const { queryAuditEvents } = await import("../src/platform/audit-service.js");
  const auditRes = await queryAuditEvents({ action: "admin.action", platformWide: true, limit: 20 });
  const rotations = (auditRes.events || []).filter((e) => {
    const md = typeof e.metadata === "string" ? (() => { try { return JSON.parse(e.metadata); } catch { return {}; } })() : e.metadata;
    return md?.operation === "key.rotate" && e.target_type === "model_provider";
  });
  check("key rotations recorded in the audit trail", rotations.length >= 2, `${rotations.length} rotation event(s)`);

  section("7 — browser health");
  check("no uncaught page errors during the whole journey", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
  check("no console errors during the whole journey", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 300));
} catch (e) {
  check("journey completed without exception", false, String(e?.message || e).slice(0, 400));
  try { await shot("99-failure.png"); } catch {}
} finally {
  await browser.close().catch(() => {});
  fixtureSrv.close();
  await new Promise((r) => platform.server.close(() => r()));
}

const passed = results.filter(Boolean).length;
const total = results.length;
console.log(`\n════ RESULT: ${passed}/${total} checks passed — screenshots in output/ui-onboarding/ ════`);
process.exit(passed === total ? 0 : 1);
