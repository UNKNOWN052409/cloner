// Measure REAL Tradovate limits in headless: chart/module/tab caps, and whether
// the Tradovate Assistant panel can be closed / end-chatted.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const EVID = path.join(ROOT, "artifacts", "tradovate-live-capture", "evidence");
const SHOTS = path.join(ROOT, "artifacts", "tradovate-live-capture", "shots");
const env = {};
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) { const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const out = {};

const browser = await chromium.launch({ headless: false, channel: "chrome", args: ["--window-size=1620,950"] });
const ctxOpts = { viewport: { width: 1600, height: 900 }, locale: "en-US" };
if (fs.existsSync(path.join(EVID, "live-session.json"))) ctxOpts.storageState = path.join(EVID, "live-session.json");
const ctx = await browser.newContext(ctxOpts);
const ss = JSON.parse(fs.readFileSync(path.join(EVID, "live-session-storage.json"), "utf8"));
await ctx.addInitScript((e) => { try { if (/tradovate\.com$/.test(location.hostname)) for (const [k, v] of Object.entries(e.ss || {})) sessionStorage.setItem(k, String(v)); } catch {} }, ss);
const page = await ctx.newPage();
page.setDefaultTimeout(25000);

const counts = () => page.evaluate(() => ({
  lmItems: document.querySelectorAll(".lm_item").length,
  lmItemContainers: document.querySelectorAll(".lm_item_container").length,
  lmStacks: document.querySelectorAll(".lm_stack").length,
  tabs: document.querySelectorAll(".lm_tab").length,
  canvases: document.querySelectorAll("canvas").length,
}));

await page.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
for (let i = 0; i < 8; i++) { await page.waitForTimeout(2500); if (await page.locator('input[type="password"]').count().catch(() => 0)) break; if (await page.locator(".lm_goldenlayout").count().catch(() => 0)) break; }
if (await page.locator('input[type="password"]').count()) {
  log("login form — signing in");
  await page.waitForTimeout(800);
  await page.locator('input[type="text"], input[type="email"], input[name="username"]').first().fill(env.TV_USER);
  await page.locator('input[type="password"]').first().fill(env.TV_PASS);
  await page.waitForTimeout(500);
  const loginBtn = page.getByRole("button", { name: "Login", exact: true });
  log("login button count:", await loginBtn.count());
  if (await loginBtn.count()) await loginBtn.first().click().catch(() => page.keyboard.press("Enter"));
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(2000);
    const u = page.url();
    const err = await page.evaluate(() => [...document.querySelectorAll("[class*=error],[role=alert]")].map((x) => (x.innerText || "").trim()).filter(Boolean).slice(0, 2).join(" | ")).catch(() => "");
    if (err) log("login error:", err.slice(0, 160));
    if (i % 3 === 0) log("  t+" + (i * 2 + 2) + "s", u.slice(0, 70), "| title:", (await page.title().catch(() => "")).slice(0, 40));
    if (!/welcome/i.test(u)) break;
    const pw = page.locator('input[type="password"]');
    if (await pw.count()) { await pw.first().fill(env.TV_PASS); await loginBtn.first().click().catch(() => {}); }
  }
  log("after login:", page.url());
}
for (let i = 0; i < 14; i++) {
  const isWorkspace = await page.evaluate(() => document.querySelectorAll("canvas").length > 0 && /Account|Chart|DOM|Market/i.test(document.body.innerText || "")).catch(() => false);
  if (isWorkspace) { log("workspace detected at gate", i); break; }
  if (/welcome/i.test(page.url())) {
    log("session lost at gate", i, "— re-login");
    const pw = page.locator('input[type="password"]');
    if (await pw.count().catch(() => 0)) {
      await page.locator('input[type="text"], input[type="email"], input[name="username"]').first().fill(env.TV_USER);
      await pw.first().fill(env.TV_PASS);
      await page.getByRole("button", { name: "Login", exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(7000);
    }
  }
  const start = page.locator('button:has-text("Start Simulated Trading")');
  const hasStart = await start.count().catch(() => 0);
  if (hasStart) await start.first().click().catch(() => {});
  await page.locator('button:has-text("Accept Cookies")').first().click({ timeout: 1200 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (i % 2 === 0) log("gate", i, page.url().slice(0, 60), "start:", hasStart);
}
await page.waitForTimeout(3000);
await page.waitForTimeout(4000);
out.url = page.url();
out.baseline = await counts();
log("baseline:", JSON.stringify(out.baseline));
await page.screenshot({ path: path.join(SHOTS, "limits-00-baseline.png") });

/* ---------------- assistant panel: can it close? ---------------- */
const assistant = await page.evaluate(() => {
  const res = { iframe: !!document.querySelector("iframe"), iframeInfo: null, closeCandidates: [] };
  const ifr = document.querySelector("iframe");
  if (ifr) { const r = ifr.getBoundingClientRect(); res.iframeInfo = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), src: (ifr.src || "").slice(0, 80) }; }
  for (const el of document.querySelectorAll("button, [role=button], a, span, div")) {
    const t = (el.innerText || "").trim();
    const aria = el.getAttribute("title") || el.getAttribute("aria-label") || "";
    if (/^(✕|X|×|Close|End Chat)$/i.test(t) || /close|end.?chat/i.test(aria) || /close/i.test((el.className || "").toString())) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) res.closeCandidates.push({ tag: el.tagName, cls: (el.className || "").toString().slice(0, 60), text: t.slice(0, 20), aria, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  return res;
});
out.assistant = assistant;
log("assistant iframe:", JSON.stringify(assistant.iframeInfo), "close candidates:", assistant.closeCandidates.length);
fs.writeFileSync(path.join(EVID, "limits-assistant.json"), JSON.stringify(assistant, null, 2));

// try the panel close button (top-right X inside the panel area)
const closeBtn = assistant.closeCandidates.find((c) => c.x > 1000 && /close|✕|X|×/i.test(c.aria + c.text));
if (closeBtn) {
  await page.mouse.click(closeBtn.x + closeBtn.w / 2, closeBtn.y + closeBtn.h / 2);
  await page.waitForTimeout(1500);
  out.assistant.afterCloseClick = await page.evaluate(() => ({ iframe: !!document.querySelector("iframe"), iframeRect: (() => { const f = document.querySelector("iframe"); if (!f) return null; const r = f.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })() }));
  await page.screenshot({ path: path.join(SHOTS, "limits-01-assistant-closed.png") });
  log("after close click:", JSON.stringify(out.assistant.afterCloseClick));
}
// End Chat button
const endChat = page.locator('button:has-text("End Chat")').first();
if (await endChat.count().catch(() => 0)) {
  await endChat.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1500);
  out.assistant.afterEndChat = await page.evaluate(() => ({ iframe: !!document.querySelector("iframe"), bodyHasEnd: /End Chat/i.test(document.body.innerText) }));
  await page.screenshot({ path: path.join(SHOTS, "limits-02-end-chat.png") });
  log("after End Chat:", JSON.stringify(out.assistant.afterEndChat));
}

/* ---------------- how many charts can be added? ---------------- */
const addChart = async () => {
  const plus = page.locator(".icon-plus").first();
  await plus.click({ force: true }).catch(() => {});
  await page.waitForTimeout(700);
  const tile = page.locator("li").filter({ hasText: /^Chart$/ }).first();
  if (!(await tile.count().catch(() => 0))) { await page.keyboard.press("Escape"); return false; }
  const box = await tile.boundingBox();
  if (!box) { await page.keyboard.press("Escape"); return false; }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(820, 430, { steps: 8 });
  await page.mouse.move(880, 480, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(2200);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
  return true;
};

out.chartAdds = [];
let prev = (await counts()).lmItems;
for (let i = 1; i <= 15; i++) {
  const ok = await addChart();
  await page.waitForTimeout(1200);
  const c = await counts();
  out.chartAdds.push({ attempt: i, dragged: ok, ...c });
  if (c.lmItems <= prev) {
    out.chartAdds.push({ note: "no new module on attempt " + i, prev, now: c.lmItems });
    break;
  }
  prev = c.lmItems;
}
await page.screenshot({ path: path.join(SHOTS, "limits-03-many-charts.png") });
log("chart adds:", JSON.stringify(out.chartAdds.slice(-4)));

// how many tabs can one stack hold? count current tab strip
out.tabsNow = await page.evaluate(() => document.querySelectorAll(".lm_tab").length);

fs.writeFileSync(path.join(EVID, "limits.json"), JSON.stringify(out, null, 2));
log("DONE", JSON.stringify({ baseline: out.baseline, assistantCloseWorks: out.assistant?.afterCloseClick?.iframe === false, adds: out.chartAdds.length }));
await browser.close();
