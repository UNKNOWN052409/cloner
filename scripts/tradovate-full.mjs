// One session: login → Select Trading Mode → Start Simulated Trading → export cookies + storage.
import { chromium } from "playwright";
import fs from "node:fs";

const USER = process.env.TV_USER || ""; // set TV_USER/TV_PASS env vars (never commit credentials)
const PASS = process.env.TV_PASS || "";

const b = await chromium.launch({ headless: false, channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, locale: "en-US" });
const p = await ctx.newPage();

await p.goto("https://trader.tradovate.com/welcome", { waitUntil: "domcontentloaded", timeout: 60000 });
for (let i = 0; i < 8; i++) { await p.waitForTimeout(2000); if (!/just a moment/i.test(await p.title().catch(() => ""))) break; }
await p.waitForTimeout(1500);

await p.locator("#name-input, input[name='username'], input#username").first().fill(USER, { timeout: 15000 });
await p.locator("#password-input, input[type='password']").first().fill(PASS, { timeout: 15000 });
console.log("filled");
await p.locator('button:has-text("Login"), button[type="submit"]').first().click({ timeout: 10000 });

// wait for "Select a Trading Mode"
await p.locator('text=Select a Trading Mode').first().waitFor({ timeout: 30000 }).catch(() => {});
console.log("after login:", p.url());
await p.screenshot({ path: "output/_tv-mode.png" });

const sim = p.locator('button:has-text("Start Simulated Trading"), a:has-text("Start Simulated Trading")').first();
await sim.waitFor({ timeout: 15000 });
await sim.click();
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
// wait until the workspace actually mounts (charts render) before exporting the session
let workspaceReady = false;
for (let i = 0; i < 20; i++) {
  const canvasCount = await p.evaluate(() => document.querySelectorAll("canvas").length).catch(() => 0);
  if (canvasCount > 0) { workspaceReady = true; break; }
  await p.waitForTimeout(2000);
}
console.log("workspaceReady:", workspaceReady, "(canvas present)");
await p.waitForTimeout(10000); // let charts + market data settle
await p.screenshot({ path: "output/_tv-platform.png" });
console.log("title:", await p.title().catch(() => ""));

const cookies = await ctx.cookies();
fs.writeFileSync("output/tradovate-cookies.json", JSON.stringify(cookies, null, 2));
const storage = await p.evaluate(() => JSON.stringify({ ls: { ...localStorage }, ss: { ...sessionStorage } }));
fs.writeFileSync("output/tradovate-storage.json", storage);
console.log("exported:", cookies.length, "cookies | localStorage keys:", Object.keys(JSON.parse(storage).ls).length);
await b.close();
