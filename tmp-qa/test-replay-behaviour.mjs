import { chromium } from "playwright";
const b = await chromium.launch({ headless: false, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 180)));
const log = (...a) => console.log(...a);
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.evaluate(() => localStorage.removeItem("tv-clone-workspaces"));
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(1000);

/* ---------- 1) MARKET REPLAY ---------- */
await p.locator(".tv-metric-btn").first().click(); await p.waitForTimeout(300);
const goReplay = p.locator(".tv-menu .tv-menu-item").filter({ hasText: "Go to Replay" }).first();
log("Go to Replay present:", await goReplay.count());
await goReplay.click(); await p.waitForTimeout(400);
log("setup modal:", await p.locator(".tv-replay-setup").count());
await p.locator(".tv-replay-form select").first().selectOption("ESZ6");
await p.locator(".tv-replay-row select").nth(2).selectOption("10");
await p.locator(".tv-replay-actions .tv-btn--primary").click(); await p.waitForTimeout(600);
log("player open:", await p.locator(".tv-replay-player").count());
const st1 = await p.evaluate(() => ({ price: document.querySelector(".tv-replay-price b")?.innerText, idx: document.querySelector(".tv-replay-controls .tv-muted")?.innerText, badge: document.querySelector(".mod-chart .tv-symbol-desc")?.innerText }));
await p.waitForTimeout(2500);
const st2 = await p.evaluate(() => ({ price: document.querySelector(".tv-replay-price b")?.innerText, idx: document.querySelector(".tv-replay-controls .tv-muted")?.innerText }));
log("replay t0:", JSON.stringify(st1), "| t+2.5s:", JSON.stringify(st2));
const advancing = st1.idx !== st2.idx;
// pause
await p.locator(".tv-replay-controls .tv-btn").first().click(); await p.waitForTimeout(700);
const idxPause1 = await p.evaluate(() => document.querySelector(".tv-replay-controls .tv-muted")?.innerText);
await p.waitForTimeout(900);
const idxPause2 = await p.evaluate(() => document.querySelector(".tv-replay-controls .tv-muted")?.innerText);
log("pause holds:", idxPause1 === idxPause2, idxPause1, idxPause2);
// step
await p.locator(".tv-replay-controls .tv-btn").nth(1).click(); await p.waitForTimeout(300);
const afterStep = await p.evaluate(() => document.querySelector(".tv-replay-controls .tv-muted")?.innerText);
log("step advanced:", afterStep !== idxPause2, afterStep);
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/r1-replay.png" });
// stop
await p.locator(".tv-replay-controls .tv-btn").last().click(); await p.waitForTimeout(500);
log("stopped (player gone):", (await p.locator(".tv-replay-player").count()) === 0);

/* ---------- 2) STRESS + BEHAVIOUR ---------- */
const metrics = () => p.evaluate(() => ({
  nodes: document.querySelectorAll("*").length,
  modules: document.querySelectorAll(".tv-module").length,
  charts: document.querySelectorAll(".mod-chart").length,
  heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
}));
const closeAll = async () => { await p.keyboard.press("Escape"); await p.waitForTimeout(80); };
const addTile = async (idx) => { await closeAll(); await p.click(".tv-plus"); await p.waitForTimeout(220); const n = await p.locator(".tv-palette-tile").count(); if (!n) return; await p.locator(".tv-palette-tile").nth(Math.min(idx, n - 1)).click(); await p.waitForTimeout(230); };
for (let i = 0; i < 20; i++) await addTile(i);
for (let i = 0; i < 10; i++) await addTile(1);
const load = await metrics();
log("loaded:", JSON.stringify(load));
const behaviour = [];
const check = async (name, fn) => {
  const t = Date.now();
  try { const ok = await fn(); behaviour.push({ name, ok, ms: Date.now() - t }); } catch (e) { behaviour.push({ name, ok: false, error: e.message.slice(0, 90), ms: Date.now() - t }); }
  log((behaviour.at(-1).ok ? "PASS" : "FAIL"), name, behaviour.at(-1).ms + "ms");
};
await check("palette opens/closes", async () => { await closeAll(); await p.click(".tv-plus"); await p.waitForTimeout(250); const open = (await p.locator(".tv-palette").count()) === 1; await p.keyboard.press("Escape"); await p.waitForTimeout(200); return open && (await p.locator(".tv-palette").count()) === 0; });
await check("module tab switches", async () => {
  const tabs = p.locator(".mod-chart").first().locator("xpath=ancestor::*[contains(@class,'tv-module')][1]").locator(".tv-module-tab");
  const n = await tabs.count(); if (n < 2) return false;
  const before = await tabs.first().innerText(); await tabs.nth(1).click(); await p.waitForTimeout(250);
  return (await tabs.first().innerText()) === before;
});
await check("chart right-click menu", async () => { const ch = p.locator(".mod-chart").first(); const box = await ch.boundingBox(); if (!box) return false; await p.mouse.click(box.x + 120, box.y + 80, { button: "right" }); await p.waitForTimeout(300); const n = await p.locator(".tv-menu .tv-menu-item").count(); await p.keyboard.press("Escape"); return n > 5; });
await check("market order places + fills", async () => {
  const buy = p.locator(".mod-chart").first().locator(".tv-btn--buy").first();
  if (!(await buy.count())) return false;
  await buy.click(); await p.waitForTimeout(2200);
  await p.locator(".tv-rail-btn").nth(3).click(); await p.waitForTimeout(350); // working orders panel
  const txt = await p.locator(".tv-sidepanel").innerText().catch(() => "");
  await p.locator(".tv-rail-btn").nth(3).click();
  return /Working|Filled|MNQ|ESZ|Buy/i.test(txt);
});
await check("rail panels all open", async () => {
  for (let i = 0; i < 8; i++) { await p.locator(".tv-rail-btn").nth(i).click().catch(() => {}); await p.waitForTimeout(140); }
  const open = await p.locator(".tv-sidepanel").count();
  const title = await p.locator(".tv-sidepanel-title").first().innerText().catch(() => "");
  return open === 1 && !!title;
});
await check("theme switch light/dark", async () => {
  await p.locator(".tv-layout-btn").click(); await p.waitForTimeout(250);
  await p.locator(".tv-modal .tv-seg button", { hasText: "light" }).first().click(); await p.waitForTimeout(350);
  const light = await p.evaluate(() => document.documentElement.classList.contains("theme-light"));
  await p.locator(".tv-modal .tv-seg button", { hasText: "dark" }).first().click(); await p.waitForTimeout(350);
  await p.keyboard.press("Escape");
  return light;
});
await check("save workspace + reload restores", async () => {
  await closeAll(); await p.click(".tv-plus"); await p.waitForTimeout(250);
  await p.locator(".tv-template-new input").fill("Behaviour WS");
  await p.locator(".tv-template-new .tv-btn").click(); await p.waitForTimeout(400);
  await p.keyboard.press("Escape");
  const before = (await metrics()).modules;
  await p.reload({ waitUntil: "domcontentloaded" }); await p.waitForSelector(".tv-app"); await p.waitForTimeout(1200);
  const after = (await metrics()).modules;
  return after === before && after >= 20;
});
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/r2-stress-behaviour.png" });
log("FINAL:", JSON.stringify({ load, behaviour, errors: [...new Set(errs)].slice(0, 5), afterReload: await metrics() }));
await b.close();
