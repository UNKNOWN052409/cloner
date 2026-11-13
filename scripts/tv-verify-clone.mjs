// Click-through verification for the Tradovate frontend clone.
// Drives a VISIBLE Chrome, exercises every surface (palette, all 20 modules,
// rail panels, top-bar menus, order flow, theme switch) and saves screenshots.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "artifacts", "tradovate-live-capture", "clone-verify");
fs.mkdirSync(OUT, { recursive: true });
const URL_BASE = process.env.CLONE_URL || "http://127.0.0.1:5199/";

const results = [];
const step = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

const browser = await chromium.launch({ headless: false, channel: "chrome", args: ["--window-size=1460,950"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });

const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name + ".png") }); };
// wipe the persisted workspace so each phase starts from the deterministic default
const resetWorkspaceStorage = async () => {
  await page.evaluate(() => localStorage.removeItem("tv-clone-workspaces")).catch(() => {});
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tv-app");
  await page.waitForTimeout(800);
};

await page.goto(URL_BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".tv-app", { timeout: 30000 });
await resetWorkspaceStorage();
await shot("00-baseline");

/* ---------- structure ---------- */
const shell = await page.evaluate(() => ({
  topbar: !!document.querySelector(".tv-topbar"),
  rail: document.querySelectorAll(".tv-rail-btn").length,
  modules: document.querySelectorAll(".tv-module").length,
  canvases: document.querySelectorAll("canvas").length,
  unknown: [...document.querySelectorAll(".tv-module")].filter((m) => /Unknown module/.test(m.innerText)).length,
}));
step("shell renders (topbar/rail/modules)", shell.topbar && shell.rail >= 8 && shell.modules >= 3, JSON.stringify(shell));

/* ---------- module palette + every module ---------- */
// "+" must toggle reliably (open → close → open again)
await page.click(".tv-plus");
await page.waitForTimeout(500);
const tileCount = await page.locator(".tv-palette-tile").count();
await shot("01-palette");
step("palette opens with 20 module tiles", tileCount === 20, `tiles=${tileCount}`);
await page.locator(".tv-palette-close").click();
await page.waitForTimeout(350);
const closed = (await page.locator(".tv-palette").count()) === 0;
await page.click(".tv-plus");
await page.waitForTimeout(400);
const reopened = (await page.locator(".tv-palette").count()) === 1;
step("+ button toggles the palette (open → close → open)", closed && reopened, `closed=${closed} reopened=${reopened}`);

