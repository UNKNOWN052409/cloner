import { chromium } from "playwright";
import fs from "node:fs";
const env = {};
for (const line of fs.readFileSync(".env","utf8").split(/\r?\n/)) { const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const b = await chromium.launch({ headless: false, channel: "chrome", args: ["--window-size=1620,950"] });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, locale: "en-US" });
for (const f of ["live-session4.json","live-session3.json","live-session2.json","live-session.json"]) {
  try { if (fs.existsSync("artifacts/tradovate-live-capture/evidence/" + f)) { ctx.storageState && (await ctx.close()); break; } } catch {}
}
const p = await ctx.newPage(); p.setDefaultTimeout(25000);
await p.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
await p.waitForTimeout(4500);
if (await p.locator('input[type="password"]').count()) {
  log("login");
  await p.locator('input[type="text"], input[type="email"], input[name="username"]').first().fill(env.TV_USER);
  await p.locator('input[type="password"]').first().fill(env.TV_PASS);
  await p.getByRole("button", { name: "Login", exact: true }).first().click();
  await p.waitForTimeout(7000);
}
for (let i=0;i<12;i++){ const s=p.locator('button:has-text("Start Simulated Trading")'); if (await s.count().catch(()=>0)) await s.first().click().catch(()=>{}); await p.locator('button:has-text("Accept Cookies")').first().click({timeout:1200}).catch(()=>{}); await p.waitForTimeout(3000); if (await p.evaluate(()=>document.querySelectorAll("canvas").length>0).catch(()=>false)) break; }
await p.waitForTimeout(4000);
await p.keyboard.press("Escape").catch(()=>{});
log("workspace:", p.url());
// capture popups/new tabs
const popups = [];
p.on("popup", async (pop) => { popups.push(pop.url()); log("POPUP:", pop.url()); });
let dialogText = "";
p.on("dialog", async (d) => { dialogText = d.message(); log("DIALOG:", d.message().slice(0,200)); await d.dismiss().catch(()=>{}); });
const before = p.url();
// find and click the switch button
const btn = p.locator('button:has-text("Switch to new NinjaTrader Web"), a:has-text("Switch to new NinjaTrader Web")').first();
const n = await btn.count();
log("switch button count:", n);
if (n) {
  await btn.click({ force: true }).catch((e) => log("click err:", e.message.slice(0,80)));
  await p.waitForTimeout(2500);
  log("url after click:", p.url(), "| before:", before);
  await p.screenshot({ path: "artifacts/tradovate-live-capture/shots/switch-01-after-click.png" });
  // any modal in DOM?
  const modal = await p.evaluate(() => {
    const cands = [...document.querySelectorAll('[class*="modal"],[class*="dialog"],[class*="overlay"],[role="dialog"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 100; });
    return cands.slice(-4).map((e) => ({ cls: (e.className || "").toString().slice(0,70), text: (e.innerText || "").slice(0, 400) }));
  });
  log("modals:", JSON.stringify(modal));
  log("popups:", JSON.stringify(popups));
  log("pages:", ctx.pages().map((pg) => pg.url()));
}
await b.close();
