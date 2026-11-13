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
const stats = () => p.evaluate(() => {
  const labels = [...document.querySelectorAll(".lm_tab")].map((t) => (t.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  return { tabs: labels.length, labels, canvases: document.querySelectorAll("canvas").length, modules: document.querySelectorAll(".lm_item").length };
});
log("baseline:", JSON.stringify(await stats()));
const addChart = async (n) => {
  for (let retry = 0; retry < 3; retry++) {
    await p.locator(".icon-plus").first().click({ force: true }).catch(()=>{});
    await p.waitForTimeout(1000);
    const tile = p.locator("li").filter({ hasText: /^Chart$/ }).first();
    if (!(await tile.count().catch(()=>0))) { await p.keyboard.press("Escape"); await p.waitForTimeout(500); continue; }
    const box = await tile.boundingBox();
    if (!box) { await p.keyboard.press("Escape"); continue; }
    await p.mouse.move(box.x + box.width/2, box.y + box.height/2);
    await p.mouse.down();
    await p.mouse.move(600, 380, { steps: 10 });
    await p.mouse.move(820, 470, { steps: 12 });
    await p.mouse.up();
    await p.waitForTimeout(3000);
    await p.keyboard.press("Escape").catch(()=>{});
    await p.waitForTimeout(800);
    const s = await stats();
    if (s.tabs > (addChart.last || 0) || retry === 2) {
      // a new "Chart" tab (empty chart) counts as added
      const chartLabelCount = s.labels.filter((l) => /^Chart$/i.test(l)).length;
      addChart.last = s.tabs;
      log(`add ${n} retry ${retry + 1}: tabs=${s.tabs} canvases=${s.canvases} modules=${s.modules} chartTabs=${chartLabelCount}`);
      if (chartLabelCount >= n) return { ok: true, ...s, chartLabelCount };
    }
  }
  return { ok: false, ...(await stats()) };
};
let n = 0;
for (let i = 1; i <= 10; i++) {
  const r = await addChart(i);
  if (!r.ok) { log("STOP at chart", i, JSON.stringify(r)); break; }
  n = r.chartLabelCount || n;
  await p.screenshot({ path: `artifacts/tradovate-live-capture/shots/measure-30-charts-${i}.png` });
}
log("RESULT chart tabs:", n, JSON.stringify(await stats()));
fs.writeFileSync("artifacts/tradovate-live-capture/evidence/chart-limit2.json", JSON.stringify({ chartTabs: n, final: await stats(), at: new Date().toISOString() }, null, 2));
await ctx.storageState({ path: "artifacts/tradovate-live-capture/evidence/live-session4.json" });
const ss = await p.evaluate(() => ({ ls: { ...localStorage }, ss: { ...sessionStorage } })).catch(() => null);
if (ss) fs.writeFileSync("artifacts/tradovate-live-capture/evidence/live-session4-storage.json", JSON.stringify(ss, null, 2));
await b.close();
