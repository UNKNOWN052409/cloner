import { chromium } from "playwright";
const b = await chromium.launch({ headless: false, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 180)));
const log = (...a) => console.log(...a);
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.evaluate(() => localStorage.removeItem("tv-clone-workspaces"));
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(1000);
const metrics = () => p.evaluate(() => ({
  nodes: document.querySelectorAll("*").length, modules: document.querySelectorAll(".tv-module").length,
  charts: document.querySelectorAll(".mod-chart").length, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
}));
const addTile = async (idx) => { await p.keyboard.press("Escape"); await p.click(".tv-plus"); await p.waitForTimeout(200); const n = await p.locator(".tv-palette-tile").count(); if (!n) return; await p.locator(".tv-palette-tile").nth(Math.min(idx, n - 1)).click(); await p.waitForTimeout(200); };
for (let i = 0; i < 20; i++) await addTile(i);
for (let i = 0; i < 10; i++) await addTile(1);
await p.keyboard.press("Escape");
const load = await metrics();
log("loaded:", JSON.stringify(load));

const results = [];
const check = async (name, fn) => { const t = Date.now(); let ok = false, detail = ""; try { const r = await fn(); ok = r === true || (r && r.ok); detail = (r && r.detail) || ""; } catch (e) { detail = e.message.slice(0, 100); } results.push({ name, ok, ms: Date.now() - t, detail }); log(ok ? "PASS" : "FAIL", name, Date.now() - t + "ms", detail); };

await check("palette open/close", async () => { await p.keyboard.press("Escape"); await p.click(".tv-plus"); await p.waitForTimeout(200); const open = (await p.locator(".tv-palette").count()) === 1; await p.keyboard.press("Escape"); await p.waitForTimeout(150); return open && (await p.locator(".tv-palette").count()) === 0; });

await check("module tab switching", async () => {
  const idx = await p.evaluate(() => [...document.querySelectorAll(".tv-module")].findIndex((m) => m.querySelectorAll(".tv-module-tab").length > 1));
  if (idx < 0) return { ok: false, detail: "no multi-tab group" };
  const mod = p.locator(".tv-module").nth(idx);
  const tabs = mod.locator(".tv-module-tab");
  const idxOf = async () => mod.locator(".tv-module-tab").evaluateAll((els) => els.findIndex((e) => e.classList.contains("is-active")));
  const before = await idxOf();
  await tabs.nth(before === 0 ? 1 : 0).click(); await p.waitForTimeout(200);
  const after = await idxOf();
  return { ok: after !== before, detail: `active tab ${before} -> ${after}` };
});

await check("chart right-click menu", async () => {
  const box = await p.evaluate(() => {
    const charts = [...document.querySelectorAll(".mod-chart")];
    const el = charts.find((c) => c.getBoundingClientRect().height > 120 && c.getBoundingClientRect().width > 200);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  if (!box) return { ok: false, detail: "no usable chart" };
  await p.mouse.click(box.x + 60, box.y + 60, { button: "right" }); await p.waitForTimeout(300);
  const items = await p.locator(".tv-menu .tv-menu-item").count();
  await p.keyboard.press("Escape");
  return { ok: items > 5, detail: `menu items=${items}` };
});

await check("market order places + fills", async () => {
  const chartIdx = await p.evaluate(() => [...document.querySelectorAll(".mod-chart")].findIndex((c) => {
    const btn = c.querySelector(".tv-btn--buy"); const r = c.getBoundingClientRect();
    return btn && r.height > 120;
  }));
  if (chartIdx < 0) return { ok: false, detail: "no tradeable chart" };
  await p.locator(".mod-chart").nth(chartIdx).locator(".tv-btn--buy").first().click();
  await p.waitForTimeout(2200);
  await p.locator(".tv-rail-btn").nth(3).click(); await p.waitForTimeout(350);
  const txt = await p.locator(".tv-sidepanel").innerText().catch(() => "");
  await p.locator(".tv-rail-btn").nth(3).click(); await p.waitForTimeout(200);
  return { ok: /Working|Filled|Buy|Sell/i.test(txt), detail: txt.replace(/\s+/g, " ").slice(0, 90) };
});

await check("all rail panels open with titles", async () => {
  const titles = [];
  for (let i = 0; i < 8; i++) {
    await p.locator(".tv-rail-btn").nth(i).click().catch(() => {});
    await p.waitForTimeout(180);
    titles.push(await p.locator(".tv-sidepanel-title").first().innerText().catch(() => ""));
  }
  return { ok: titles.every(Boolean), detail: titles.join(" | ") };
});

await check("theme switch", async () => {
  await p.locator(".tv-layout-btn").click(); await p.waitForTimeout(250);
  await p.locator(".tv-modal .tv-seg button", { hasText: "light" }).first().click(); await p.waitForTimeout(400);
  const light = await p.evaluate(() => document.documentElement.classList.contains("theme-light"));
  await p.locator(".tv-modal .tv-seg button", { hasText: "dark" }).first().click(); await p.waitForTimeout(400);
  await p.keyboard.press("Escape");
  return { ok: light, detail: "light applied" };
});

await check("save workspace + reload restores layout", async () => {
  await p.keyboard.press("Escape"); await p.click(".tv-plus"); await p.waitForTimeout(250);
  await p.locator(".tv-template-new input").fill("Behaviour WS");
  await p.locator(".tv-template-new .tv-btn").click(); await p.waitForTimeout(400);
  await p.keyboard.press("Escape");
  const before = (await metrics()).modules;
  await p.reload({ waitUntil: "domcontentloaded" }); await p.waitForSelector(".tv-app"); await p.waitForTimeout(1200);
  const after = (await metrics()).modules;
  return { ok: after === before && after >= 20, detail: `${before} -> ${after} modules` };
});

// multi-chart interaction under load: two charts both update independently
await check("multi-chart symbols independent", async () => {
  const syms = await p.evaluate(() => [...document.querySelectorAll(".mod-chart")].map((m) => m.querySelector(".tv-symbol-picker-sym")?.innerText).filter(Boolean));
  return { ok: new Set(syms).size >= 2, detail: syms.slice(0, 8).join(",") };
});

const final = await metrics();
log("FINAL", JSON.stringify({ load, final, results, errors: [...new Set(errs)].slice(0, 5) }));
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/r3-behaviour-stress.png" });
await b.close();
