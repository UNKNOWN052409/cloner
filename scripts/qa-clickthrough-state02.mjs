// Per-page click-through QA driver — page-001-state-02 of exp-mw60jhf5pwjh.
// Headless-only, file:// only, no network. DANGEROUS-pattern guard enforced.
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAGE = path.join(ROOT, "artifacts", "exp-mw60jhf5pwjh-project", "page-001-state-02.html");
const OUT = path.join(ROOT, "artifacts", "qa-clickthrough", "exp-mw60jhf5pwjh", "page-001-state-02");
const DANGEROUS = /(buy|sell|flatten|reverse|order|submit|confirm|logout|log\s?out|sign\s?out|close|remove|delete|cancel|deposit|withdraw|transfer|place|send|exit|cxl\b)/i;
fs.mkdirSync(OUT, { recursive: true });

const a11yMod = await import(pathToFileURL(path.join(ROOT, "src", "reconstruction", "verify-a11y.js")).href);

// unique CSS path builder (for locator re-resolution)
const cssPath = (el) => {
  const parts = [];
  while (el && el.nodeType === 1 && el.tagName !== "HTML") {
    let sel = el.tagName.toLowerCase();
    const p = el.parentElement;
    if (p) {
      const same = [...p.children].filter((c) => c.tagName === el.tagName);
      if (same.length > 1) sel += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    parts.unshift(sel);
    el = el.parentElement;
  }
  return parts.join(" > ");
};

const describe = (el) => {
  const label = el.getAttribute("aria-label") || el.getAttribute("title") || "";
  const txt = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 60);
  return [txt, label, el.id, el.className, el.getAttribute("value") || "", el.getAttribute("name") || "", el.getAttribute("href") || ""].join(" | ");
};

const visible = (page) => page.evaluate(() => ({
  htmlLen: document.body.innerHTML.length,
  textLen: (document.body.innerText || "").length,
  dialogs: [...document.querySelectorAll('[role="dialog"]')].filter((d) => d.offsetParent !== null || getComputedStyle(d).display !== "none").length,
  active: document.activeElement ? document.activeElement.tagName + "." + (document.activeElement.className || "").split(" ")[0] : "none",
}));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
const consoleWarnings = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  if (m.type() === "warning") consoleWarnings.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 200)));

await page.goto(pathToFileURL(PAGE).href, { waitUntil: "load" });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, "00-initial.png") });

const linkAudit = await page.evaluate(() => {
  return [...document.querySelectorAll("a[href]")].map((a) => {
    const href = a.getAttribute("href") || "";
    return {
      href,
      cls: (a.className || "").split(" ").slice(0, 2).join("."),
      text: (a.innerText || "").trim().slice(0, 40),
      unexplored: a.hasAttribute("data-cloner-unexplored"),
    };
  });
});

const els = await page.evaluate(() => {
  const set = [...document.querySelectorAll('a, button, [role="button"], input, select, textarea, [data-cloner-trigger]')];
  const seen = new Set();
  return set.filter((el) => {
    if (seen.has(el)) return false;
    seen.add(el);
    return true;
  }).map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: (el.className || "").split(" ").slice(0, 2).join("."),
    desc: null, // filled below
    path: null,
    type: el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? (el.type || "text") : null,
  }));
});
// describe + cssPath need DOM traversal — do it in one evaluate
const full = await page.evaluate(() => {
  const set = [...document.querySelectorAll('a, button, [role="button"], input, select, textarea, [data-cloner-trigger]')];
  const seen = new Set(); const out = [];
  const cssPath = (el) => {
    const parts = [];
    while (el && el.nodeType === 1 && el.tagName !== "HTML") {
      let sel = el.tagName.toLowerCase();
      const p = el.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === el.tagName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(sel);
      el = el.parentElement;
    }
    return parts.join(" > ");
  };
  for (const el of set) {
    if (seen.has(el)) continue;
    seen.add(el);
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === "string" ? el.className : "").split(" ").slice(0, 2).join("."),
      txt: (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 60),
      label: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      id: el.id || "",
      value: el.getAttribute("value") || "",
      href: el.getAttribute("href") || "",
      path: cssPath(el),
      role: el.getAttribute("role") || "",
    });
  }
  return out;
});

