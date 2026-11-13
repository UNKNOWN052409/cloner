// Probe the live symbol picker: capture the DOM structure + every contract list
// available under Groups and Exchanges in the Market Analyzer picker.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const EVID = path.join(ROOT, "artifacts", "tradovate-live-capture", "evidence");
const SHOTS = path.join(ROOT, "artifacts", "tradovate-live-capture", "shots");
const env = {};
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) { const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({ headless: false, channel: "chrome", args: ["--window-size=1460,950"] });
const ctxOpts = { viewport: { width: 1440, height: 900 }, locale: "en-US" };
if (fs.existsSync(path.join(EVID, "live-session.json"))) ctxOpts.storageState = path.join(EVID, "live-session.json");
const ctx = await browser.newContext(ctxOpts);
const ss = JSON.parse(fs.readFileSync(path.join(EVID, "live-session-storage.json"), "utf8"));
await ctx.addInitScript((e) => { try { if (/tradovate\.com$/.test(location.hostname)) for (const [k, v] of Object.entries(e.ss || {})) sessionStorage.setItem(k, String(v)); } catch {} }, ss);
const page = await ctx.newPage();
page.setDefaultTimeout(20000);
const jsonResponses = [];
page.on("response", async (res) => {
  const url = res.url();
  if (!/\.(js|css|png|woff2?|ttf|svg)(\?|$)/.test(url) && (res.headers()["content-type"] || "").includes("json")) {
    try { const body = await res.text(); jsonResponses.push({ url, size: body.length, sample: body.slice(0, 400) }); } catch { }
  }
});

await page.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
for (let i = 0; i < 8; i++) { await page.waitForTimeout(2000); if (await page.locator('input[type="password"]').count().catch(() => 0)) break; if (await page.locator("canvas").count().catch(() => 0)) break; }
if (await page.locator('input[type="password"]').count()) {
  await page.locator('input[type="text"], input[type="email"], input[name="username"]').first().fill(env.TV_USER);
  await page.locator('input[type="password"]').first().fill(env.TV_PASS);
  await page.locator('button:has-text("Login"), button[type="submit"]').first().click().catch(() => page.keyboard.press("Enter"));
  await page.waitForTimeout(6000);
}
for (let i = 0; i < 12; i++) {
  const start = page.locator('button:has-text("Start Simulated Trading")');
  if (await start.count().catch(() => 0)) await start.first().click().catch(() => {});
  await page.waitForTimeout(2500);
  if (await page.locator("canvas").count().catch(() => 0)) break;
}
await page.waitForTimeout(3000);
log("workspace", page.url());

// open the module palette and place Market Analyzer
const plus = page.locator(".icon-plus").first();
await plus.click({ force: true }).catch(() => {});
await page.waitForTimeout(900);
const tile = page.locator("li").filter({ hasText: /^Market Analyzer$/ }).first();
if (await tile.count().catch(() => 0)) {
  const box = await tile.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(740, 420, { steps: 8 });
    await page.mouse.move(800, 470, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(2200);
  }
}
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(SHOTS, "instr-10-analyzer.png") });

// find the Market Analyzer search input and click it
const search = page.locator('.mod-market-analyzer input, input[placeholder*="Search"]').first();
const found = await search.count().catch(() => 0);
log("search input:", found);
if (found) {
  await search.click({ force: true });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, "instr-11-picker.png") });
  fs.writeFileSync(path.join(EVID, "picker.html"), await page.evaluate(() => document.documentElement.outerHTML));
  // dump any visible list/menu structure
  const menu = await page.evaluate(() => {
    const cands = [...document.querySelectorAll("div,ul,section,aside")].filter((el) => {
      const r = el.getBoundingClientRect();
      const t = el.innerText || "";
      return r.width > 120 && r.height > 60 && /Groups|Exchanges|Contracts|POPULAR INSTRUMENTS/i.test(t);
    });
    return cands.slice(-6).map((el) => ({ cls: (el.className || "").toString().slice(0, 90), rect: [el.getBoundingClientRect().width, el.getBoundingClientRect().height], text: el.innerText.slice(0, 2500) }));
  });
  fs.writeFileSync(path.join(EVID, "picker-menu.json"), JSON.stringify(menu, null, 2));
  log("menu candidates:", menu.length);
}

fs.writeFileSync(path.join(EVID, "network-json.json"), JSON.stringify(jsonResponses.slice(0, 80), null, 2));
log("json responses:", jsonResponses.length, jsonResponses.slice(0, 6).map((r) => `${r.url.slice(0, 90)} (${r.size})`).join(" | "));

await browser.close();
log("DONE");
