// Exhaustive click-through QA: every module's controls, menus, selects, multi-chart,
// and dark-on-dark visibility checks. Saves screenshots + a findings report.
import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "artifacts/tradovate-live-capture/qa-full";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: false, channel: "chrome" });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 180)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 180)); });

const findings = [];
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });

await page.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".tv-app");
await page.waitForTimeout(1000);

const MODULES = ["Market Analyzer", "Chart", "Stocks Hot List", "SuperDOM", "Orders", "Calendar", "Positions", "Order Ticket", "T&S", "Trade Performance", "Pulse", "Spread Matrix", "Options Chain", "Code Editor", "Log", "Reports", "Chat", "Accounts", "News", "Legacy Chart"];

async function addModule(nameOrIndex) {
  if ((await page.locator(".tv-palette").count()) === 0) { await page.click(".tv-plus"); await page.waitForTimeout(250); }
  const idx = typeof nameOrIndex === "number" ? nameOrIndex : (await page.locator(".tv-palette-tile .tv-palette-label").allInnerTexts()).findIndex((t) => t.replace(/\s*New\s*$/, "").trim() === nameOrIndex);
  if (idx < 0) { await page.keyboard.press("Escape"); return false; }
  await page.locator(".tv-palette-tile").nth(idx).click();
  await page.waitForTimeout(650);
  return true;
}

// contrast helper (only visible popups/containers)
const contrastScan = () => page.evaluate(() => {
  const lum = (c) => { const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/); if (!m) return null; const [r, g, b] = [m[1], m[2], m[3]].map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { let e = el; while (e) { const bg = getComputedStyle(e).backgroundColor; if (bg && !/rgba?\(0,\s*0,\s*0,\s*0\)/.test(bg)) return bg; e = e.parentElement; } return getComputedStyle(document.body).backgroundColor; };
  const bad = [];
  const scope = document.querySelectorAll(".tv-menu, .ma-menu-layer, .tv-palette, .tv-modal, [class*=dropdown], [class*=menu], [role=menu]");
  for (const root of scope) {
    if (root.offsetParent === null) continue;
    for (const el of root.querySelectorAll("*")) {
      if (!el.children.length === false && el.children.length > 0) { /* keep leaf+ */ }
      if (el.children.length > 0) continue;
      const text = (el.innerText || "").trim();
      if (!text) continue;
      const cs = getComputedStyle(el);
      const fg = lum(cs.color), bg = lum(bgOf(el));
      if (fg == null || bg == null) continue;
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      if (ratio < 2.2) bad.push({ text: text.slice(0, 34), cls: (el.className || "").toString().slice(0, 40), fg: cs.color, bg: bgOf(el), ratio: +ratio.toFixed(2) });
    }
  }
  return bad.slice(0, 20);
});

