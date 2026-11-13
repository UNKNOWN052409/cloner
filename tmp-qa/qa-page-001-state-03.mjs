// Per-page click-through QA driver v2 for page-001-state-03 (exp-mw60jhf5pwjh).
// One visible list, one index space — enumerated, guarded, clicked in the same order.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkA11y, checkKeyboardFocus } from '../src/reconstruction/verify-a11y.js';

const ROOT = 'D:/project 2/cloner';
const PAGE = path.join(ROOT, 'artifacts/exp-mw60jhf5pwjh-project/page-001-state-03.html');
const OUT = path.join(ROOT, 'artifacts/qa-clickthrough/exp-mw60jhf5pwjh/page-001-state-03');
mkdirSync(OUT, { recursive: true });

const DANGEROUS = /(buy|sell|flatten|reverse|order|submit|confirm|logout|log\s?out|sign\s?out|close|remove|delete|cancel|deposit|withdraw|transfer|place|send|exit|cxl\b)/i;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

await page.goto(pathToFileURL(PAGE).href);
await page.waitForTimeout(500);

// enumerate VISIBLE elements once — indices used for both report and click
const els = await page.evaluate(() => {
  const sel = 'a, button, [role="button"], input, select, textarea, [data-cloner-trigger]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    out.push({
      i: out.length, tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').split(/\s+/).slice(0, 2).join(' '),
      aria: el.getAttribute('aria-label') || '',
      text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 50),
      href: el.getAttribute('href') || '', role: el.getAttribute('role') || '',
    });
  }
  return out;
});
const todo = els.filter((e) => !DANGEROUS.test(e.aria) && !DANGEROUS.test(e.text));
const skipped = els.filter((e) => DANGEROUS.test(e.aria) || DANGEROUS.test(e.text));
console.log('ENUM total=' + els.length + ' todo=' + todo.length + ' skippedDANGEROUS=' + skipped.length);
els.forEach((e) => console.log('ELEM ' + e.i + ' <' + e.tag + '> cls="' + e.cls + '" aria="' + e.aria + '" text="' + e.text + '" href="' + e.href + '" role="' + e.role + '"'));

// element-at-index helper — same list the click uses
const loc = (idx) => page.evaluateHandle((i) => {
  const sel = 'a, button, [role="button"], input, select, textarea, [data-cloner-trigger]';
  return [...document.querySelectorAll(sel)].filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; })[i];
}, idx);

let n = 1; let clicked = 0;
for (const e of todo) {
  const tag = String(n).padStart(2, '0');
  await page.screenshot({ path: path.join(OUT, `${tag}-before.png`) });
  const sigB = await page.evaluate(() => document.body.innerHTML.length + '|' + document.querySelectorAll('.Mui-selected').length);
  const errB = consoleErrors.length;
  let action = 'n/a';
  try {
    const h = await loc(e.i);
    const el = h.asElement();
    if (!el) { console.log(`CL${n} MISSING idx=${e.i}`); }
    else if (['input', 'textarea'].includes(e.tag)) {
      await el.fill('QA-TEST-' + n); action = `fill "QA-TEST-${n}"`;
    } else if (e.tag === 'select') {
      const opts = await el.locator('option').allTextContents();
      await el.selectOption({ index: Math.min(1, opts.length - 1) }); action = `select of ${opts.length}`;
    } else {
      await el.click({ timeout: 3000 }); action = 'click';
    }
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${tag}-after.png`) });
    const sigA = await page.evaluate(() => document.body.innerHTML.length + '|' + document.querySelectorAll('.Mui-selected').length);
    const visibleNew = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((x) => {
      const s = getComputedStyle(x); return s.display !== 'none' && s.visibility !== 'hidden' && x.offsetParent !== null;
    }).length);
    console.log(`CL${n} [${action}] <${e.tag}> cls="${e.cls}" text="${e.text.slice(0, 30)}" → domChange=${sigB !== sigA} (${sigB} → ${sigA}) selCount=${sigA.split('|')[1]} visibleEls=${visibleNew} newErrs=${consoleErrors.length - errB}`);
    if (action !== 'n/a') clicked++;
  } catch (err) {
    console.log(`CL${n} ERROR ${String(err.message).slice(0, 100)}`);
    await page.screenshot({ path: path.join(OUT, `${tag}-after.png`) });
  }
  n++;
}
console.log('--- SKIPPED (DANGEROUS regex) ---');
skipped.forEach((e) => console.log(`SKIP e${e.i} <${e.tag}> cls="${e.cls}" aria="${e.aria}"`));

// a[href] audit — every visible anchor
console.log('--- HREF AUDIT ---');
const hrefSet = new Set(els.filter((e) => e.href).map((e) => e.href));
for (const h of hrefSet) console.log(`HREF "${h}" → ${h === '#' ? 'unexplored-marker (data-cloner-unexplored)' : h.startsWith('#') ? 'hash' : 'OTHER'}`);
const hrefReport = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => {
  const r = a.getBoundingClientRect(); if (!(r.width > 0)) return null;
  return { href: a.getAttribute('href'), unexplored: a.hasAttribute('data-cloner-unexplored'), text: (a.innerText || '').trim().slice(0, 30) };
}).filter(Boolean));
hrefReport.forEach((h) => console.log(`ANCHOR text="${h.text}" href="${h.href}" unexplored=${h.unexplored}`));

// a11y
const a11y = await checkA11y(page, { file: 'page-001-state-03.html' });
console.log('--- A11Y ---');
console.log('A11Y violations=' + a11y.violations.length);
a11y.violations.slice(0, 3).forEach((v, i) => console.log(`V${i + 1} [${v.severity}] ${v.rule} → ${v.offender}`));
const kb = await checkKeyboardFocus(page);
console.log('KBD focus=' + JSON.stringify(kb));

console.log('--- SUMMARY ---');
console.log('CLICKED=' + clicked + ' SKIPPED_DANGEROUS=' + skipped.length);
console.log('CONSOLE_ERRORS=' + consoleErrors.length);
consoleErrors.slice(0, 3).forEach((m, i) => console.log(`CE${i + 1}: ` + m.slice(0, 200)));
await browser.close();
