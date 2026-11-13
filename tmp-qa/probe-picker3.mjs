import { chromium } from "playwright";
import fs from "node:fs";
const env = {};
for (const line of fs.readFileSync(".env","utf8").split(/\r?\n/)) { const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const b = await chromium.launch({ headless: false, channel: "chrome", args: ["--window-size=1460,950"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
const p = await ctx.newPage();
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const urls = [];
p.on("response", (r) => { const u = r.url(); if (/tradovateapi|tdv|md\./i.test(u)) urls.push(`${r.status()} ${u.slice(0,160)}`); });
await p.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
for (let i=0;i<6;i++){ await p.waitForTimeout(2500); if (await p.locator('input[type="password"]').count().catch(()=>0)) break; }
if (await p.locator('input[type="password"]').count()) {
  log("logging in fresh");
  await p.locator('input[type="text"], input[type="email"], input[name="username"]').first().fill(env.TV_USER);
  await p.locator('input[type="password"]').first().fill(env.TV_PASS);
  await p.locator('button:has-text("Login"), button[type="submit"]').first().click().catch(()=>p.keyboard.press("Enter"));
  await p.waitForTimeout(8000);
}
for (let i=0;i<14;i++){ const s=p.locator('button:has-text("Start Simulated Trading")'); if (await s.count().catch(()=>0)) await s.first().click().catch(()=>{}); await p.waitForTimeout(2500); if (await p.locator("canvas").count().catch(()=>0)) break; }
await p.waitForTimeout(4000);
log("url:", p.url(), "canvas:", await p.locator("canvas").count().catch(()=>0));
// add Market Analyzer + open picker + type
await p.locator(".icon-plus").first().click({ force: true }).catch(()=>{});
await p.waitForTimeout(900);
const tile = p.locator("li").filter({ hasText: /^Market Analyzer$/ }).first();
if (await tile.count().catch(()=>0)) { const box = await tile.boundingBox(); if (box) { await p.mouse.move(box.x+box.width/2, box.y+box.height/2); await p.mouse.down(); await p.mouse.move(740,420,{steps:8}); await p.mouse.move(800,470,{steps:8}); await p.mouse.up(); await p.waitForTimeout(2200); } }
await p.keyboard.press("Escape"); await p.waitForTimeout(500);
const search = p.locator('.mod-market-analyzer input, input[placeholder*="Search"]').first();
await search.click({ force: true }); await p.waitForTimeout(600);
await p.keyboard.type("ES", { delay: 50 }); await p.waitForTimeout(2500);
await p.screenshot({ path: "artifacts/tradovate-live-capture/shots/instr-30-typed.png" });
fs.writeFileSync("artifacts/tradovate-live-capture/evidence/tdv-responses.txt", urls.join("\n"));
log("responses:", urls.length);
console.log(urls.filter(u=>/contract|instrument|symbol|product/i.test(u)).slice(0,30).join("\n"));
await b.close();
