// Per-page click-through QA for clone job exp-mw60jhf5pwjh, page page-001-state-01.
// Original: https://trader.tradovate.com/#subscriptions. HEADLESS ONLY, file:// only.
// Protocol: enumerate a,button,[role=button],input,select,textarea,[data-cloner-trigger];
// for each safe element (engine DANGEROUS regex guard): BEFORE shot → click/fill → 800ms → AFTER shot;
// classify every a[href]; checkA11y; capture console. Never submits, never external.
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkA11y } from "../src/reconstruction/verify-a11y.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_DIR = resolve(REPO, "artifacts/exp-mw60jhf5pwjh-project");
const PAGE_FILE = resolve(PAGE_DIR, "page-001-state-01.html");
const OUT = resolve(REPO, "artifacts/qa-clickthrough/exp-mw60jhf5pwjh/page-001-state-01");
const VIEW = { width: 1440, height: 900 };
// the engine's own destructive guard — never click/fill anything matching
const DANGEROUS = /(buy|sell|flatten|reverse|order|submit|confirm|logout|log\s?out|sign\s?out|close|remove|delete|cancel|deposit|withdraw|transfer|place|send|exit|cxl\b)/i;
const WAIT_MS = 800;

mkdirSync(OUT, { recursive: true });

const consoleMsgs = [];
const results = { page: "page-001-state-01", originalUrl: "https://trader.tradovate.com/#subscriptions", file: PAGE_FILE, url: pathToFileURL(PAGE_FILE).href, viewport: "1440x900", elements: [], hrefCheck: [], a11y: null, console: consoleMsgs, notes: [] };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: VIEW });
page.on("console", (m) => consoleMsgs.push({ type: m.type(), text: String(m.text()).slice(0, 300) }));
page.on("pageerror", (e) => consoleMsgs.push({ type: "pageerror", text: String(e?.message || e).slice(0, 300) }));
page.on("requestfailed", (r) => consoleMsgs.push({ type: "requestfailed", text: `${r.url().slice(0, 120)} ${r.failure()?.errorText}` }));

await page.goto(pathToFileURL(PAGE_FILE).href, { waitUntil: "load", timeout: 15000 });
await page.waitForTimeout(500);

const describe = (h) => ({
  i: h.i, tag: h.tag, cls: (h.cls || "").slice(0, 60), id: h.id || null,
  text: (h.text || "").replace(/\s+/g, " ").trim().slice(0, 60) || null,
  ariaLabel: h.ariaLabel || null, href: h.href || null, role: h.role || null,
  visible: !!h.visible, disabled: !!h.disabled,
});

// enumerate the full protocol selector, in DOM order, with identifying strings
const handles = await page.$$eval("a, button, [role=button], input, select, textarea, [data-cloner-trigger]", (els) =>
  els.map((el, i) => {
    const r = el.getBoundingClientRect();
    return {
      i, tag: el.tagName.toLowerCase(), cls: el.getAttribute("class") || "", id: el.id || "",
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
  const rec = { ...describe(h), action: null, outcome: null, domChange: null, consoleErrorsDuring: 0, shots: [] };
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

  const loc = page.locator(`a, button, [role=button], input, select, textarea, [data-cloner-trigger]`).nth(h.i);
  const before = await page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const els = [...document.querySelectorAll("body *")];
    return {
      bits: els.map(vis), total: els.length, textLen: document.body.innerText.length,
      hash: location.hash, scrollY: Math.round(window.scrollY),
      dialogs: [...document.querySelectorAll('[role=dialog], dialog')].filter(vis).length,
      tabs: [...document.querySelectorAll('[role=tab]')].map((t) => (t.getAttribute("aria-selected") === "true" ? 1 : 0)).join(""),
      active: document.activeElement ? document.activeElement.tagName.toLowerCase() : null,
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
    rec.outcome = `interaction failed: ${String(e?.message || e).split("\n")[0].slice(0, 160)}`;
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
    };
  });

  if (rec.outcome && /failed/.test(rec.outcome)) {
    rec.domChange = "n/a (interaction failed)";
  } else {
    const n = Math.min(before.bits.length, after.bits.length);
    let toggled = 0; for (let k = 0; k < n; k++) if (before.bits[k] !== after.bits[k]) toggled++;
    const parts = [];
    if (toggled) parts.push(`${toggled} element(s) toggled visibility`);
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
results.a11y = await checkA11y(page, { file: "page-001-state-01.html" });

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
console.log(`hrefCheck=${results.hrefCheck.length}: ${JSON.stringify(results.hrefCheck.map((h) => h.classification))}`);
console.log(`a11y violations=${results.a11y.violations.length} top3=${JSON.stringify(results.a11y.violations.slice(0, 3).map((v) => `${v.severity}/${v.rule}/${v.offender}`))}`);
console.log(`console total=${consoleMsgs.length} errors=${errs.length} first3=${JSON.stringify(results.consoleSummary.first3)}`);

writeFileSync(resolve(OUT, "result.json"), JSON.stringify(results, null, 2));
console.log(`wrote ${resolve(OUT, "result.json")}`);
