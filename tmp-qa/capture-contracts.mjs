import { chromium } from "playwright";
import fs from "node:fs";
const env = {};
for (const line of fs.readFileSync(".env","utf8").split(/\r?\n/)) { const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const b = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
const p = await ctx.newPage();
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const saved = {};
p.on("response", async (r) => {
  const u = r.url();
  if (/\/v1\/(contract|product)\//i.test(u) && /json/i.test(r.headers()["content-type"] || "")) {
    try {
      const t = await r.text();
      if (t.length > 200) {
        const name = u.split("/v1/")[1].replace(/[^a-z0-9]+/gi, "-").slice(0, 60) + ".json";
        fs.writeFileSync(`artifacts/tradovate-live-capture/evidence/tdv-${name}`, t);
        saved[u] = t.length;
      }
    } catch {}
  }
});
await p.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
for (let i=0;i<6;i++){ await p.waitForTimeout(2500); if (await p.locator('input[type="password"]').count().catch(()=>0)) break; }
if (await p.locator('input[type="password"]').count()) {
  await p.locator('input[type="text"], input[type="email"], input[name="username"]').first().fill(env.TV_USER);
  await p.locator('input[type="password"]').first().fill(env.TV_PASS);
  await p.locator('button:has-text("Login"), button[type="submit"]').first().click().catch(()=>p.keyboard.press("Enter"));
  await p.waitForTimeout(8000);
}
for (let i=0;i<16;i++){ const s=p.locator('button:has-text("Start Simulated Trading")'); if (await s.count().catch(()=>0)) await s.first().click().catch(()=>{}); await p.waitForTimeout(2500); if (await p.locator("canvas").count().catch(()=>0)) break; }
await p.waitForTimeout(6000);
// nudge more contract calls by opening the picker
await p.locator(".icon-plus").first().click({ force: true }).catch(()=>{});
await p.waitForTimeout(800);
const tile = p.locator("li").filter({ hasText: /^Market Analyzer$/ }).first();
if (await tile.count().catch(()=>0)) { const box = await tile.boundingBox(); if (box) { await p.mouse.move(box.x+box.width/2, box.y+box.height/2); await p.mouse.down(); await p.mouse.move(740,420,{steps:8}); await p.mouse.move(800,470,{steps:8}); await p.mouse.up(); await p.waitForTimeout(2000); } }
await p.keyboard.press("Escape"); await p.waitForTimeout(400);
const search = p.locator('.mod-market-analyzer input, input[placeholder*="Search"]').first();
if (await search.count().catch(()=>0)) { await search.click({ force: true }); await p.keyboard.type("ES", { delay: 50 }); }
await p.waitForTimeout(4000);
log("captured:", JSON.stringify(saved));
await b.close();
