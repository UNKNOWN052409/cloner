import { chromium } from "playwright";
const b = await chromium.launch({ headless: false, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
const shot = (n) => p.screenshot({ path: `artifacts/tradovate-live-capture/qa-full/${n}.png` });
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(1000);

// 1) assistant closed by default
console.log("sidepanel default:", await p.locator(".tv-sidepanel").count());
// 2) open assistant via rail
await p.locator(".tv-rail-btn").nth(0).click(); await p.waitForTimeout(500);
console.log("opened:", await p.locator(".tv-sidepanel").count());
// 3) close via header X
await p.locator(".tv-sidepanel-header .tv-icon-btn").click(); await p.waitForTimeout(500);
console.log("closed via X:", await p.locator(".tv-sidepanel").count());
// 4) open again + End Chat
await p.locator(".tv-rail-btn").nth(0).click(); await p.waitForTimeout(500);
const msgBefore = await p.locator(".tv-msg").count();
await p.locator(".tv-assistant-composer input").fill("hello");
await p.keyboard.press("Enter"); await p.waitForTimeout(900);
await shot("98-assistant");
const endBtn = p.locator(".tv-assistant-endbtn");
console.log("end chat button:", await endBtn.count(), "messages:", msgBefore, "->", await p.locator(".tv-msg").count());
if (await endBtn.count()) { await endBtn.click(); await p.waitForTimeout(500); }
console.log("after end chat — panel:", await p.locator(".tv-sidepanel").count());
// reopen: conversation reset to greeting
await p.locator(".tv-rail-btn").nth(0).click(); await p.waitForTimeout(400);
console.log("reopened messages:", await p.locator(".tv-msg").count());
await p.locator(".tv-sidepanel-header .tv-icon-btn").click(); await p.waitForTimeout(300);

// 5) add an empty chart from palette
await p.click(".tv-plus"); await p.waitForTimeout(300);
await p.locator(".tv-palette-tile").nth(1).click(); await p.waitForTimeout(700);
const emptyChart = await p.locator(".mod-chart .tv-chart-empty").count();
console.log("empty chart prompt:", emptyChart);
await shot("99-empty-chart");
// pick a symbol in the empty chart
const lastEmpty = p.locator(".mod-chart .tv-chart-empty").last();
if (emptyChart) {
  await lastEmpty.locator(".tv-symbol-picker-btn").click(); await p.waitForTimeout(300);
  await p.keyboard.type("gold"); await p.waitForTimeout(300);
  await p.locator(".tv-symbol-picker-row").first().click(); await p.waitForTimeout(600);
  console.log("cart loads after pick, empty left:", await p.locator(".tv-chart-empty").count());
}

// 6) chart right-click menu
const chart = p.locator(".mod-chart").last();
const box = await chart.boundingBox();
await p.mouse.click(box.x + 200, box.y + 200, { button: "right" }); await p.waitForTimeout(400);
const items = await p.locator(".tv-menu .tv-menu-item").allInnerTexts();
console.log("chart context menu:", JSON.stringify(items));
await shot("100-chart-context");
// pick link colour green (first colour button)
const colors = p.locator(".tv-link-color");
console.log("link colour buttons:", await colors.count());
if (await colors.count()) { await colors.nth(1).click(); await p.waitForTimeout(400); }
// enable global crosshair
await p.mouse.click(box.x + 200, box.y + 200, { button: "right" }); await p.waitForTimeout(300);
await p.locator(".tv-menu .tv-menu-item").filter({ hasText: "Global crosshair" }).first().click(); await p.waitForTimeout(400);
// add another chart pane via context menu
await p.mouse.click(box.x + 200, box.y + 200, { button: "right" }); await p.waitForTimeout(300);
await p.locator(".tv-menu .tv-menu-item").filter({ hasText: "Add Chart pane" }).first().click(); await p.waitForTimeout(800);
console.log("charts:", await p.locator(".mod-chart").count());
console.log("errors:", errs.slice(0, 5));
await shot("101-charts-linked");
await b.close();
