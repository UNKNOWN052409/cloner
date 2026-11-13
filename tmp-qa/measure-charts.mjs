import { chromium } from "playwright";
import fs from "node:fs";
const env = {};
for (const line of fs.readFileSync(".env","utf8").split(/\r?\n/)) { const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const b = await chromium.launch({ headless: false, channel: "chrome", args: ["--window-size=1620,950"] });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, locale: "en-US" });
const p = await ctx.newPage(); p.setDefaultTimeout(25000);
await p.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
await p.waitForTimeout(4500);
if (await p.locator('input[type="password"]').count()) {
  await p.locator('input[type="text"], input[type="email"], input[name="username"]').first().fill(env.TV_USER);
  await p.locator('input[type="password"]').first().fill(env.TV_PASS);
  await p.getByRole("button", { name: "Login", exact: true }).first().click();
  await p.waitForTimeout(7000);
}
for (let i=0;i<12;i++){ const s=p.locator('button:has-text("Start Simulated Trading")'); if (await s.count().catch(()=>0)) await s.first().click().catch(()=>{}); await p.locator('button:has-text("Accept Cookies")').first().click({timeout:1200}).catch(()=>{}); await p.waitForTimeout(3000); if (await p.evaluate(()=>document.querySelectorAll("canvas").length>0).catch(()=>false)) break; }
await p.waitForTimeout(5000);
await p.keyboard.press("Escape").catch(()=>{});
log("workspace", p.url());

// chart-tab counter: labels like "MNQZ6 15m"
const chartTabs = () => p.evaluate(() => {
  const labels = [...document.querySelectorAll(".lm_tab")].map((t) => (t.innerText || "").replace(/\s+/g, " ").trim());
  const charts = labels.filter((l) => /^[A-Z0-9]{2,6}\s+(\d+m|\d+h|D)$/.test(l));
  return { totalTabs: labels.length, chartTabs: charts.length, labels: labels.slice(0, 40) };
});
log("baseline tabs:", JSON.stringify(await chartTabs()));
// open the assistant panel and wait longer, screenshot
const railBtns = p.locator("a.btn.btn-icon");
log("rail count:", await railBtns.count());
await railBtns.nth(0).click({ force: true }).catch(()=>{});
await p.waitForTimeout(4000);
const ifr = await p.evaluate(() => { const f = document.querySelector("iframe"); if (!f) return null; const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
log("assistant iframe after open:", JSON.stringify(ifr));
await p.screenshot({ path: "artifacts/tradovate-live-capture/shots/measure-20-assistant.png" });

// chart-add loop with retries
const results = [];
for (let i = 1; i <= 8; i++) {
  const before = await chartTabs();
  let added = false;
  for (let attempt = 0; attempt < 2 && !added; attempt++) {
    await p.locator(".icon-plus").first().click({ force: true }).catch(()=>{});
    await p.waitForTimeout(900);
    const tile = p.locator("li").filter({ hasText: /^Chart$/ }).first();
    if (!(await tile.count().catch(()=>0))) { await p.keyboard.press("Escape"); continue; }
    const box = await tile.boundingBox();
    if (!box) { await p.keyboard.press("Escape"); continue; }
    await p.mouse.move(box.x + box.width/2, box.y + box.height/2);
    await p.mouse.down();
    await p.mouse.move(500, 400, { steps: 8 });
    await p.mouse.move(760, 470, { steps: 8 });
    await p.mouse.up();
    await p.waitForTimeout(2600);
    await p.keyboard.press("Escape").catch(()=>{});
    await p.waitForTimeout(800);
    const after = await chartTabs();
    added = after.chartTabs > before.chartTabs || after.totalTabs > before.totalTabs;
    results.push({ add: i, attempt: attempt + 1, before: before.chartTabs, after: after.chartTabs, totalTabs: after.totalTabs, added });
    if (added) await p.screenshot({ path: `artifacts/tradovate-live-capture/shots/measure-21-chart-${i}.png` });
  }
  log("add", i, JSON.stringify(results[results.length-1]));
  if (!added) break;
}
log("FINAL tabs:", JSON.stringify(await chartTabs()));
fs.writeFileSync("artifacts/tradovate-live-capture/evidence/chart-limit.json", JSON.stringify({ results, final: await chartTabs() }, null, 2));
await ctx.storageState({ path: "artifacts/tradovate-live-capture/evidence/live-session4.json" });
await b.close();
