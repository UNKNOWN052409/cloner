import { chromium } from "playwright";
import fs from "node:fs";
const env = {};
for (const line of fs.readFileSync(".env","utf8").split(/\r?\n/)) { const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const b = await chromium.launch({ headless: false, channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, storageState: "artifacts/tradovate-live-capture/evidence/live-session.json" });
const ss = JSON.parse(fs.readFileSync("artifacts/tradovate-live-capture/evidence/live-session-storage.json","utf8"));
await ctx.addInitScript((e) => { try { if (/tradovate\.com$/.test(location.hostname)) for (const [k,v] of Object.entries(e.ss||{})) sessionStorage.setItem(k,String(v)); } catch {} }, ss);
const p = await ctx.newPage();
await p.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
for (let i=0;i<10;i++){ await p.waitForTimeout(2500); if (await p.locator("canvas").count().catch(()=>0)) break; const s=p.locator('button:has-text("Start Simulated Trading")'); if (await s.count().catch(()=>0)) await s.first().click().catch(()=>{}); }
await p.waitForTimeout(3000);
// add Market Analyzer
await p.locator(".icon-plus").first().click({ force: true }).catch(()=>{});
await p.waitForTimeout(900);
const tile = p.locator("li").filter({ hasText: /^Market Analyzer$/ }).first();
if (await tile.count().catch(()=>0)) { const box = await tile.boundingBox(); if (box) { await p.mouse.move(box.x+box.width/2, box.y+box.height/2); await p.mouse.down(); await p.mouse.move(740,420,{steps:8}); await p.mouse.move(800,470,{steps:8}); await p.mouse.up(); await p.waitForTimeout(2200); } }
await p.keyboard.press("Escape"); await p.waitForTimeout(500);
const search = p.locator('.mod-market-analyzer input, input[placeholder*="Search"]').first();
await search.click({ force: true }); await p.waitForTimeout(1200);
// dump dropdown structure
const dump = await p.evaluate(() => {
  const menu = document.querySelector(".dropdown-menu");
  if (!menu) return { err: "no dropdown" };
  const items = [...menu.querySelectorAll("*")].filter((e) => e.children.length === 0).map((e) => ({ tag: e.tagName, cls: (e.className||"").toString().slice(0,60), text: (e.innerText||"").trim().slice(0,70), rect: [Math.round(e.getBoundingClientRect().x), Math.round(e.getBoundingClientRect().y), Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)] })).filter((x) => x.text);
  return { html: menu.outerHTML.slice(0, 6000), items: items.slice(0, 60) };
});
fs.writeFileSync("artifacts/tradovate-live-capture/evidence/picker-structure.json", JSON.stringify(dump, null, 2));
console.log("items:", JSON.stringify(dump.items?.slice(0, 30), null, 1));
await p.screenshot({ path: "artifacts/tradovate-live-capture/shots/instr-20-picker.png" });
await b.close();