const results = [];
let fillN = 0;
for (let i = 0; i < full.length; i++) {
  const e = full[i];
  const probe = [e.txt, e.label, e.title, e.id, e.cls, e.value, e.href].join(" | ");
  const idx = String(i + 1).padStart(2, "0");
  if (DANGEROUS.test(probe)) {
    results.push({ n: idx, tag: e.tag, cls: e.cls, action: "SKIPPED-DANGEROUS", match: (probe.match(DANGEROUS) || [""])[0] });
    continue;
  }
  const loc = page.locator(e.path).first();
  // a user can scroll to below-the-fold elements — bring into view before judging
  await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  // classify actionability first: hidden elements cannot be clicked honestly
  const vis = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const inLayout = !(r.width === 0 && r.height === 0) && cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.01;
    // is the element's center actually hit-targetable (not covered by another element)?
    let covered = null;
    if (inLayout) {
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      covered = top ? (el === top || el.contains(top) || top.contains(el) ? false : top.tagName + "." + String(top.className).split(" ")[0]) : "off-viewport";
    }
    return { inLayout, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, covered };
  }).catch(() => ({ inLayout: false, rect: null, covered: "gone" }));
  const before = await visible(page);
  await page.screenshot({ path: path.join(OUT, `${idx}-before.png`) });
  let act = "click", note = "";
  if (!vis.inLayout) {
    await page.screenshot({ path: path.join(OUT, `${idx}-after.png`) });
    results.push({ n: idx, tag: e.tag, cls: e.cls, txt: e.txt || e.label || e.title, action: "not-actionable", note: `hidden/not in layout (rect=${JSON.stringify(vis.rect)})`, domChange: "n/a", consoleErrsDuring: consoleErrors.length });
    continue;
  }
  if (vis.covered) {
    await page.screenshot({ path: path.join(OUT, `${idx}-after.png`) });
    results.push({ n: idx, tag: e.tag, cls: e.cls, txt: e.txt || e.label || e.title, action: "not-actionable", note: `visible but covered by ${vis.covered}`, domChange: "n/a", consoleErrsDuring: consoleErrors.length });
    continue;
  }
  try {
    if (e.tag === "input" || e.tag === "textarea") {
      await loc.fill(`QA-TEST-${++fillN}`, { timeout: 3000 });
      act = "fill";
      note = `filled QA-TEST-${fillN}`;
    } else if (e.tag === "select") {
      const opts = await loc.locator("option").allTextContents();
      if (opts.length === 0) { act = "noop"; note = "select has no options"; }
      else { await loc.selectOption({ index: opts.length > 1 ? 1 : 0 }); act = "select"; note = `selected option idx${opts.length > 1 ? 1 : 0}: "${opts[opts.length > 1 ? 1 : 0].trim()}" of ${opts.length}`; }
    } else {
      await loc.click({ timeout: 3000 });
    }
    await page.waitForTimeout(800);
    const after = await visible(page);
    await page.screenshot({ path: path.join(OUT, `${idx}-after.png`) });
    const diff = [];
    if (after.htmlLen !== before.htmlLen) diff.push(`htmlLen ${before.htmlLen}->${after.htmlLen}`);
    if (after.textLen !== before.textLen) diff.push(`textLen ${before.textLen}->${after.textLen}`);
    if (after.dialogs !== before.dialogs) diff.push(`visibleDialogs ${before.dialogs}->${after.dialogs}`);
    if (after.active !== before.active) diff.push(`focus ${before.active}->${after.active}`);
    const url = page.url();
    if (!url.startsWith("file:")) { consoleErrors.push("NAVIGATION OUT OF SCOPE: " + url); await page.goto(pathToFileURL(PAGE).href); }
    else if (url !== pathToFileURL(PAGE).href) diff.push(`urlChanged ${url}`);
    results.push({ n: idx, tag: e.tag, cls: e.cls, txt: e.txt || e.label || e.title, action: act, note, domChange: diff.join("; ") || "none", consoleErrsDuring: consoleErrors.length });
  } catch (err) {
    results.push({ n: idx, tag: e.tag, cls: e.cls, txt: e.txt || e.label, action: act, error: String(err).slice(0, 140) });
    await page.screenshot({ path: path.join(OUT, `${idx}-after.png`) });
  }
  if (e.tag === "a" && e.href === "#") { /* stays on page; next iteration unaffected */ }
  // reset any select change so later states are comparable
  if (act === "select") { try { await page.reload({ waitUntil: "load" }); await page.waitForTimeout(400); } catch {} }
}

const a11y = await a11yMod.checkA11y(page);
const a11ySummary = {
  count: a11y.violations.length,
  top3: a11y.violations.slice(0, 3).map((v) => ({ severity: v.severity, rule: v.rule, offender: String(v.offender).slice(0, 90), fix: String(v.fix || "").slice(0, 60) })),
};

// link classification
const projectFiles = new Set(fs.readdirSync(path.join(ROOT, "artifacts", "exp-mw60jhf5pwjh-project")));
const linkClass = linkAudit.map((l) => {
  if (l.href === "#") return { ...l, verdict: l.unexplored ? "ok: hash + data-cloner-unexplored" : "ok: hash-only (no navigation)" };
  if (/^https?:/i.test(l.href)) return { ...l, verdict: "EXTERNAL-HREF (not navigated)" };
  const target = path.join(ROOT, "artifacts", "exp-mw60jhf5pwjh-project", l.href.split("?")[0]);
  return { ...l, verdict: projectFiles.has(l.href.split("?")[0]) || fs.existsSync(target) ? "ok: local file" : "BROKEN: does not resolve" };
});

const out = { viewport: "1440x900", headless: true, pageFile: "artifacts/exp-mw60jhf5pwjh-project/page-001-state-02.html", title: await page.title(), elementsTotal: full.length, results, linkAudit: linkClass, a11y: a11ySummary, console: { errors: consoleErrors.length, first3: consoleErrors.slice(0, 3), warnings: consoleWarnings.length, firstWarn: consoleWarnings.slice(0, 2) } };
fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
