// Login to Tradovate with provided creds, export cookies for the cloner.
import { chromium } from "playwright";
import fs from "node:fs";

const USER = process.env.TV_USER || ""; // set TV_USER/TV_PASS env vars (never commit credentials)
const PASS = process.env.TV_PASS || "";

const b = await chromium.launch({ headless: false, channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, locale: "en-US" });
const p = await ctx.newPage();

await p.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
for (let i = 0; i < 10; i++) {
  await p.waitForTimeout(2500);
  const t = (await p.title().catch(() => "")) || "";
  console.log(`t+${(i + 1) * 2.5}s:`, p.url().slice(0, 70), "|", t.slice(0, 50));
  if (!/just a moment|attention required/i.test(t)) break;
}
console.log("landed:", p.url(), "|", await p.title().catch(() => ""));

// find login inputs
await p.waitForTimeout(2000);
const inputs = await p.evaluate(() => [...document.querySelectorAll("input")].map((i) => `${i.type}:${i.name || i.id || i.placeholder || "-"}`).join(", "));
console.log("inputs:", inputs);

const user = p.locator('input[type="text"], input[type="email"], input[name="username"], input[name="email"]').first();
const pass = p.locator('input[type="password"]').first();
await user.fill(USER, { timeout: 10000 });
await pass.fill(PASS, { timeout: 10000 });
console.log("credentials filled");
await p.screenshot({ path: "output/_tv-login-filled.png" });

await Promise.race([
  p.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Log In"), button:has-text("Login")').first().click({ timeout: 8000 }),
  p.keyboard.press("Enter"),
]);
console.log("submitted — waiting for platform…");

// wait for the app to load (up to 45s)
let loggedIn = false;
for (let i = 0; i < 18; i++) {
  await p.waitForTimeout(2500);
  const u = p.url();
  const t = (await p.title().catch(() => "")) || "";
  const err = await p.evaluate(() => {
    const els = [...document.querySelectorAll('[class*="error"],[class*="alert"],[role="alert"]')];
    return els.map((e) => e.innerText.trim()).filter((x) => x && x.length < 200).slice(0, 3).join(" | ");
  }).catch(() => "");
  if (i % 3 === 0) console.log(`  t+${(i + 1) * 2.5}s:`, u.slice(0, 70), "|", t.slice(0, 40), err ? "| ERR: " + err.slice(0, 120) : "");
  if (err && /incorrect|invalid|wrong|failed/i.test(err)) { console.log("LOGIN FAILED:", err.slice(0, 200)); break; }
  if (!/sign-?in|login/i.test(u) && !/just a moment/i.test(t)) { loggedIn = true; break; }
}
console.log("loggedIn:", loggedIn, "| final:", p.url(), "|", (await p.title().catch(() => "")).slice(0, 60));

// onboarding gate: "Select a Trading Mode" → Start Simulated Trading opens the
// workspace. RETRY-robust: the gate renders late and clicks sometimes land before
// the button mounts — keep cycling until canvases appear (max ~75s)
let canvases = 0;
for (let attempt = 0; attempt < 6 && canvases === 0; attempt++) {
  const gateBtn = p.locator('button:has-text("Start Simulated Trading")');
  if ((await gateBtn.count()) > 0) {
    console.log("onboarding gate detected — selecting Simulation… (attempt " + (attempt + 1) + ")");
    await gateBtn.first().click({ timeout: 8000 }).catch((e) => console.log("mode click:", e.message.slice(0, 50)));
    await p.locator('button:has-text("Accept Cookies")').first().click({ timeout: 2500 }).catch(() => {});
    await p.waitForTimeout(6000);
  } else {
    await p.waitForTimeout(4000);
  }
  canvases = await p.evaluate(() => document.querySelectorAll("canvas").length).catch(() => 0);
  console.log("  attempt " + (attempt + 1) + ": canvases=" + canvases + " url=" + p.url().slice(0, 60));
}
console.log("workspace canvases:", canvases, "| url:", p.url());
if (canvases === 0) {
  console.log("FATAL: workspace never mounted — session export skipped (rerun this script)");
  await b.close();
  process.exit(2);
}
// restore a RICH default workspace before exporting the session:
// 1) close the notifications drawer (it covers a third of the screen)
await p.evaluate(() => {
  const drawers = [...document.querySelectorAll("div,section,aside")].filter((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return cs.position === "fixed" && r.width > 200 && r.height > innerHeight * 0.6 && r.left > innerWidth * 0.6 && /member|notification|renewed|subscription/i.test(el.innerText || "");
  });
  for (const d of drawers) {
    const closer = [...d.querySelectorAll("button,[role=button],svg,[class*=close]")].find((b) => {
      const r = b.getBoundingClientRect();
      return r.width < 40 && r.height < 40 && r.top < d.getBoundingClientRect().top + 80;
    });
    if (closer) closer.click();
  }
}).catch(() => {});
await p.waitForTimeout(800);
// 2) ensure the Market Analyzer module (quotes grid) is open — the layout persists
// server-side and earlier exploration runs may have closed it
const hasMA = await p.evaluate(() => /Market Analyzer/i.test((document.body.innerText || "")));
if (!hasMA) {
  console.log("Market Analyzer missing — reopening via module picker…");
  await p.locator('.btn-icon[title="Add module"], .btn-icon[aria-label="Add module"]').first()
    .click({ timeout: 5000 }).catch((e) => console.log("add-module click:", e.message.slice(0, 60)));
  await p.waitForTimeout(1200);
  await p.locator('.item:has-text("Market Analyzer"), [role="menuitem"]:has-text("Market Analyzer")').first()
    .click({ timeout: 5000 }).catch((e) => console.log("MA entry click:", e.message.slice(0, 60)));
  await p.waitForTimeout(2500);
  console.log("MA present now:", await p.evaluate(() => /Market Analyzer/i.test((document.body.innerText || ""))));
}
await p.waitForTimeout(4000); // let market data/widgets settle
await p.screenshot({ path: "output/_tv-platform.png" });

const cookies = await ctx.cookies();
fs.writeFileSync("output/tradovate-cookies.json", JSON.stringify(cookies, null, 2));
console.log("cookies exported:", cookies.length);
// SPA auth often lives in localStorage/sessionStorage — export both for the cloner -s flag
const storage = await p.evaluate(() => {
  const grab = (s) => Object.fromEntries(Object.entries({ ...s }).map(([k, v]) => [k, String(v)]));
  return { ls: grab(localStorage), ss: grab(sessionStorage) };
});
fs.writeFileSync("output/tradovate-storage.json", JSON.stringify(storage, null, 2));
console.log("storage exported: ls=" + Object.keys(storage.ls).length + " ss=" + Object.keys(storage.ss).length);
await b.close();
