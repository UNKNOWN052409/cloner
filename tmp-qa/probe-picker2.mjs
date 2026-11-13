import { chromium } from "playwright";
import fs from "node:fs";
const env = {};
for (const line of fs.readFileSync(".env","utf8").split(/\r?\n/)) { const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const b = await chromium.launch({ headless: false, channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, storageState: "artifacts/tradovate-live-capture/evidence/live-session.json" });
const ss = JSON.parse(fs.readFileSync("artifacts/tradovate-live-capture/evidence/live-session-storage.json","utf8"));
await ctx.addInitScript((e) => { try { if (/tradovate\.com$/.test(location.hostname)) for (const [k,v] of Object.entries(e.ss||{})) sessionStorage.setItem(k,String(v)); } catch {} }, ss);
const p = await ctx.newPage();
const reqs = [];
p.on("request", (r) => { const u = r.url(); if (/tradovateapi|contract|instrument|symbol/i.test(u)) reqs.push({ method: r.method(), url: u.slice(0, 200) }); });
const resps = [];
p.on("response", async (r) => { const u = r.url(); if (/tradovateapi\/v1\/(contract|instrument)/i.test(u)) { try { const t = await r.text(); resps.push({ url: u.slice(0,200), status: r.status(), size: t.length, head: t.slice(0, 200) }); } catch {} } });
await p.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
for (let i=0;i<10;i++){ await p.waitForTimeout(2500); if (await p.locator("canvas").count().catch(()=>0)) break; const s=p.locator('button:has-text("Start Simulated Trading")'); if (await s.count().catch(()=>0)) await s.first().click().catch(()=>{}); }
await p.waitForTimeout(3000);
await p.locator(".icon-plus").first().click({ force: true }).catch(()=>{});
await p.waitForTimeout(900);
const tile = p.locator("li").filter({ hasText: /^Market Analyzer$/ }).first();
if (await tile.count().catch(()=>0)) { const box = await tile.boundingBox(); if (box) { await p.mouse.move(box.x+box.width/2, box.y+box.height/2); await p.mouse.down(); await p.mouse.move(740,420,{steps:8}); await p.mouse.move(800,470,{steps:8}); await p.mouse.up(); await p.waitForTimeout(2200); } }
await p.keyboard.press("Escape"); await p.waitForTimeout(500);
const search = p.locator('.mod-market-analyzer input, input[placeholder*="Search"]').first();
await search.click({ force: true }); await p.waitForTimeout(800);
await p.keyboard.type("ES", { delay: 60 }); await p.waitForTimeout(2500);
// scroll dropdown to load/see more + dump visible rows
const rows = await p.evaluate(() => {
  const menu = [...document.querySelectorAll("div")].find((d) => (d.className||"").toString().includes("dropdown-menu"));
  if (!menu) return { rows: [], text: "" };
  return { rows: [...menu.querySelectorAll("*")].filter((e) => e.children.length === 0 && (e.innerText||"").trim()).map((e) => ({ text: e.innerText.trim().slice(0,80), cls: (e.className||"").toString().slice(0,50) })).slice(0, 80), text: menu.innerText.slice(0,1500) };
});
fs.writeFileSync("artifacts/tradovate-live-capture/evidence/picker-search-probe.json", JSON.stringify({ reqs, resps, rows }, null, 2));
console.log("reqs:", JSON.stringify(reqs.slice(-12), null, 1));
console.log("resps:", JSON.stringify(resps.slice(0,6), null, 1));
console.log("dropdown rows:", JSON.stringify(rows.rows.slice(0,25), null, 1));
await p.screenshot({ path: "artifacts/tradovate-live-capture/shots/instr-21-typed-es.png" });
await b.close();
