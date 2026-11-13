// Capture the live instrument/pair list from the authenticated Tradovate app.
// Reuses the exported session; falls back to a fresh login. Dumps every symbol
// the app exposes through its search / Market Analyzer pickers.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const EVID = path.join(ROOT, "artifacts", "tradovate-live-capture", "evidence");
const OUT = path.join(ROOT, "artifacts", "tradovate-live-capture", "shots");
const env = {};
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) { const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({ headless: false, channel: "chrome", args: ["--window-size=1460,950"] });
const ctxOpts = { viewport: { width: 1440, height: 900 }, locale: "en-US" };
if (fs.existsSync(path.join(EVID, "live-session.json"))) ctxOpts.storageState = path.join(EVID, "live-session.json");
const ctx = await browser.newContext(ctxOpts);
const ss = JSON.parse(fs.readFileSync(path.join(EVID, "live-session-storage.json"), "utf8"));
await ctx.addInitScript((entries) => {
  try { if (/tradovate\.com$/.test(location.hostname)) for (const [k, v] of Object.entries(entries.ss || {})) sessionStorage.setItem(k, String(v)); } catch {}
}, ss);
const page = await ctx.newPage();
page.setDefaultTimeout(20000);

await page.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
for (let i = 0; i < 8; i++) { await page.waitForTimeout(2000); if (await page.locator('input[type="password"]').count().catch(() => 0)) break; if (await page.locator("canvas").count().catch(() => 0)) break; }
if (await page.locator('input[type="password"]').count()) {
  log("login form — signing in");
  await page.locator('input[type="text"], input[type="email"], input[name="username"]').first().fill(env.TV_USER);
  await page.locator('input[type="password"]').first().fill(env.TV_PASS);
  await page.locator('button:has-text("Login"), button[type="submit"]').first().click().catch(() => page.keyboard.press("Enter"));
  await page.waitForTimeout(6000);
}
for (let i = 0; i < 12; i++) {
  const start = page.locator('button:has-text("Start Simulated Trading")');
  if (await start.count().catch(() => 0)) { await start.first().click().catch(() => {}); }
  await page.waitForTimeout(2500);
  if (await page.locator("canvas").count().catch(() => 0)) break;
}
log("workspace:", page.url());
await page.waitForTimeout(3000);
await page.screenshot({ path: path.join(OUT, "instr-00-workspace.png") });

// 1) inspect what the app exposes client-side
const probe = await page.evaluate(() => {
  const keys = Object.keys(window).filter((k) => /store|redux|instrument|contract|symbol|tradovate|NT/i.test(k)).slice(0, 40);
  const ls = {}; for (const k of Object.keys(localStorage)) ls[k] = String(localStorage[k]).slice(0, 120);
  return { keys, lsKeys: Object.keys(ls).slice(0, 30) };
});
fs.writeFileSync(path.join(EVID, "instruments-probe.json"), JSON.stringify(probe, null, 2));
log("window keys:", JSON.stringify(probe.keys));

// 2) top-bar search
await page.mouse.click(241, 22);
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, "instr-01-search.png") });
const searchText = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div,section,aside')].filter((d) => {
    const r = d.getBoundingClientRect();
    return r.width > 300 && r.height > 200 && /SYMBOL|INSTRUMENT|FUTURES|STOCKS|Search/i.test(d.innerText || "");
  }).sort((a, b) => a.innerText.length - b.innerText.length)[0];
  return el ? el.innerText.slice(0, 6000) : "";
});
fs.writeFileSync(path.join(EVID, "instruments-search.txt"), searchText);
log("search text length:", searchText.length);

// 3) dump every instrument-like token visible in the DOM
const symbols = await page.evaluate(() => {
  const txt = document.body.innerText || "";
  const tokens = [...new Set((txt.match(/\b[A-Z0-9]{2,6}\b/g) || []))];
  return tokens;
});
fs.writeFileSync(path.join(EVID, "instruments-tokens.json"), JSON.stringify(symbols, null, 2));
log("unique tokens:", symbols.length);

// 4) Market Analyzer symbol picker: add the module then type letters to enumerate
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
const plus = page.locator(".icon-plus").first();
if (await plus.count().catch(() => 0)) { await plus.click({ force: true }).catch(() => {}); }
await page.waitForTimeout(800);
const tile = page.locator("li").filter({ hasText: /^Market Analyzer$/ }).first();
if (await tile.count().catch(() => 0)) {
  const box = await tile.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(760, 430, { steps: 8 });
    await page.mouse.move(820, 470, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(2000);
  }
}
await page.keyboard.press("Escape");
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, "instr-02-market-analyzer.png") });

// click the module search box and dump the suggestions
const searchBox = page.locator('.mod-market-analyzer input, input[placeholder*="Search"], input[placeholder*="symbol"]').first();
const suggestions = [];
if (await searchBox.count().catch(() => 0)) {
  await searchBox.click({ force: true }).catch(() => {});
  await page.waitForTimeout(600);
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  for (const ch of alpha) {
    await page.keyboard.press("Backspace");
    await page.keyboard.type(ch, { delay: 20 });
    await page.waitForTimeout(250);
    const rows = await page.evaluate(() => [...document.querySelectorAll('[class*="menu"] li, [class*="dropdown"] li, [role="option"], [class*="suggest"] li, [class*="item"]')]
      .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
      .filter((t) => t && t.length < 120));
    suggestions.push({ ch, rows: [...new Set(rows)].slice(0, 60) });
  }
}
fs.writeFileSync(path.join(EVID, "instruments-suggestions.json"), JSON.stringify(suggestions, null, 2));
log("suggestion buckets:", suggestions.length);

await page.screenshot({ path: path.join(OUT, "instr-03-final.png") });
await browser.close();
log("DONE");
