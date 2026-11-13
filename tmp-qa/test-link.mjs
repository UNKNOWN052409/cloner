import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(900);
const syms = () => p.evaluate(() => [...document.querySelectorAll(".mod-chart")].map((m) => m.querySelector(".tv-symbol-picker-sym")?.innerText || "empty"));
// add 2 charts from palette (empty), then pick symbols
for (let i = 0; i < 2; i++) {
  await p.click(".tv-plus"); await p.waitForTimeout(250);
  await p.locator(".tv-palette-tile").nth(1).click(); await p.waitForTimeout(600);
}
// set symbols on the two empty chart panes
const empties = p.locator(".mod-chart .tv-chart-empty");
const n = await empties.count();
console.log("empty charts:", n);
for (let i = 0; i < n; i++) {
  await empties.nth(i).locator(".tv-symbol-picker-btn").click(); await p.waitForTimeout(250);
  await p.keyboard.type(i === 0 ? "ESZ6" : "GCX6"); await p.waitForTimeout(250);
  await p.locator(".tv-symbol-picker-row").first().click(); await p.waitForTimeout(500);
}
console.log("symbols:", await syms());
// set both charts link colour = green via context menu
const charts = p.locator(".mod-chart");
for (let i = 0; i < await charts.count(); i++) {
  const box = await charts.nth(i).boundingBox();
  if (!box) continue;
  await p.mouse.click(box.x + 120, box.y + 120, { button: "right" }); await p.waitForTimeout(250);
  const colors = p.locator(".tv-link-color");
  if (await colors.count()) await colors.nth(1).click();
  await p.waitForTimeout(300);
}
// change symbol on the last chart -> others with green link should follow
const last = charts.last();
const lb = await last.boundingBox();
await last.locator(".tv-symbol-picker-btn").click(); await p.waitForTimeout(250);
await p.keyboard.type("6EZ6"); await p.waitForTimeout(250);
await p.locator(".tv-symbol-picker-row").first().click(); await p.waitForTimeout(600);
console.log("after linked symbol change:", await syms());
// global crosshair: enable on both charts and hover one, check other redraws
const canvasBox = await charts.first().locator("canvas").boundingBox();
await p.mouse.move(canvasBox.x + 200, canvasBox.y + 100); await p.waitForTimeout(500);
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/102-link-crosshair.png" });
console.log("done");
await b.close();
