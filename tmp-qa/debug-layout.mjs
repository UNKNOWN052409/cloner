import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.evaluate(() => localStorage.removeItem("tv-clone-workspaces"));
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(800);
const addTile = async (idx) => { await p.keyboard.press("Escape"); await p.click(".tv-plus"); await p.waitForTimeout(150); await p.locator(".tv-palette-tile").nth(idx).click(); await p.waitForTimeout(180); };
for (let i = 0; i < 20; i++) await addTile(i);
for (let i = 0; i < 10; i++) await addTile(1);
await p.keyboard.press("Escape"); await p.waitForTimeout(400);
const info = await p.evaluate(() => ({
  charts: [...document.querySelectorAll(".mod-chart")].map((c) => { const r = c.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), buy: c.querySelectorAll(".tv-btn--buy").length, sym: c.querySelector(".tv-symbol-picker-sym")?.innerText || "" }; }),
  groups: [...document.querySelectorAll(".tv-group")].map((g) => Math.round(g.getBoundingClientRect().height)),
  columns: [...document.querySelectorAll(".tv-column")].map((c) => ({ h: Math.round(c.getBoundingClientRect().height), scrollH: c.scrollHeight, minH: getComputedStyle(c).minHeight, overflow: getComputedStyle(c).overflowY })),
}));
console.log(JSON.stringify(info, null, 1).slice(0, 2200));
await b.close();
