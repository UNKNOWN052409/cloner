import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(900);
const probe = async (label) => {
  const r = await p.evaluate(() => {
    const m = document.querySelector(".tv-menu");
    if (!m) return { none: true };
    const cs = getComputedStyle(m);
    const item = m.querySelector(".tv-menu-item");
    const ics = item ? getComputedStyle(item) : null;
    return { menuBg: cs.backgroundColor, menuColor: cs.color, border: cs.borderColor, itemBg: ics?.backgroundColor, itemColor: ics?.color, cls: m.className };
  });
  console.log(label, JSON.stringify(r));
};
// module settings menu (chart gear)
await p.locator(".tv-module").nth(1).locator(".tv-module-actions .tv-icon-btn").nth(2).click();
await p.waitForTimeout(350);
await probe("chart-settings");
await p.keyboard.press("Escape"); await p.waitForTimeout(200);
// account menu
await p.locator(".tv-metric-btn").first().click(); await p.waitForTimeout(350);
await probe("account-menu");
await p.keyboard.press("Escape"); await p.waitForTimeout(200);
// symbol picker
await p.locator(".tv-symbol-picker-btn").first().click(); await p.waitForTimeout(350);
await probe("symbol-picker");
await b.close();