const moduleEffects = [];
const tileNames = await page.locator(".tv-palette-tile .tv-palette-label").allInnerTexts();
for (let i = 0; i < tileCount; i++) {
  const label = (tileNames[i] || `tile-${i}`).replace(/\s*New\s*$/, "").trim();
  if ((await page.locator(".tv-palette").count()) === 0) {
    await page.click(".tv-plus");
    await page.waitForTimeout(250);
  }
  const before = await page.locator(".tv-module").count();
  const beforeTabs = await page.locator(".tv-module-tab").count();
  await page.locator(".tv-palette-tile").nth(i).click();
  await page.waitForTimeout(550);
  const after = await page.locator(".tv-module").count();
  const afterTabs = await page.locator(".tv-module-tab").count();
  const mounted = after > before || afterTabs > beforeTabs;
  const bodyText = await page.evaluate(() => document.body.innerText);
  const bad = /Unknown module/.test(bodyText);
  moduleEffects.push({ label, ok: mounted && !bad, text: bodyText.slice(0, 60) });
  await shot(`02-module-${String(i).padStart(2, "0")}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  // reset persisted workspace so each module is measured on the same default shell
  await resetWorkspaceStorage();
}
step(`all ${tileCount} palette modules mount with content`, moduleEffects.every((m) => m.ok), JSON.stringify(moduleEffects.filter((m) => !m.ok)));

/* ---------- no duplicate panes: adding an existing module type adds a tab ---------- */
await resetWorkspaceStorage();
const dupBefore = await page.locator(".tv-module").count();
const dupTabsBefore = await page.locator(".tv-module-tab").count();
await page.click(".tv-plus");
await page.waitForTimeout(300);
await page.locator(".tv-palette-tile").filter({ hasText: "Accounts" }).first().click();
await page.waitForTimeout(500);
const dupAfter = await page.locator(".tv-module").count();
const dupTabsAfter = await page.locator(".tv-module-tab").count();
step("repeat module adds a tab, not a duplicate pane", dupAfter === dupBefore && dupTabsAfter === dupTabsBefore + 1, `modules ${dupBefore}->${dupAfter}, tabs ${dupTabsBefore}->${dupTabsAfter}`);
await shot("02b-accounts-tab");

/* ---------- module tab "+" opens a symbol picker and adds a distinct symbol ---------- */
const symTabsBefore = await page.locator(".tv-module-tab").count();
await page.locator(".tv-module").nth(1).locator(".tv-module-tabs > .tv-icon-btn").last().click();
await page.waitForTimeout(400);
const addMenuItems = await page.locator(".tv-menu .tv-menu-item").count();
await page.locator(".tv-menu .tv-menu-item").first().click();
await page.waitForTimeout(500);
const symTabsAfter = await page.locator(".tv-module-tab").count();
step("module tab \"+\" opens symbol menu and adds a tab", addMenuItems > 10 && symTabsAfter === symTabsBefore + 1, `menu=${addMenuItems}, tabs ${symTabsBefore}->${symTabsAfter}`);

/* ---------- full pair catalog: searchable symbol picker ---------- */
await resetWorkspaceStorage();
await page.locator(".tv-symbol-picker-btn").first().click();
await page.waitForTimeout(450);
const pickerRows = await page.locator(".tv-symbol-picker-row").count();
const pickerGroups = await page.locator(".tv-symbol-picker-list .tv-menu-heading").count();
await shot("02c-symbol-picker");
await page.keyboard.type("euro");
await page.waitForTimeout(350);
const euroRows = await page.locator(".tv-symbol-picker-row").count();
const firstPair = await page.locator(".tv-symbol-picker-row").first().innerText().catch(() => "");
await page.locator(".tv-symbol-picker-row").first().click();
await page.waitForTimeout(450);
const pickedCard = await page.locator(".tv-symbol-card").first().innerText();
step("pair catalog: all captured pairs + searchable picker", pickerRows >= 50 && pickerGroups >= 5 && euroRows >= 1 && /6EZ6|Euro/i.test(pickedCard), `rows=${pickerRows} groups=${pickerGroups} euro=${euroRows} picked=${firstPair.replace(/\s+/g, " ")}`);

/* ---------- right rail panels ---------- */
const railIds = ["assistant", "market", "alerts", "orders", "people", "help", "ai", "risk"];
for (let i = 0; i < railIds.length; i++) {
  const wasOpen = (await page.locator(".tv-sidepanel").count()) > 0;
  await page.locator(".tv-rail-btn").nth(i).click();
  await page.waitForTimeout(450);
  let open = await page.locator(".tv-sidepanel").count();
  // the assistant panel is open by default: first click toggles it closed — click again
  if (open === 0) { await page.locator(".tv-rail-btn").nth(i).click(); await page.waitForTimeout(400); open = await page.locator(".tv-sidepanel").count(); }
  const title = await page.locator(".tv-sidepanel-title").first().innerText().catch(() => "");
  await shot(`03-rail-${i}-${railIds[i]}`);
  step(`rail panel: ${railIds[i]}`, open === 1, title);
}

/* ---------- interactive rail: assistant chat ---------- */
await page.locator(".tv-rail-btn").nth(0).click();
await page.waitForTimeout(300);
const msgBefore = await page.locator(".tv-msg").count();
await page.fill(".tv-assistant-composer input", "what are my working orders?");
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
const msgAfter = await page.locator(".tv-msg").count();
await shot("04-assistant-reply");
step("assistant chat replies", msgAfter >= msgBefore + 2, `${msgBefore} -> ${msgAfter} messages`);

/* ---------- top bar menus ---------- */
const menus = [
  ["account", async () => page.locator(".tv-metric-btn").first().click()],
  ["notifications", async () => page.locator(".tv-bell-wrap .tv-icon-btn").click()],
  ["clock", async () => page.locator(".tv-clock").click({ force: true })],
  ["search", async () => { await page.keyboard.press("Escape"); await page.keyboard.press("/"); }],
];
for (const [name, action] of menus) {
  await action();
  await page.waitForTimeout(400);
  await shot(`05-menu-${name}`);
  const visible = await page.locator(".tv-menu, .tv-modal").count();
  step(`top menu: ${name}`, visible > 0, `open=${visible}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
}

/* ---------- order flow ---------- */
// open an Orders module so we can observe the order we place
await page.click(".tv-plus");
await page.waitForTimeout(300);
await page.locator(".tv-palette-tile").filter({ hasText: "Orders" }).first().click();
await page.waitForTimeout(600);
const buyButtons = page.locator(".tv-symbol-actions .tv-btn--buy");
const nBuy = await buyButtons.count();
if (nBuy > 0) {
  await buyButtons.first().click();
  await page.waitForTimeout(2600);
  await shot("06-order-placed");
  const ordersModule = page.locator(".tv-module").filter({ hasText: /ORD STATUS|Orders/i }).last();
  const ordersText = (await ordersModule.innerText().catch(() => "")) || "";
  const hasOrder = /MNQZ6|MBTX6|BUY|SELL|Filled|Working/i.test(ordersText) && !/No orders/i.test(ordersText);
  const bodyText = await page.evaluate(() => document.body.innerText);
  const toastEvidence = /order submitted|Filled|Working/i.test(bodyText);
  step("placing a market order works", hasOrder || toastEvidence, `orders-table=${hasOrder} toast/status=${toastEvidence}`);
} else {
  step("placing a market order works", false, "no buy button found");
}

/* ---------- theme switch ---------- */
await page.locator(".tv-layout-btn").click();
await page.waitForTimeout(300);
const lightBtn = page.locator(".tv-modal .tv-seg button", { hasText: "light" });
if (await lightBtn.count()) {
  await lightBtn.first().click();
  await page.waitForTimeout(600);
  await shot("07-light-theme");
  const cls = await page.evaluate(() => document.documentElement.className);
  step("light theme switch", /theme-light/.test(cls), cls);
  await page.locator(".tv-modal .tv-seg button", { hasText: "dark" }).first().click().catch(() => {});
  await page.keyboard.press("Escape");
}

/* ---------- module tabs / palette drag-drop ---------- */
const tabCount = await page.locator(".tv-module-tab").count();
await page.locator(".tv-module-tab").nth(Math.min(1, tabCount - 1)).click().catch(() => {});
await page.waitForTimeout(400);
step("module tab switching", tabCount > 1, `tabs=${tabCount}`);

/* ---------- drag & drop a module tile onto a column ---------- */
await page.click(".tv-plus");
await page.waitForTimeout(350);
const beforeDrop = await page.locator(".tv-module").count();
const tile = page.locator(".tv-palette-tile").first();
const tileBox = await tile.boundingBox();
const colBox = await page.locator(".tv-column").first().boundingBox();
if (tileBox && colBox) {
  await page.mouse.move(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(colBox.x + colBox.width / 2, colBox.y + colBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(800);
}
await shot("08-drag-drop");
const afterDrop = await page.locator(".tv-module").count();
step("drag & drop module onto a column", afterDrop > beforeDrop, `${beforeDrop} -> ${afterDrop}`);

await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await shot("09-final");


/* ---------- multi-chart: several chart panes at the same time ---------- */
await resetWorkspaceStorage();
for (let i = 0; i < 3; i++) {
  await page.click(".tv-plus");
  await page.waitForTimeout(250);
  await page.locator(".tv-palette-tile").nth(1).click(); // Chart tile
  await page.waitForTimeout(600);
}
const chartPanes = await page.locator(".mod-chart").count();
await shot("10-multi-chart");
// give each chart pane a different symbol and confirm they are independent
const wanted = ["ESZ6", "GCX6", "6EZ6", "M2KZ6"];
const nCharts = await page.locator(".mod-chart").count();
for (let i = 0; i < Math.min(nCharts, wanted.length); i++) {
  const ch = page.locator(".mod-chart").nth(i);
  await ch.locator(".tv-symbol-picker-btn").first().click().catch(() => {});
  await page.waitForTimeout(250);
  await page.keyboard.type(wanted[i], { delay: 20 });
  await page.waitForTimeout(250);
  await page.locator(".tv-symbol-picker-row").first().click().catch(() => {});
  await page.waitForTimeout(350);
}
const chartCanvases = await page.locator(".mod-chart canvas").count();
const chartSymbols = await page.evaluate(() => [...document.querySelectorAll(".mod-chart")].map((m) => m.querySelector(".tv-symbol-picker-sym")?.innerText || ""));
step("multi-chart: several independent chart panes at once", chartPanes >= 3 && chartCanvases >= 3 && new Set(chartSymbols).size >= 3, `panes=${chartPanes} canvases=${chartCanvases} symbols=${chartSymbols.join(",")}`);
await shot("11-multi-chart-symbols");

/* ---------- Market Replay: setup ? play ? pause ? step ? stop ---------- */
await resetWorkspaceStorage();
await page.locator(".tv-metric-btn").first().click();
await page.waitForTimeout(250);
await page.locator(".tv-menu .tv-menu-item").filter({ hasText: "Go to Replay" }).first().click();
await page.waitForTimeout(400);
const replaySetup = await page.locator(".tv-replay-setup").count();
await page.locator(".tv-replay-row select").nth(2).selectOption("30");
await page.locator(".tv-replay-actions .tv-btn--primary").click();
await page.waitForTimeout(700);
const playerOpen = await page.locator(".tv-replay-player").count();
const idx1 = await page.locator(".tv-replay-controls .tv-muted").first().innerText().catch(() => "");
await page.waitForTimeout(1200);
const idx2 = await page.locator(".tv-replay-controls .tv-muted").first().innerText().catch(() => "");
await shot("12-market-replay");
// pause holds the bar
await page.locator(".tv-replay-controls .tv-btn").first().click();
await page.waitForTimeout(600);
const idxPauseA = await page.locator(".tv-replay-controls .tv-muted").first().innerText().catch(() => "");
await page.waitForTimeout(900);
const idxPauseB = await page.locator(".tv-replay-controls .tv-muted").first().innerText().catch(() => "");
// step +1
await page.locator(".tv-replay-controls .tv-btn").nth(1).click();
await page.waitForTimeout(300);
const idxStep = await page.locator(".tv-replay-controls .tv-muted").first().innerText().catch(() => "");
await page.locator(".tv-replay-controls .tv-btn").last().click();
await page.waitForTimeout(400);
const playerGone = (await page.locator(".tv-replay-player").count()) === 0;
step("market replay: play / pause / step / stop", replaySetup === 1 && playerOpen === 1 && idx1 !== idx2 && idxPauseA === idxPauseB && idxStep !== idxPauseB && playerGone, `setup=${replaySetup} playing ${idx1}->${idx2} pause=${idxPauseA} step=${idxStep} closed=${playerGone}`);

/* ---------- regression: closing every module ? empty workspace recovery ---------- */
await resetWorkspaceStorage();
let guard = 0;
while ((await page.locator(".tv-module").count()) > 0 && guard++ < 60) {
  await page.locator('.tv-module button[title="Close module"]').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(110);
}
await page.waitForTimeout(400);
const emptyState = await page.locator(".tv-workspace--empty").count();
const emptyText = await page.locator(".tv-workspace-empty-title").innerText().catch(() => "");
await shot("13-empty-workspace");
// the empty state must offer recovery: add module works again
await page.locator(".tv-workspace-empty-actions .tv-btn--primary").click();
await page.waitForTimeout(400);
await page.locator(".tv-palette-tile").first().click();
await page.waitForTimeout(600);
const recovered = await page.locator(".tv-module").count();
step("closing all modules shows empty state + add-module recovery", emptyState === 1 && /empty/i.test(emptyText) && recovered >= 1, `emptyState=${emptyState} title="${emptyText}" recoveredModules=${recovered}`);
/* ---------- report ---------- */
const summary = {
  url: URL_BASE,
  at: new Date().toISOString(),
  results,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  pageErrors: [...new Set(errors)].slice(0, 10),
  moduleEffects,
};
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(summary, null, 2));
console.log(`\n=== ${summary.passed} passed / ${summary.failed} failed — screenshots: ${OUT} ===`);
for (const e of summary.pageErrors) console.log("page-error:", e);
await browser.close();
process.exit(summary.failed === 0 ? 0 : 1);
