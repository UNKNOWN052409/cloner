// Per-page click-through QA for clone job exp-mw60jhf5pwjh, page page-001 (index.html).
// Original: https://trader.tradovate.com/#accounts. HEADLESS ONLY, file:// only.
// Protocol: enumerate a,button,[role=button],input,select,textarea,[data-cloner-trigger];
// for each safe element (engine DANGEROUS regex guard): BEFORE shot → click/fill → 800ms → AFTER shot;
// classify every a[href]; checkA11y (src/reconstruction/verify-a11y.js); capture console.
// Never submits, never external. Elements resolved by unique CSS path so runtime-replayed
// modules appended to <body> cannot shift which element gets clicked.
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkA11y } from "../src/reconstruction/verify-a11y.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_DIR = resolve(REPO, "artifacts/exp-mw60jhf5pwjh-project");
const PAGE_FILE = resolve(PAGE_DIR, "index.html");
const OUT = resolve(REPO, "artifacts/qa-clickthrough/exp-mw60jhf5pwjh/page-001");
const VIEW = { width: 1440, height: 900 };
// the engine's own destructive guard — never click/fill anything matching
const DANGEROUS = /(buy|sell|flatten|reverse|order|submit|confirm|logout|log\s?out|sign\s?out|close|remove|delete|cancel|deposit|withdraw|transfer|place|send|exit|cxl\b)/i;
const WAIT_MS = 800;

mkdirSync(OUT, { recursive: true });

const consoleMsgs = [];
const results = { page: "page-001", originalUrl: "https://trader.tradovate.com/#accounts", file: PAGE_FILE, url: pathToFileURL(PAGE_FILE).href, viewport: "1440x900", elements: [], hrefCheck: [], a11y: null, console: consoleMsgs, notes: [] };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: VIEW });
page.on("console", (m) => consoleMsgs.push({ type: m.type(), text: String(m.text()).slice(0, 300) }));
page.on("pageerror", (e) => consoleMsgs.push({ type: "pageerror", text: String(e?.message || e).slice(0, 300) }));
page.on("requestfailed", (r) => consoleMsgs.push({ type: "requestfailed", text: `${r.url().slice(0, 120)} ${r.failure()?.errorText}` }));

await page.goto(pathToFileURL(PAGE_FILE).href, { waitUntil: "load", timeout: 15000 });
await page.waitForTimeout(500);

// unique CSS path per element — stable re-resolution even after runtime replay inserts nodes
const cssPathOf = (el) => {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node.tagName !== "HTML") {
    let sel = node.tagName.toLowerCase();
    const p = node.parentElement;
    if (p) {
      const same = [...p.children].filter((c) => c.tagName === node.tagName);
      if (same.length > 1) sel += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(sel);
    node = node.parentElement;
  }
  return parts.join(" > ");
};

// enumerate the full protocol selector, in DOM order, with identifying strings
const handles = await page.$$eval("a, button, [role=button], input, select, textarea, [data-cloner-trigger]", (els) =>
  els.map((el, i) => {
    const r = el.getBoundingClientRect();
    // unique CSS path — stable re-resolution even after runtime replay inserts nodes
    const path = (() => {
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && node.tagName !== "HTML") {
        let sel = node.tagName.toLowerCase();
        const p = node.parentElement;
        if (p) {
          const same = [...p.children].filter((c) => c.tagName === node.tagName);
          if (same.length > 1) sel += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
        parts.unshift(sel);
        node = node.parentElement;
      }
      return parts.join(" > ");
    })();
    return {
      i, path, tag: el.tagName.toLowerCase(), cls: el.getAttribute("class") || "", id: el.id || "",
      text: el.textContent || "", ariaLabel: el.getAttribute("aria-label") || "", title: el.getAttribute("title") || "",
      href: el.getAttribute("href"), role: el.getAttribute("role"), type: el.getAttribute("type") || "",
      placeholder: el.getAttribute("placeholder") || "", name: el.getAttribute("name") || "", value: el.value || "",
      unexplored: el.hasAttribute("data-cloner-unexplored"),
      visible: !!(r.width || r.height) && getComputedStyle(el).visibility !== "hidden",
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
    };
  })
);

console.log(`enumerated ${handles.length} interactive elements`);

