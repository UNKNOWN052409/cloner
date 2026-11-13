import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(900);
const syms = () => p.evaluate(() => [...document.querySelectorAll(".mod-chart")].map((m) => m.querySelector(".tv-symbol-picker-sym")?.innerText || "empty"));
console.log("baseline charts:", await syms());
// add one empty chart from palette
await p.click(".tv-plus"); await p.waitForTimeout(300);
await p.locator(".tv-palette-tile").nth(1).click(); await p.waitForTimeout(700);
console.log("charts after add:", await syms(), "empty panes:", await p.locator(".tv-chart-empty").count());
const empties = p.locator(".tv-chart-empty");
if (await empties.count()) {
  await empties.first().locator(".tv-symbol-picker-btn").click(); await p.waitForTimeout(300);
  await p.keyboard.type("GCX6"); await p.waitForTimeout(300);
  await p.locator(".tv-symbol-picker-row").first().click(); await p.waitForTimeout(600);
}
console.log("after symbol pick:", await syms());
// set every chart link colour green
const charts = p.locator(".mod-chart");
for (let i = 0; i < await charts.count(); i++) {
  const box = await charts.nth(i).boundingBox(); if (!box) continue;
  await p.mouse.click(box.x + Math.min(150, box.width / 2), box.y + 120, { button: "right" }); await p.waitForTimeout(250);
  const colors = p.locator(".tv-link-color");
  if (await colors.count()) { await colors.nth(1).click(); await p.waitForTimeout(300); }
}
// change symbol on the last chart; linked charts should follow
const last = charts.last();
await last.locator(".tv-symbol-picker-btn").click(); await p.waitForTimeout(300);
await p.keyboard.type("6EZ6"); await p.waitForTimeout(300);
await p.locator(".tv-symbol-picker-row").first().click(); await p.waitForTimeout(700);
console.log("after linked change:", await syms());
// enable global crosshair on all charts, hover first
for (let i = 0; i < await charts.count(); i++) {
  const box = await charts.nth(i).boundingBox(); if (!box) continue;
  await p.mouse.click(box.x + Math.min(150, box.width / 2), box.y + 120, { button: "right" }); await p.waitForTimeout(250);
  const gc = p.locator(".tv-menu .tv-menu-item").filter({ hasText: "Global crosshair" });
  if (await gc.count()) { const t = await gc.first().innerText(); if (!/✓/.test(t)) await gc.first().click(); }
  await p.waitForTimeout(250);
}
const cb = await charts.first().locator("canvas").boundingBox();
await p.mouse.move(cb.x + 160, cb.y + 80); await p.waitForTimeout(600);
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/103-crosshair.png" });
console.log("done");
await b.close();
