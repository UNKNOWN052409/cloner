import { chromium } from "playwright";
const b = await chromium.launch({ headless: false, channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 180)));
const log = (...a) => console.log(...a);
const metrics = () => p.evaluate(() => ({
  nodes: document.querySelectorAll("*").length,
  modules: document.querySelectorAll(".tv-module").length,
  charts: document.querySelectorAll(".mod-chart").length,
  canvases: document.querySelectorAll("canvas").length,
  tabs: document.querySelectorAll(".tv-module-tab").length,
  heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
}));
const addTile = async (idx) => { await p.click(".tv-plus"); await p.waitForTimeout(200); await p.locator(".tv-palette-tile").nth(idx).click(); await p.waitForTimeout(280); };

await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.evaluate(() => localStorage.removeItem("tv-clone-workspaces"));
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(1000);
log("base:", JSON.stringify(await metrics()));

// 1) 10 extra chart panes
for (let i = 0; i < 10; i++) await addTile(1);
log("after 10 chart panes:", JSON.stringify(await metrics()));

// 2) 10 extra tabs on the first module group (+ button)
const plusTab = p.locator(".mod-chart").first().locator("xpath=ancestor::*[contains(@class,\"tv-module\")]").locator(".tv-module-tabs > .tv-icon-btn").last().first();
for (let i = 0; i < 10; i++) { await plusTab.click().catch(() => {}); await p.waitForTimeout(150); }
log("after 10 tabs:", JSON.stringify(await metrics()));

// 3) add all remaining module types
const tileCount = await p.locator(".tv-palette-tile").count().catch(() => 20);
for (let i = 0; i < tileCount; i++) await addTile(i);
log("after all 20 module types:", JSON.stringify(await metrics()));

// 4) click through all rail panels
for (let i = 0; i < 8; i++) { await p.locator(".tv-rail-btn").nth(i).click().catch(() => {}); await p.waitForTimeout(120); }
log("after rail panels:", JSON.stringify(await metrics()));

// 5) responsiveness: palette open/close round trip
const t0 = Date.now();
for (let i = 0; i < 5; i++) { await p.click(".tv-plus"); await p.waitForTimeout(80); await p.keyboard.press("Escape"); await p.waitForTimeout(80); }
log("palette roundtrip avg ms:", Math.round((Date.now() - t0) / 5));

// 6) save workspace + reload persistence
await p.click(".tv-plus"); await p.waitForTimeout(300);
await p.locator(".tv-template-new input").fill("Stress Workspace");
await p.locator(".tv-template-new .tv-btn").click(); await p.waitForTimeout(500);
await p.keyboard.press("Escape");
const wsBefore = await p.evaluate(() => JSON.parse(localStorage.getItem("tv-clone-workspaces") || "null"));
log("saved workspaces:", JSON.stringify((wsBefore?.tabs || []).map((t) => t.name)));
const nodesBeforeReload = (await metrics()).nodes;
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(1200);
const wsAfter = await p.evaluate(() => JSON.parse(localStorage.getItem("tv-clone-workspaces") || "null"));
const m = await metrics();
log("after reload: workspaces:", JSON.stringify((wsAfter?.tabs || []).map((t) => t.name)), "| restored modules:", m.modules, "nodes:", m.nodes, "(pre-reload", nodesBeforeReload + ")");
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/stress-after.png" });

console.log("ERRORS:", [...new Set(errs)].slice(0, 8));
console.log("RESULT", JSON.stringify({ finalMetrics: m, savedWorkspaces: (wsAfter?.tabs || []).map((t) => t.name), errors: errs.length }));
await b.close();