let qaN = 0;
for (const h of handles) {
  const idTag = String(h.i + 1).padStart(2, "0");
  const ident = [h.text, h.ariaLabel, h.title, h.id, h.cls, h.href, h.type, h.placeholder, h.name, h.value].filter(Boolean).join(" ");
  const rec = { i: h.i, tag: h.tag, cls: (h.cls || "").slice(0, 60), id: h.id || null, path: h.path,
    text: (h.text || "").replace(/\s+/g, " ").trim().slice(0, 60) || null, ariaLabel: h.ariaLabel || null,
    href: h.href || null, role: h.role || null, visible: !!h.visible, disabled: !!h.disabled,
    action: null, outcome: null, domChange: null, consoleErrorsDuring: 0, shots: [] };
  results.elements.push(rec);

  if (DANGEROUS.test(ident)) {
    rec.action = "skipped-dangerous";
    rec.outcome = `DANGEROUS regex matched identifying strings — not clicked/filled (guard: ${ident.match(DANGEROUS)?.[0]})`;
    console.log(`[${idTag}] SKIP-DANGEROUS ${h.tag}.${(h.cls || "").split(" ")[0]} :: ${rec.outcome}`);
    continue;
  }
  if (h.disabled) {
    rec.action = "skipped-disabled";
    rec.outcome = "element disabled — not interacted";
    console.log(`[${idTag}] SKIP-DISABLED ${h.tag}.${(h.cls || "").split(" ")[0]}`);
    continue;
  }

  const loc = page.locator(h.path).first();
  const before = await page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const els = [...document.querySelectorAll("body *")];
    return {
      bits: els.map(vis), total: els.length, textLen: document.body.innerText.length,
      hash: location.hash, scrollY: Math.round(window.scrollY),
      dialogs: [...document.querySelectorAll('[role=dialog], dialog')].filter(vis).length,
      tabs: [...document.querySelectorAll('[role=tab]')].map((t) => (t.getAttribute("aria-selected") === "true" ? 1 : 0)).join(""),
      active: document.activeElement ? document.activeElement.tagName.toLowerCase() : null,
      replayModules: document.querySelectorAll("[data-cloner-module]").length,
    };
  });

  try { await loc.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch { /* off-viewport stays off */ }
  await page.screenshot({ path: resolve(OUT, `${idTag}-before.png`) });
  rec.shots.push(`${idTag}-before.png`);

  const isField = ["input", "textarea"].includes(h.tag);
  try {
    if (isField) {
      qaN += 1;
      await loc.fill(`QA-TEST-${qaN}`, { timeout: 2500 });
      rec.action = `fill(QA-TEST-${qaN})`;
    } else if (h.tag === "select") {
      qaN += 1;
      const opts = await loc.locator("option").allTextContents();
      await loc.selectOption({ index: Math.min(1, Math.max(0, opts.length - 1)) }, { timeout: 2500 });
      rec.action = `selectOption(index1 of ${opts.length})`;
    } else {
      await loc.click({ timeout: 2500 });
      rec.action = "click";
    }
  } catch (e) {
    rec.action = rec.action || "click";
    // fallback: if the pointer click is impossible (e.g. element off-viewport —
    // position:fixed content cannot be scrolled to), dispatch the click at the
    // DOM level and LABEL it as a JS fallback. Handler wiring is still exercised;
    // the geometry failure itself is recorded in outcome.
    try {
      await loc.evaluate((el) => el.click(), { timeout: 2500 });
      rec.action = "js-click (fallback: pointer click impossible)";
      rec.outcome = `pointer click failed: ${String(e?.message || e).split("\n")[0].slice(0, 160)} — fell back to DOM-level el.click()`;
    } catch (e2) {
      rec.outcome = `interaction failed: ${String(e?.message || e).split("\n")[0].slice(0, 160)}; JS fallback also failed: ${String(e2?.message || e2).split("\n")[0].slice(0, 120)}`;
    }
  }

  await page.waitForTimeout(WAIT_MS);
  await page.screenshot({ path: resolve(OUT, `${idTag}-after.png`) });
  rec.shots.push(`${idTag}-after.png`);

  const after = await page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const els = [...document.querySelectorAll("body *")];
    return {
      bits: els.map(vis), total: els.length, textLen: document.body.innerText.length,
      hash: location.hash, scrollY: Math.round(window.scrollY),
      dialogs: [...document.querySelectorAll('[role=dialog], dialog')].filter(vis).length,
      tabs: [...document.querySelectorAll('[role=tab]')].map((t) => (t.getAttribute("aria-selected") === "true" ? 1 : 0)).join(""),
      active: document.activeElement ? document.activeElement.tagName.toLowerCase() : null,
      replayModules: document.querySelectorAll("[data-cloner-module]").length,
    };
  });

  if (rec.action === "click" && rec.outcome && /failed/.test(rec.outcome)) {
    rec.domChange = "n/a (interaction failed)";
  } else if (/JS fallback also failed/.test(rec.outcome || "")) {
    rec.domChange = "n/a (interaction failed)";
  } else {
    const n = Math.min(before.bits.length, after.bits.length);
    let toggled = 0; for (let k = 0; k < n; k++) if (before.bits[k] !== after.bits[k]) toggled++;
    const parts = [];
    if (toggled) parts.push(`${toggled} element(s) toggled visibility`);
    if (before.replayModules !== after.replayModules) parts.push(`replayed modules ${before.replayModules}→${after.replayModules}`);
    if (before.textLen !== after.textLen) parts.push(`innerText ${before.textLen}→${after.textLen}`);
    if (before.dialogs !== after.dialogs) parts.push(`visible dialogs ${before.dialogs}→${after.dialogs}`);
    if (before.tabs !== after.tabs) parts.push(`aria-selected pattern ${before.tabs}→${after.tabs}`);
    if (before.hash !== after.hash) parts.push(`hash "${before.hash}"→"${after.hash}"`);
    if (before.active !== after.active) parts.push(`focus ${before.active}→${after.active}`);
    rec.domChange = parts.length ? parts.join("; ") : "no DOM change observed";
  }
  rec.consoleErrorsDuring = consoleMsgs.filter((m) => m.type === "error" || m.type === "pageerror").length;
  console.log(`[${idTag}] ${rec.action} ${h.tag}.${(h.cls || "").split(" ")[0]} → ${rec.domChange}${rec.outcome ? " | " + rec.outcome : ""}`);
}

