import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(1200);
// same shell state as the live 08-clean capture: assistant panel open
await p.locator(".tv-rail-btn").nth(0).click(); await p.waitForTimeout(900);
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/clone-for-diff.png" });
console.log("errors:", errs.slice(0,3));
await b.close();
