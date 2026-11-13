// Tradovate live capture — headed Chrome, logs in, explores the module palette,
// right rail, top bar menus. Saves screenshots + DOM/text evidence for the clone.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const OUT = path.join(ROOT, "artifacts", "tradovate-live-capture");
const SHOTS = path.join(OUT, "shots");
const DATA = path.join(OUT, "evidence");
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

const env = {};
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const saveJSON = (name, obj) => fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj, null, 2));
const shot = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + ".png") }); log("shot:", name); };

// newest verified auth session (reuse — repeated logins kick concurrent sessions)
let storageState = null, sessionStorageSidecar = null;
const dirs = fs.readdirSync("artifacts", { withFileTypes: true }).filter((d) => d.isDirectory() && /^exp-/.test(d.name)).map((d) => d.name).sort().reverse();
for (const d of dirs) {
  const s = path.join("artifacts", d, "auth", "session.json");
  const side = path.join("artifacts", d, "auth", "session-storage.json");
  if (fs.existsSync(s)) { storageState = s; if (fs.existsSync(side)) sessionStorageSidecar = side; break; }
}
log("reuse session:", storageState || "none");

const browser = await chromium.launch({ headless: false, channel: "chrome", args: ["--start-maximized"] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  ...(storageState ? { storageState } : {}),
});
if (sessionStorageSidecar) {
  const ss = JSON.parse(fs.readFileSync(sessionStorageSidecar, "utf8"));
  const entries = ss.ss || ss.sessionStorage || ss;
  if (entries && typeof entries === "object") {
    await ctx.addInitScript((entries) => {
      try { if (/tradovate\.com$/.test(location.hostname)) for (const [k, v] of Object.entries(entries)) sessionStorage.setItem(k, String(v)); } catch {}
    }, entries);
  }
}

const page = await ctx.newPage();
page.setDefaultTimeout(20000);
const sleep = (ms) => page.waitForTimeout(ms);

async function isWorkspace() {
  return page.evaluate(() => !!document.querySelector("canvas") || /Chart \+ DOM|Market Analyzer/i.test(document.body.innerText || "")).catch(() => false);
}

async function loginIfNeeded() {
  await page.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
  for (let i = 0; i < 8; i++) { await sleep(2500); if (await page.locator('input[type="password"]').count().catch(() => 0)) break; if (await isWorkspace()) break; }
  if (await page.locator('input[type="password"]').count()) {
    log("login form — authenticating");
    await page.locator('input[type="text"], input[type="email"], input[name="username"], input[name="email"]').first().fill(env.TV_USER);
    await page.locator('input[type="password"]').first().fill(env.TV_PASS);
    await page.screenshot({ path: path.join(SHOTS, "login-filled.png") });
    await page.locator('button:has-text("Login"), button[type="submit"]').first().click().catch(() => page.keyboard.press("Enter"));
    for (let i = 0; i < 12; i++) { await sleep(2500); if (!/welcome|sign-?in/i.test(page.url())) break; }
    log("after login:", page.url());
  }
  // trading-mode gate
  for (let i = 0; i < 12; i++) {
    if (await isWorkspace()) break;
    const start = page.locator('button:has-text("Start Simulated Trading")');
    if (await start.count().catch(() => 0)) { log("onboarding gate — starting simulation"); await start.first().click().catch(() => {}); }
    await page.locator('button:has-text("Accept Cookies")').first().click({ timeout: 1500 }).catch(() => {});
    await sleep(3000);
  }
  // wait for workspace mount
  for (let i = 0; i < 30; i++) {
    if (await page.evaluate(() => !!document.querySelector("canvas") && /Account|Chart|DOM/i.test(document.body.innerText || "")).catch(() => false)) break;
    await sleep(2000);
  }
  log("workspace url:", page.url());
  await page.screenshot({ path: path.join(SHOTS, "workspace.png") });
}

await loginIfNeeded();

