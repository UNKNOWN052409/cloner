// diagnostic: what does the post-login page actually show right now?
import { chromium } from "playwright";
const USER = process.env.TV_USER || ""; // set TV_USER/TV_PASS env vars (never commit credentials)
const PASS = process.env.TV_PASS || "";
const b = await chromium.launch({ headless: false, channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, locale: "en-US" });
const p = await ctx.newPage();
await p.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForTimeout(5000);
// login if needed
const passInput = p.locator('input[type="password"]').first();
if ((await passInput.count()) > 0) {
  await p.locator('input[type="text"], input[type="email"], input[name="username"]').first().fill(USER, { timeout: 10000 });
  await passInput.fill(PASS, { timeout: 10000 });
  await Promise.race([
    p.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Login")').first().click({ timeout: 8000 }),
    p.keyboard.press("Enter"),
  ]);
  await p.waitForTimeout(6000);
}
// simulation gate if present
const gate = p.locator('button:has-text("Start Simulated Trading")');
if ((await gate.count()) > 0) {
  await gate.first().click({ timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(8000);
}
// dismiss popups / cookie banners
for (const sel of ['button:has-text("Accept Cookies")', 'button:has-text("Got it")', '[aria-label="Close"]', '[title="Close"]']) {
  await p.locator(sel).first().click({ timeout: 1500 }).catch(() => {});
}
await p.waitForTimeout(6000);
console.log("url:", p.url());
console.log("canvases:", await p.evaluate(() => document.querySelectorAll("canvas").length).catch(() => "?"));
const text = await p.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 500)).catch(() => "");
console.log("page text:", JSON.stringify(text));
await p.screenshot({ path: "output/_tv-diagnostic.png" });
await b.close();
process.exit(0);
