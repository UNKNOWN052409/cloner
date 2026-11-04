// G5.5 export probe — isolate why the onboarding "Export ZIP" click never
// renders its result link even though the server writes export.zip.
// Fast loop: clone https://example.com (small), click Export in the REAL UI,
// capture the POST /api/export/:id response timing from the browser's view.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { startPlatform } from "../src/platform/server.js";

const PORT = 4191;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.CLONER_ENV_FILE = path.join(process.cwd(), "artifacts", "g55-journey-downloads", "probe.env");

const platform = await startPlatform({ port: PORT });
const { uiConfigRouter } = await import("../src/platform/ui-config-routes.js");
const router = uiConfigRouter();
const existing = platform.server.listeners("request");
const expressApp = existing[0];
const runExisting = (req, res) => existing.forEach((h) => h.call(platform.server, req, res));
platform.server.removeAllListeners("request");
platform.server.on("request", (req, res) => {
  if (!req.url.startsWith("/api/config")) return runExisting(req, res);
  // same init the express app's expressInit middleware performs (req/res links)
  req.res = res; res.req = req; req.next = null;
  res.locals = res.locals || Object.create(null);
  if (expressApp) {
    Object.setPrototypeOf(req, expressApp.request);
    Object.setPrototypeOf(res, expressApp.response);
  }
  const original = req.url;
  req.url = original.slice("/api/config".length) || "/";
  router(req, res, () => { req.url = original; runExisting(req, res); });
});

const email = `probe.${Date.now()}@journey.dev`;
const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "Probe!Pass1x" }) });
const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "Probe!Pass1x" }) });
const { token } = await login.json();
console.log("[probe] user registered, token acquired");

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
page.on("response", (r) => { if (r.status() >= 400) console.log(`[probe] HTTP ${r.status()} ${r.url().slice(0, 120)}`); });

// onboarding page with the session preset (boot path skips to provider step)
await page.goto(BASE + "/ui/src/views/OnboardingFlow.html", { waitUntil: "domcontentloaded" });
await page.evaluate((t) => sessionStorage.setItem("cloner_token", t), token);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".mm-card", { timeout: 15000 });
await page.click('[data-act="to-clone"]');
await page.type("#ob-url", "https://example.com", { delay: 10 });
const t0 = Date.now();
await page.click('[data-act="clone"]');
const created = (await (await page.waitForResponse((r) => r.url().includes("/api/tasks") && r.request().method() === "POST")).json()).id;
console.log(`[probe] task ${created}`);

// wait for the success card (small site — fast)
await page.waitForSelector(".ob-success", { timeout: 240000 });
console.log(`[probe] success card after ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// click Export ZIP and watch BOTH the POST response and the rendered anchor
const t1 = Date.now();
const respPromise = page.waitForResponse((r) => r.url().includes(`/api/export/`) && r.request().method() === "POST", { timeout: 240000 });
await page.click('[data-act="export"]');
console.log("[probe] export clicked");
const resp = await respPromise.then((r) => ({ status: r.status(), body: null })).catch((e) => ({ err: e.message.slice(0, 80) }));
console.log(`[probe] POST /api/export response after ${((Date.now() - t1) / 1000).toFixed(1)}s:`, JSON.stringify(resp));
if (resp.status) {
  try { console.log("[probe] body:", JSON.stringify(await (await resp).json?.() ?? {}).slice(0, 160)); } catch { /* resp object shape */ }
}
const anchor = await page.waitForSelector('[data-role="export-result"] a', { timeout: 30000 }).then(() => "anchor rendered").catch((e) => "NO ANCHOR: " + e.message.split("\n")[0]);
console.log(`[probe] ${anchor} at +${((Date.now() - t1) / 1000).toFixed(1)}s`);
const resultText = await page.textContent('[data-role="export-result"]').catch(() => "(gone)");
console.log("[probe] export-result text:", String(resultText).trim().slice(0, 140));

await browser.close();
process.exit(0);