// persist the live session for reuse
try {
  const ssSidecar = await page.evaluate(() => {
    const grab = (s) => Object.fromEntries(Object.entries({ ...s }).map(([k, v]) => [k, String(v)]));
    return { ls: grab(localStorage), ss: grab(sessionStorage) };
  });
  saveJSON("live-session-storage.json", ssSidecar);
  await ctx.storageState({ path: path.join(DATA, "live-session.json") });
  fs.writeFileSync("output/tradovate-cookies.json", JSON.stringify(await ctx.cookies(), null, 2));
  fs.writeFileSync("output/tradovate-storage.json", JSON.stringify(ssSidecar, null, 2));
  log("session exported");
} catch (e) { log("session export failed:", e.message); }

// dismiss onboarding popovers
async function clearOverlays() {
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator('button:has-text("Accept Cookies")').first().click({ timeout: 800 }).catch(() => {});
  // close risk-settings popover / other toasts: click any close X in popover containers
  await page.evaluate(() => {
    const popovers = [...document.querySelectorAll('[class*="popover"],[class*="toast"],[class*="notification"],[class*="banner"]')];
    for (const p of popovers) {
      const btn = [...p.querySelectorAll('button,[role=button],i,[class*="close"]')].find((b) => (b.className || "").toString().match(/close/i));
      if (btn) btn.click();
    }
  }).catch(() => {});
  await sleep(600);
}
await clearOverlays();

// ---------- design tokens + layout evidence ----------
const tokens = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const vars = {};
  const walk = (rules) => {
    for (const r of rules) {
      if (r.cssRules) { walk(r.cssRules); continue; }
      if (!r.selectorText) continue;
      if (/^\s*:root|^\s*html|^\s*body/.test(r.selectorText)) {
        for (const p of r.style) if (p.startsWith("--")) vars[p] = cs.getPropertyValue(p).trim();
      }
    }
  };
  for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch {} }
  const body = getComputedStyle(document.body);
  return {
    vars,
    body: { fontFamily: body.fontFamily, fontSize: body.fontSize, bg: body.backgroundColor, color: body.color },
    title: document.title,
  };
});
saveJSON("design-tokens.json", tokens);
log("css vars:", Object.keys(tokens.vars).length);

// ---------- module palette ----------
const MODULES = ["Market Analyzer", "Chart", "Stocks Hot List", "SuperDOM", "Orders", "Calendar", "Positions", "Order Ticket", "T&S", "Trade Performance", "Pulse", "Spread Matrix", "Options Chain", "Code Editor", "Log", "Reports", "Chat", "Accounts", "News", "Legacy Chart"];

async function openPalette() {
  // top-left plus icon
  const plus = page.locator('.icon-plus').first();
  if (await plus.count().catch(() => 0)) { await plus.click({ force: true }).catch(() => {}); }
  else { await page.mouse.click(28, 24); }
  await sleep(900);
  return (await page.locator('text=Drag & Drop to Place on Dashboard').count().catch(() => 0)) > 0;
}

async function resetWorkspace() {
  await openPalette();
  await sleep(300);
  const reset = page.locator('text=RESET DEFAULT WORKSPACE');
  if (await reset.count().catch(() => 0)) { await reset.first().click().catch(() => {}); await sleep(1500); }
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(1200);
}

// palette screenshot
if (await openPalette()) {
  await shot(page, "palette");
  saveJSON("palette.json", await page.evaluate(() => {
    const items = [...document.querySelectorAll("li")].map((li) => (li.innerText || "").trim()).filter(Boolean);
    return { items };
  }));
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(500);
}

