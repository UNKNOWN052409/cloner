// TASK 3 — Picker depth check: click .btn-wrap.add-module, inspect module picker overlay,
// count [data-cloner-inner] entries and test-click them.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const URL = 'http://localhost:4173/preview/tradovate-live/index.html';
const ROOT = 'D:/project 2/cloner/output/tradovate-live';

// runtime introspection (static)
const runtimeSrc = fs.readFileSync(path.join(ROOT, 'cloner-runtime.js'), 'utf8');
const w = {};
vm.runInContext(runtimeSrc, vm.createContext({
  window: w,
  document: { addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; } },
}));
const interactions = w.__CLONER_INTERACTIONS || [];
console.log('=== runtime entries ===');
interactions.forEach(d => {
  console.log(`id=${d.id} kind=${d.kind} text="${(d.text || '').slice(0, 60)}" htmlLen=${(d.html || '').length} innerCount=${(d.html.match(/data-cloner-inner/g) || []).length}`);
});
const t0rec = interactions.find(d => d.id === 't0');
const t0InnerAttrs = t0rec ? [...new Set((t0rec.html.match(/data-cloner-inner="[^"]+"/g) || []))] : [];
console.log('t0 html distinct inner attrs:', t0InnerAttrs.join(', '));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(800);

// locate .btn-wrap.add-module and its trigger
const targetInfo = await page.evaluate(() => {
  const el = document.querySelector('.btn-wrap.add-module');
  if (!el) return null;
  const trig = el.closest('[data-cloner-trigger]') || (el.matches('[data-cloner-trigger]') ? el : null);
  return {
    exists: true,
    trigger: trig ? trig.getAttribute('data-cloner-trigger') : null,
    html: el.outerHTML.slice(0, 200),
  };
});
console.log('\n=== .btn-wrap.add-module ===');
console.log(JSON.stringify(targetInfo, null, 2));

if (!targetInfo || !targetInfo.trigger) {
  console.log('FATAL: add-module button has no data-cloner-trigger');
  process.exit(1);
}

// click it
await page.evaluate((tid) => {
  const el = document.querySelector(`[data-cloner-trigger="${tid}"]`);
  el.scrollIntoView({ block: 'center' });
  el.click();
}, targetInfo.trigger);
await page.waitForTimeout(1000);

const overlayState = await page.evaluate(() => {
  const ov = document.querySelector('[data-cloner-overlay]');
  if (!ov) return { present: false };
  const r = ov.getBoundingClientRect();
  const inners = [...ov.querySelectorAll('[data-cloner-inner]')];
  return {
    present: true,
    rect: { w: Math.round(r.width), h: Math.round(r.height) },
    title: (ov.querySelector('h2')?.textContent || '').trim(),
    innerCount: inners.length,
    innerTexts: inners.map(n => (n.textContent || '').trim().replace(/\s+/g, ' ')),
    innerAttrs: [...new Set(inners.map(n => n.getAttribute('data-cloner-inner')))],
    distinctTestIds: [...new Set(inners.map(n => n.getAttribute('data-testid') || ''))],
  };
});
console.log('\n=== overlay state after clicking picker trigger ===');
console.log(JSON.stringify(overlayState, null, 2));

// test-click first inner entry to see if a module replays
let innerClickResult = null;
if (overlayState.present && overlayState.innerCount > 0) {
  innerClickResult = await page.evaluate(() => {
    const first = document.querySelector('[data-cloner-overlay] [data-cloner-inner]');
    if (!first) return { clicked: false };
    first.click();
    return { clicked: true, innerId: first.getAttribute('data-cloner-inner'), label: (first.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) };
  });
  await page.waitForTimeout(900);
  innerClickResult.moduleAfter = await page.evaluate(() => {
    const mods = [...document.querySelectorAll('[data-cloner-module]')];
    const vis = mods.filter(m => { const r = m.getBoundingClientRect(); return r.width > 100 && r.height > 60; });
    return { count: vis.length, text: vis.length ? (vis[0].textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) : '' };
  });
}
console.log('\n=== inner entry click test ===');
console.log(JSON.stringify(innerClickResult, null, 2));

await browser.close();
fs.writeFileSync('D:/project 2/cloner/scripts/audit-3-result.json', JSON.stringify({ targetInfo, overlayState, innerClickResult }, null, 2));
console.log('[saved] scripts/audit-3-result.json');
