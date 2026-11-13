import { chromium } from "playwright";
const b = await chromium.launch({ headless: false, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(1000);
const shot = (n) => p.screenshot({ path: `artifacts/tradovate-live-capture/qa-full/${n}.png` });
// 1) tab right-click menu
await p.locator(".tv-module-tab").first().click({ button: "right" });
await p.waitForTimeout(400);
const tabMenuItems = await p.locator(".tv-menu .tv-menu-item").allInnerTexts();
await shot("92-tab-context");
console.log("tab context menu:", JSON.stringify(tabMenuItems));
await p.keyboard.press("Escape"); await p.waitForTimeout(250);
// 2) SuperDOM right-click
const dom = p.locator(".mod-superdom").first();
const box = await dom.boundingBox();
await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
await p.waitForTimeout(400);
const domMenu = await p.locator(".tv-menu .tv-menu-item").allInnerTexts();
await shot("93-dom-context");
console.log("dom context menu:", JSON.stringify(domMenu));
// exercise one action: Cancel All
const cancelAll = p.locator(".tv-menu .tv-menu-item").filter({ hasText: "Cancel All" }).first();
if (await cancelAll.count()) { await cancelAll.click(); await p.waitForTimeout(400); }
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/94-after-cancelall.png" });
// 3) light theme: options + menus contrast
await p.locator(".tv-layout-btn").click(); await p.waitForTimeout(300);
await p.locator(".tv-modal .tv-seg button", { hasText: "light" }).first().click();
await p.waitForTimeout(600);
await shot("95-light-theme");
const light = await p.evaluate(() => {
  const opt = getComputedStyle(document.querySelector("select option"));
  const menu = document.querySelector(".tv-menu");
  return { html: document.documentElement.className, optionBg: opt.backgroundColor, optionColor: opt.color, menuBg: menu ? getComputedStyle(menu).backgroundColor : null };
});
console.log("light theme:", JSON.stringify(light));
await p.keyboard.press("Escape");
// 4) back to dark, screenshot final
await p.locator(".tv-layout-btn").click(); await p.waitForTimeout(250);
await p.locator(".tv-modal .tv-seg button", { hasText: "dark" }).first().click();
await p.waitForTimeout(500);
await shot("96-final-dark");
console.log("errors:", errs.slice(0, 5));
await b.close();