// place each module on a fresh default workspace and capture it
const moduleEvidence = [];
for (const name of MODULES) {
  try {
    await resetWorkspace();
    const ok = await openPalette();
    if (!ok) { log("palette not open for", name); continue; }
    const tile = page.locator("li").filter({ hasText: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") }).first();
    if (!(await tile.count().catch(() => 0))) {
      const alt = page.getByText(name, { exact: true }).first();
      if (!(await alt.count().catch(() => 0))) { log("tile missing:", name); moduleEvidence.push({ name, placed: false }); continue; }
      await alt.dragTo(page.locator("body"), { targetPosition: { x: 800, y: 500 } }).catch(() => {});
    } else {
      const box = await tile.boundingBox();
      if (!box) { moduleEvidence.push({ name, placed: false }); continue; }
      // real mouse drag onto the dashboard centre
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(700, 420, { steps: 8 });
      await page.mouse.move(820, 480, { steps: 8 });
      await page.mouse.up();
      await sleep(1800);
    }
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(800);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await shot(page, "module-" + slug);
    const ev = await page.evaluate(() => ({
      title: document.title,
      text: (document.body.innerText || "").slice(0, 4000),
    }));
    // strip the tab-bar noise: keep only the area of the newly placed module if a header matches
    moduleEvidence.push({ name, placed: true, title: ev.title, text: ev.text, slug });
    log("captured module:", name);
  } catch (e) {
    log("module fail:", name, e.message.slice(0, 120));
    moduleEvidence.push({ name, placed: false, error: e.message.slice(0, 200) });
  }
}
saveJSON("modules.json", moduleEvidence);

// ---------- right rail panels ----------
await resetWorkspace();
const railInfo = await page.evaluate(() => {
  const links = [...document.querySelectorAll("a, li, [role=button]")].map((e) => {
    const r = e.getBoundingClientRect();
    return { cls: (e.className || "").toString().slice(0, 80), title: e.getAttribute("title") || "", aria: e.getAttribute("aria-label") || "", text: (e.innerText || "").trim().slice(0, 30), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter((e) => e.x > 1050 && e.w > 10 && e.w < 70 && e.h > 10 && e.h < 70);
  return links;
});
saveJSON("rail.json", railInfo);
const railButtons = await page.evaluate(() => {
  // right rail icons live around x 1070-1105
  const els = [...document.querySelectorAll("a, li, i[class*=icon], [role=button]")].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.x > 1055 && r.x < 1120 && r.width < 60 && r.height < 60 && r.width > 8 && r.height > 8 && r.y > 60;
  });
  return els.map((e, i) => ({ i, y: Math.round(e.getBoundingClientRect().y), cls: (e.className || "").toString().slice(0, 90), title: e.getAttribute("title") || "", text: (e.innerText || "").trim().slice(0, 20) }));
});
saveJSON("rail-buttons.json", railButtons);
// click each rail icon by coordinate
for (const b of railButtons) {
  try {
    await page.mouse.click(1088, b.y + 5);
    await sleep(1300);
    await shot(page, "rail-" + b.i + "-" + (b.title || b.text || "icon").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24));
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(300);
  } catch (e) { log("rail fail", b.i, e.message.slice(0, 80)); }
}

// ---------- top bar menus ----------
await resetWorkspace();
const topMenus = [];
async function menuShot(name, action) {
  try { await action(); await sleep(1200); await shot(page, "menu-" + name); topMenus.push({ name, ok: true }); await page.keyboard.press("Escape").catch(() => {}); await sleep(500); }
  catch (e) { topMenus.push({ name, ok: false, error: e.message.slice(0, 150) }); log("menu fail", name, e.message.slice(0, 80)); }
}
await menuShot("account-dropdown", async () => { await page.mouse.click(752, 42); });
await menuShot("equity-tooltip", async () => { await page.mouse.click(860, 36); });
await menuShot("margin-tooltip", async () => { await page.mouse.click(1250, 14); });
await menuShot("notifications", async () => { await page.mouse.click(206, 22); });
await menuShot("search", async () => { await page.mouse.click(241, 22); });
await menuShot("updown", async () => { await page.mouse.click(128, 22); });
await menuShot("clock", async () => { await page.mouse.click(318, 12); });
await menuShot("layout-settings", async () => { await page.mouse.click(1414, 22); });
saveJSON("top-menus.json", topMenus);

// tab context menu (right click on a tab)
await menuShot("tab-context", async () => { await page.mouse.click(80, 65, { button: "right" }); });

// save final full DOM + tokens for the clone build
saveJSON("final-body-text.json", { text: await page.evaluate(() => (document.body.innerText || "").slice(0, 12000)) });
fs.writeFileSync(path.join(DATA, "workspace-final.html"), await page.evaluate(() => document.documentElement.outerHTML));

log("DONE — capture complete");
await browser.close();