// every a[href]: local-file-resolves / #-unexplored / external — anything else broken
results.hrefCheck = await page.$$eval("a[href]", (els) =>
  els.map((el) => ({ href: el.getAttribute("href"), cls: (el.getAttribute("class") || "").slice(0, 40), unexplored: el.hasAttribute("data-cloner-unexplored") }))
);
for (const h of results.hrefCheck) {
  if (/^https?:\/\//i.test(h.href)) h.classification = "external";
  else if (h.href.startsWith("#")) h.classification = h.unexplored ? "#+data-cloner-unexplored (OK: unexplored stub)" : "BROKEN: bare # anchor without data-cloner-unexplored";
  else {
    const target = resolve(PAGE_DIR, h.href.split("?")[0].split("#")[0]);
    h.classification = existsSync(target) ? "local file resolves" : `BROKEN: local target missing (${target})`;
  }
}

// a11y via the repo's own checker, page-loaded context
results.a11y = await checkA11y(page, { file: "index.html" });

await page.screenshot({ path: resolve(OUT, "00-initial.png"), fullPage: true });
await browser.close();

const errs = consoleMsgs.filter((m) => m.type === "error" || m.type === "pageerror");
results.consoleSummary = { total: consoleMsgs.length, errors: errs.length, first3: errs.slice(0, 3).map((m) => m.text) };
const clicked = results.elements.filter((r) => r.action === "click").length;
const filled = results.elements.filter((r) => /^fill\(/.test(r.action || "")).length;
const skippedDanger = results.elements.filter((r) => r.action === "skipped-dangerous").length;
const failedInteractions = results.elements.filter((r) => /failed/.test(r.outcome || "")).length;
console.log("\n=== SUMMARY ===");
console.log(`elements=${results.elements.length} clicked=${clicked} filled=${filled} skippedDangerous=${skippedDanger} failedInteractions=${failedInteractions}`);
const cls = {};
results.hrefCheck.forEach((h) => { const c = h.classification; cls[c] = (cls[c] || 0) + 1; });
console.log(`hrefCheck=${results.hrefCheck.length}: ${JSON.stringify(cls)}`);
console.log(`a11y violations=${results.a11y.violations.length} top3=${JSON.stringify(results.a11y.violations.slice(0, 3).map((v) => `${v.severity}/${v.rule}/${v.offender}`))}`);
console.log(`console total=${consoleMsgs.length} errors=${errs.length} first3=${JSON.stringify(results.consoleSummary.first3)}`);

writeFileSync(resolve(OUT, "result.json"), JSON.stringify(results, null, 2));
console.log(`wrote ${resolve(OUT, "result.json")}`);
