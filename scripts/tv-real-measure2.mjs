// Real Tradovate: chart/module caps + assistant close behaviour (single headed session).
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
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: "en-US" });
const page = await ctx.newPage();
page.setDefaultTimeout(25000);

await page.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(4500);
if (await page.locator('input[type="password"]').count()) {
  await page.locator('input[type="text"], input[type="email"], input[name="username"]').first().fill(env.TV_USER);
  await page.locator('input[type="password"]').first().fill(env.TV_PASS);
  await page.getByRole("button", { name: "Login", exact: true }).first().click();
  await page.waitForTimeout(7000);
}
for (let i = 0; i < 12; i++) {
  const start = page.locator('button:has-text("Start Simulated Trading")');
  if (await start.count().catch(() => 0)) await start.first().click().catch(() => {});
  await page.locator('button:has-text("Accept Cookies")').first().click({ timeout: 1200 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (await page.evaluate(() => document.querySelectorAll("canvas").length > 0).catch(() => false)) break;
}
await page.waitForTimeout(5000);
// dismiss helper overlays
await page.keyboard.press("Escape").catch(() => {});
for (const sel of ['.icon-close', '[aria-label="close"]', 'button:has-text("Open risk settings")']) {
  const el = page.locator(sel).first();
  if (await el.count().catch(() => 0)) await el.click({ force: true, timeout: 1500 }).catch(() => {});
}
await page.waitForTimeout(800);
log("workspace:", page.url());

const modulesInfo = () => page.evaluate(() => {
  const items = [...document.querySelectorAll(".lm_item")].map((el) => {
    const tab = el.querySelector(".lm_tab");
    const inner = [...el.querySelectorAll("[class*=module]")].slice(0, 3).map((x) => (x.className || "").toString().split(/\s+/).filter((c) => /module/.test(c)).join("."));
    const r = el.getBoundingClientRect();
    return { tab: (tab?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 30), classes: inner, w: Math.round(r.width), h: Math.round(r.height) };
  });
  return {
    lmItems: items.length,
    tabs: document.querySelectorAll(".lm_tab").length,
    canvases: document.querySelectorAll("canvas").length,
    items,
  };
});
out.baseline = await modulesInfo();
log("baseline items:", out.baseline.lmItems, "tabs:", out.baseline.tabs, "canvases:", out.baseline.canvases);
out.baseline.items.forEach((m) => log("  module:", m.tab, "|", m.classes.join(",")));

/* ---------------- assistant open → close ---------------- */
const railInfo = await page.evaluate(() => [...document.querySelectorAll("a.btn.btn-icon, .btn.btn-icon")].map((el) => {
  const r = el.getBoundingClientRect();
  const icon = el.querySelector("i,svg,img");
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), icon: (icon?.className || icon?.tagName || "").toString().slice(0, 50), title: el.getAttribute("title") || "" };
}).filter((b) => b.y > 50));
out.rail = railInfo;
log("rail buttons:", railInfo.length, JSON.stringify(railInfo.slice(0, 10)));
const chat = railInfo.find((b) => /chat/i.test(b.icon)) || railInfo[0];
if (chat) {
  await page.mouse.click(chat.x + chat.w / 2, chat.y + chat.h / 2);
  await page.waitForTimeout(2500);
  out.assistant = { opened: await page.evaluate(() => { const f = document.querySelector("iframe"); if (!f) return null; const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }) };
  await page.screenshot({ path: path.join(SHOTS, "measure-10-assistant-open.png") });
  log("assistant iframe after open:", JSON.stringify(out.assistant.opened));
  // close buttons inside the opened panel area
  const closers = await page.evaluate(() => [...document.querySelectorAll("button, [role=button], i, div")].map((el) => {
    const r = el.getBoundingClientRect();
    const aria = el.getAttribute("aria-label") || el.getAttribute("title") || "";
    return { tag: el.tagName, cls: (el.className || "").toString().slice(0, 40), aria, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter((b) => b.x > 1150 && b.w > 0 && b.w < 40 && b.h > 0 && b.h < 40 && /close/i.test(b.aria + " " + b.cls)));
  out.assistant.closers = closers;
  if (closers.length) {
    await page.mouse.click(closers[0].x + closers[0].w / 2, closers[0].y + closers[0].h / 2);
    await page.waitForTimeout(2000);
    out.assistant.afterClose = await page.evaluate(() => { const f = document.querySelector("iframe"); if (!f) return "no-iframe"; const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
    await page.screenshot({ path: path.join(SHOTS, "measure-11-assistant-closed.png") });
    log("assistant after close:", JSON.stringify(out.assistant.afterClose));
  }
}

/* ---------------- add charts: find the cap ---------------- */
async function openPalette() {
  const addTab = page.getByText("Add modules", { exact: true }).first();
  if (await addTab.count().catch(() => 0)) { await addTab.click({ force: true }).catch(() => {}); await page.waitForTimeout(900); return true; }
  const plus = page.locator(".icon-plus").first();
  if (await plus.count().catch(() => 0)) { await plus.click({ force: true }).catch(() => {}); await page.waitForTimeout(900); return true; }
  return false;
}
async function dragChart() {
  const ok = await openPalette();
  if (!ok) return { ok: false, why: "no palette" };
  const tile = page.locator("li").filter({ hasText: /^Chart$/ }).first();
  if (!(await tile.count().catch(() => 0))) {
    const tiles = await page.locator("li").allInnerTexts();
    await page.keyboard.press("Escape");
    return { ok: false, why: "chart tile not found: " + tiles.slice(0, 12).join("|") };
  }
  const box = await tile.boundingBox();
  if (!box) { await page.keyboard.press("Escape"); return { ok: false, why: "no box" }; }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(700, 380, { steps: 10 });
  await page.mouse.move(820, 450, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(2600);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(600);
  const toast = await page.evaluate(() => [...document.querySelectorAll('[class*="toast"],[class*="alert"],[role="alert"]')].map((e) => (e.innerText || "").trim()).filter(Boolean).slice(0, 3).join(" | "));
  return { ok: true, toast: toast.slice(0, 200) };
}

out.chartSeries = [];
let prev = (await modulesInfo()).lmItems;
for (let i = 1; i <= 10; i++) {
  const r = await dragChart();
  const info = await modulesInfo();
  out.chartSeries.push({ attempt: i, ...r, lmItems: info.lmItems, tabs: info.tabs, canvases: info.canvases });
  log(`chart ${i}:`, r.ok ? "" : r.why, "lmItems", info.lmItems, "tabs", info.tabs, "canvases", info.canvases, r.toast ? "| " + r.toast : "");
  if (!r.ok || info.lmItems <= prev) { out.chartCap = { attempt: i, evidence: r, info: { lmItems: info.lmItems, tabs: info.tabs } }; break; }
  prev = info.lmItems;
}
await page.screenshot({ path: path.join(SHOTS, "measure-12-charts-max.png") });
out.final = await modulesInfo();
fs.writeFileSync(path.join(EVID, "limits2.json"), JSON.stringify(out, null, 2));
try { fs.writeFileSync(path.join(EVID, "live-session3.json"), JSON.stringify(await ctx.storageState(), null, 2)); } catch {}
const ss = await page.evaluate(() => ({ ls: { ...localStorage }, ss: { ...sessionStorage } })).catch(() => null);
if (ss) fs.writeFileSync(path.join(EVID, "live-session3-storage.json"), JSON.stringify({ ls: ss.ls, ss: ss.ss }, null, 2));
log("RESULT assistants:", JSON.stringify({ opened: out.assistant?.opened, afterClose: out.assistant?.afterClose }), "| charts:", JSON.stringify(out.chartSeries.map((c) => `${c.attempt}:${c.lmItems}/${c.tabs}/${c.canvases}`)), "| cap:", !!out.chartCap);
await browser.close();
