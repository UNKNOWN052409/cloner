// Capture the app's own contract-search index response (it is fetched with the
// app's auth headers, so we record the response body as the page loads).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const EVID = path.join(ROOT, "artifacts", "tradovate-live-capture", "evidence");
const env = {};
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) { const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctxOpts = { viewport: { width: 1440, height: 900 }, locale: "en-US" };
if (fs.existsSync(path.join(EVID, "live-session.json"))) ctxOpts.storageState = path.join(EVID, "live-session.json");
const ctx = await browser.newContext(ctxOpts);
const ss = JSON.parse(fs.readFileSync(path.join(EVID, "live-session-storage.json"), "utf8"));
await ctx.addInitScript((e) => { try { if (/tradovate\.com$/.test(location.hostname)) for (const [k, v] of Object.entries(e.ss || {})) sessionStorage.setItem(k, String(v)); } catch {} }, ss);
const page = await ctx.newPage();

let catalog = null;
page.on("response", async (res) => {
  const url = res.url();
  if (!/search\?obfuscated|instruments|contracts|symbols/i.test(url)) return;
  const ct = res.headers()["content-type"] || "";
  if (!ct.includes("json") && !ct.includes("text")) return;
  try {
    const body = await res.text();
    if (body.length > 50000) {
      fs.writeFileSync(path.join(EVID, "catalog-search.json"), body);
      catalog = body;
      log("captured catalog:", url.slice(0, 90), "bytes", body.length);
    }
  } catch { }
});

await page.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
for (let i = 0; i < 8; i++) { await page.waitForTimeout(2000); if (await page.locator('input[type="password"]').count().catch(() => 0)) break; if (await page.locator("canvas").count().catch(() => 0)) break; }
if (await page.locator('input[type="password"]').count()) {
  await page.locator('input[type="text"], input[type="email"], input[name="username"]').first().fill(env.TV_USER);
  await page.locator('input[type="password"]').first().fill(env.TV_PASS);
  await page.locator('button:has-text("Login"), button[type="submit"]').first().click().catch(() => page.keyboard.press("Enter"));
  await page.waitForTimeout(6000);
}
for (let i = 0; i < 14; i++) {
  const start = page.locator('button:has-text("Start Simulated Trading")');
  if (await start.count().catch(() => 0)) await start.first().click().catch(() => {});
  await page.waitForTimeout(2500);
  if (await page.locator("canvas").count().catch(() => 0)) break;
}
// the catalog request can fire lazily — nudge it by typing in a symbol search if needed
for (let i = 0; i < 20 && !catalog; i++) await page.waitForTimeout(1500);
if (!catalog) {
  log("no catalog on load — opening symbol search");
  const search = page.locator('input[placeholder*="Search"], input[placeholder*="Symbol"], .icon-search').first();
  if (await search.count().catch(() => 0)) { await search.click({ force: true }).catch(() => {}); await page.keyboard.type("ES", { delay: 40 }); }
  for (let i = 0; i < 20 && !catalog; i++) await page.waitForTimeout(1500);
}

if (catalog) {
  try {
    const data = JSON.parse(catalog);
    const arr = Array.isArray(data) ? data : data.results || data.items || Object.values(data)[0];
    log("parsed:", Array.isArray(arr) ? `array ${arr.length}` : typeof arr);
    fs.writeFileSync(path.join(EVID, "catalog-summary.json"), JSON.stringify(Array.isArray(arr) ? arr.slice(0, 5) : arr, null, 2).slice(0, 20000));
  } catch (e) { log("parse failed:", e.message.slice(0, 120)); }
}
await browser.close();
log("DONE catalog:", !!catalog);
