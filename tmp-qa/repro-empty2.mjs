import { chromium } from "playwright";
const b = await chromium.launch({ headless: false, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.evaluate(() => localStorage.removeItem("tv-clone-workspaces"));
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(900);
let guard = 0;
while ((await p.locator(".tv-module").count()) > 0 && guard++ < 60) {
  await p.locator('.tv-module button[title="Close module"]').first().click({ force: true }).catch(() => {});
  await p.waitForTimeout(100);
}
await p.waitForTimeout(400);
console.log("empty state:", await p.locator(".tv-workspace--empty").count(), "| buttons:", await p.locator(".tv-workspace-empty-actions .tv-btn").allInnerTexts());
await p.locator(".tv-workspace-empty-actions .tv-btn--primary").click({ force: true });
await p.waitForTimeout(600);
console.log("palette after click:", await p.locator(".tv-palette").count(), "| tiles:", await p.locator(".tv-palette-tile").count());
console.log("errors:", errs.slice(0, 4));
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/bug2-empty-add.png" });
await b.close();
