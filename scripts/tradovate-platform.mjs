// Resume session from exported cookies, enter simulated trading, re-export cookies.
import { chromium } from "playwright";
import fs from "node:fs";

const cookies = JSON.parse(fs.readFileSync("output/tradovate-cookies.json", "utf8"));
const b = await chromium.launch({ headless: false, channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, locale: "en-US" });
await ctx.addCookies(cookies);
const p = await ctx.newPage();

await p.goto("https://trader.tradovate.com/welcome", { waitUntil: "domcontentloaded", timeout: 60000 });
for (let i = 0; i < 8; i++) { await p.waitForTimeout(2000); if (!/just a moment/i.test(await p.title().catch(() => ""))) break; }
await p.waitForTimeout(2000);
console.log("at:", p.url(), "|", await p.title().catch(() => ""));
const bodyText = await p.evaluate(() => document.body.innerText.slice(0, 200).replace(/\n/g, " | "));
console.log("page:", bodyText);

const simBtn = p.locator('button:has-text("Start Simulated Trading"), a:has-text("Start Simulated Trading"), div:has-text("Start Simulated Trading")').first();
await simBtn.click({ timeout: 20000 });
console.log("clicked Start Simulated Trading");

let inPlatform = false;
for (let i = 0; i < 24; i++) {
  await p.waitForTimeout(2500);
  const u = p.url();
  const canvasCount = await p.evaluate(() => document.querySelectorAll("canvas").length).catch(() => 0);
  if (i % 4 === 0) console.log(`t+${(i + 1) * 2.5}s:`, u.slice(0, 70), "| canvas:", canvasCount);
  if (canvasCount > 0 && !/welcome/i.test(u)) { inPlatform = true; break; }
}
console.log("inPlatform:", inPlatform, "|", p.url());
await p.waitForTimeout(12000);
await p.screenshot({ path: "output/_tv-platform.png" });
console.log("title:", await p.title().catch(() => ""));

const fresh = await ctx.cookies();
fs.writeFileSync("output/tradovate-cookies.json", JSON.stringify(fresh, null, 2));
console.log("cookies exported:", fresh.length);
await b.close();