// click every control in the active module, screenshot menus, detect no-effect clicks
async function exerciseModule(name, idx) {
  const mod = page.locator('[data-qa-target="1"]');
  const beforeErrs = errors.length;
  const controls = await mod.locator("button, [role=button], select, .tv-seg button").count();
  const noEffect = [];
  for (let i = 0; i < Math.min(controls, 40); i++) {
    const el = mod.locator("button, [role=button], select, .tv-seg button").nth(i);
    if (!(await el.count())) continue;
    const info = await el.evaluate((e) => ({ tag: e.tagName, cls: (e.className || "").toString().slice(0, 40), text: (e.innerText || e.value || "").trim().slice(0, 24), title: e.getAttribute("title") || "" })).catch(() => null);
    if (!info) continue;
    const before = await page.evaluate(() => document.body.innerText.length);
    await el.click({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(180);
    const popup = await page.locator(".tv-menu, .tv-modal, .tv-palette").count();
    const after = await page.evaluate(() => document.body.innerText.length);
    if (popup === 0 && before === after) noEffect.push(info);
    if (popup > 0) { await shot(`mod-${idx}-popup-${i}`); const bad = await contrastScan(); if (bad.length) findings.push({ module: name, kind: "low-contrast-popup", control: info, bad }); }
    if (await page.locator(".tv-palette").count()) await page.keyboard.press("Escape");
    if (await page.locator(".tv-modal").count()) await page.keyboard.press("Escape");
    await page.waitForTimeout(90);
  }
  // close any open menu
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  return { module: name, controls, noEffect: noEffect.slice(0, 8), errors: errors.slice(beforeErrs) };
}

for (let m = 0; m < MODULES.length; m++) {
  const name = MODULES[m];
  await page.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tv-app");
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelectorAll(".tv-module").forEach((el) => el.setAttribute("data-qa-old", "1")));
  const ok = await addModule(m);
  if (!ok) { findings.push({ module: name, error: "could not add module from palette" }); continue; }
  const target = await page.evaluate(() => {
    const els = [...document.querySelectorAll(".tv-module")].filter((el) => !el.hasAttribute("data-qa-old"));
    const el = els[els.length - 1];
    if (!el) return false;
    el.setAttribute("data-qa-target", "1");
    document.querySelectorAll(".tv-module").forEach((e) => e.removeAttribute("data-qa-old"));
    return true;
  });
  let usedFallback = false;
  if (!target) {
    // module deduped into an existing group (e.g. Accounts) — target that group instead
    const fallback = await page.evaluate((name) => {
      const mods = [...document.querySelectorAll(".tv-module")];
      const el = mods.find((m) => [...m.querySelectorAll(".tv-module-tab")].some((t) => t.innerText.replace(/[?+]/g, "").trim() === name));
      if (!el) return false;
      el.setAttribute("data-qa-target", "1");
      return true;
    }, name);
    if (!fallback) { findings.push({ module: name, error: "module element not found after add" }); continue; }
    usedFallback = true;
  }
  await shot(`mod-${String(m).padStart(2, "0")}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  const res = await exerciseModule(name, 0);
  res.index = m;
  findings.push(res);
}

// native select popup visual test
await page.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".tv-app"); await page.waitForTimeout(900);
await page.locator("select").first().click().catch(() => {});
await page.waitForTimeout(500);
await shot("90-native-select-open");
await page.keyboard.press("Escape");

// multi-chart stress: 3 chart panes with different symbols
for (const _ of [0, 1, 2]) { await addModule(1); }
const charts = await page.evaluate(() => [...document.querySelectorAll(".mod-chart")].length);
const canvases = await page.locator("canvas").count();
// assign distinct symbols to each chart pane
const pickers = page.locator(".tv-symbol-picker-btn");
const pickCount = await pickers.count();
const syms = ["ESZ6", "GCX6", "6EZ6"];
for (let i = 0; i < Math.min(3, pickCount); i++) {
  await pickers.nth(i).click().catch(() => {});
  await page.waitForTimeout(250);
  await page.keyboard.type(syms[i], { delay: 25 });
  await page.waitForTimeout(250);
  await page.locator(".tv-symbol-picker-row").first().click().catch(() => {});
  await page.waitForTimeout(400);
}
await page.waitForTimeout(800);
await shot("91-multi-chart-3");
const multi = await page.evaluate(() => [...document.querySelectorAll(".mod-chart")].map((m) => ({
  symbol: m.querySelector(".tv-symbol-picker-sym")?.innerText || "?",
  canvas: m.querySelectorAll("canvas").length,
})));
findings.push({ kind: "multi-chart", chartPanes: charts, canvases, multi });

fs.writeFileSync(`${OUT}/qa-findings.json`, JSON.stringify({ findings, errors: [...new Set(errors)] }, null, 2));
const noEffectModules = findings.filter((f) => f.module && f.noEffect && f.noEffect.length);
console.log("MODULES:", MODULES.length, "| errors:", [...new Set(errors)].length);
console.log("no-effect clicks:", JSON.stringify(noEffectModules.map((f) => ({ module: f.module, controls: f.controls, noEffect: f.noEffect })), null, 1).slice(0, 4000));
console.log("multi-chart:", JSON.stringify(multi));
console.log("errors:", [...new Set(errors)].slice(0, 10));
await browser.close();
