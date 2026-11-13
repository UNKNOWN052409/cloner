import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.evaluate(() => localStorage.removeItem("tv-clone-workspaces"));
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(900);
const m = () => p.evaluate(() => ({
  nodes: document.querySelectorAll("*").length,
  modules: document.querySelectorAll(".tv-module").length,
  charts: document.querySelectorAll(".mod-chart").length,
  canvases: document.querySelectorAll("canvas").length,
  heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
}));
const closeAll = async () => { await p.keyboard.press("Escape"); await p.waitForTimeout(80); };
const addTile = async (idx) => {
  await closeAll();
  await p.click(".tv-plus"); await p.waitForTimeout(220);
  const n = await p.locator(".tv-palette-tile").count();
  if (!n) return false;
  await p.locator(".tv-palette-tile").nth(Math.min(idx, n - 1)).click(); await p.waitForTimeout(260);
  return true;
};
const snap = [];
snap.push({ stage: "base", ...(await m()) });
for (let i = 0; i < 20; i++) { await addTile(i); if (i % 5 === 4) snap.push({ stage: `after tiles 0..${i}`, ...(await m()) }); }
snap.push({ stage: "all 20 tile types", ...(await m()) });
for (let i = 0; i < 10; i++) await addTile(1); // extra chart panes
snap.push({ stage: "+10 chart panes", ...(await m()) });
// responsiveness
const t0 = Date.now();
for (let i = 0; i < 6; i++) { await closeAll(); await p.click(".tv-plus"); await p.waitForTimeout(60); }
const roundtrip = Math.round((Date.now() - t0) / 6);
await closeAll();
// save + reload persistence
await p.click(".tv-plus"); await p.waitForTimeout(250);
await p.locator(".tv-template-new input").fill("Max Workspace");
await p.locator(".tv-template-new .tv-btn").click(); await p.waitForTimeout(500);
await closeAll();
const saved = await p.evaluate(() => (JSON.parse(localStorage.getItem("tv-clone-workspaces") || "{}").tabs || []).map((t) => t.name));
await p.reload({ waitUntil: "domcontentloaded" }); await p.waitForSelector(".tv-app"); await p.waitForTimeout(1200);
const restored = await m();
console.log(JSON.stringify({ snap, paletteRoundtripMs: roundtrip, savedWorkspaces: saved, restoredAfterReload: restored, errors: [...new Set(errs)] }, null, 1));
await b.close();
