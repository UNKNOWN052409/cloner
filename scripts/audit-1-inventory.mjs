// TASK 1 — Missed-trigger inventory
// Parse output/tradovate-live/index.html, inventory interactive elements lacking data-cloner-trigger.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/project 2/cloner/output/tradovate-live';
const fileUrl = 'file:///' + path.resolve(ROOT, 'index.html').replace(/\\/g, '/');

// ---- Parse runtime interactions (stub document/window) ----
const runtimeSrc = fs.readFileSync(path.join(ROOT, 'cloner-runtime.js'), 'utf8');
const windowStub = {};
let interactions = [];
try {
  const vm = await import('node:vm');
  const sandbox = {
    window: windowStub,
    document: { addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(runtimeSrc, sandbox);
  interactions = windowStub.__CLONER_INTERACTIONS || [];
} catch (e) {
  console.error('runtime eval failed:', e.message);
}
const runtimeIds = new Set(interactions.map(i => i.id));
console.log(`[runtime] interactions defined: ${interactions.length}; ids: ${interactions.map(i => i.id).join(', ')}`);

// ---- Parse index.html DOM via headless chromium ----
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(fileUrl, { waitUntil: 'load' });

const inventory = await page.evaluate(() => {
  const triggerOf = el => el.closest('[data-cloner-trigger]')?.getAttribute('data-cloner-trigger') || null;

  const describe = (el) => {
    // class chain of el and up to 3 ancestors
    const chain = [];
    let cur = el;
    for (let d = 0; d < 4 && cur && cur.tagName !== 'BODY'; d++, cur = cur.parentElement) {
      const cls = (cur.className && typeof cur.className === 'string')
        ? cur.className.trim().split(/\s+/).slice(0, 4).join('.')
        : '';
      chain.push(cur.tagName.toLowerCase() + (cls ? '.' + cls : ''));
    }
    return chain.reverse().join(' > ');
  };

  const iconRe = /icon-(plus|minus|close|gear|search|arrow|grid|chart)/;
  const out = { iconButtons: [], btns: [], toolbar: [], triggerEls: [] };

  // 1) elements containing an icon div matching iconRe
  document.querySelectorAll('div[class*="icon"]').forEach(ic => {
    if (!iconRe.test(ic.className)) return;
    // find clickable ancestor: button, [role], or element with btn/click class, else the icon's parent
    const clickable = ic.closest('button, [role="button"], .btn, [class*="btn"], [data-testid]') || ic.parentElement;
    if (!clickable) return;
    out.iconButtons.push({
      icon: ic.className,
      chain: describe(clickable),
      trigger: triggerOf(clickable),
      text: (clickable.textContent || '').trim().slice(0, 40),
    });
  });

  // 2) all [class*="btn"] elements
  document.querySelectorAll('[class*="btn"]').forEach(el => {
    out.btns.push({
      chain: describe(el),
      trigger: triggerOf(el),
      text: (el.textContent || '').trim().slice(0, 40),
    });
  });

  // 3) elements inside toolbars
  const toolbars = document.querySelectorAll('.context-toolbar, .app-controls, [class*="toolbar"]');
  toolbars.forEach(tb => {
    tb.querySelectorAll('button, [role="button"], [class*="btn"], div[class*="icon"], li, a').forEach(el => {
      out.toolbar.push({
        toolbar: (typeof tb.className === 'string' ? tb.className : '').split(/\s+/).slice(0,3).join('.'),
        chain: describe(el),
        trigger: triggerOf(el),
        text: (el.textContent || '').trim().slice(0, 40),
      });
    });
  });

  // 4) all triggers present (for count)
  document.querySelectorAll('[data-cloner-trigger]').forEach(el => {
    out.triggerEls.push({
      trigger: el.getAttribute('data-cloner-trigger'),
      chain: describe(el),
      text: (el.textContent || '').trim().slice(0, 40),
    });
  });

  return out;
});

await browser.close();

// ---- Analyze ----
const missing = list => list.filter(x => !x.trigger);

console.log(`\n[TOTALS] trigger elements in HTML: ${inventory.triggerEls.length}`);
console.log(`[runtime] interactions defined: ${interactions.length}`);

// dedupe helper
const uniq = arr => {
  const seen = new Set();
  return arr.filter(x => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const iconMissing = missing(uniq(inventory.iconButtons));
const btnMissing = missing(uniq(inventory.btns));
const toolbarMissing = missing(uniq(inventory.toolbar));

console.log(`\n--- CATEGORY COUNTS (missing trigger) ---`);
console.log(`icon-(plus|minus|close|gear|search|arrow|grid|chart) holders: ${uniq(inventory.iconButtons).length} total, ${iconMissing.length} missing trigger`);
console.log(`[class*="btn"] elements: ${uniq(inventory.btns).length} total, ${btnMissing.length} missing trigger`);
console.log(`toolbar descendants: ${uniq(inventory.toolbar).length} total, ${toolbarMissing.length} missing trigger`);

// Rank missing by importance: buttons with icon classes and btn- classes first
const iconReNode = /icon-(plus|minus|close|gear|search|arrow|grid|chart)/;
const importance = (x) => {
  let s = 0;
  const chain = (x.chain || '');
  if (/btn-(lg|icon|text|primary)/.test(chain)) s += 3;
  if (iconReNode.test(chain)) s += 2;
  if (chain.includes('btn-wrap')) s += 4;
  if (/add-module|dashboard|order|chart/i.test(chain + (x.text || ''))) s += 3;
  if ((x.text || '').length > 2) s += 1;
  return s;
};

const pool = uniq([...iconMissing.map(x => ({ ...x, cat: 'icon' })),
                   ...btnMissing.map(x => ({ ...x, cat: 'btn' })),
                   ...toolbarMissing.map(x => ({ ...x, cat: 'toolbar' }))]);
const seenChain = new Set();
const topMissing = pool
  .filter(x => { const k = x.chain + '|' + x.text; if (seenChain.has(k)) return false; seenChain.add(k); return true; })
  .sort((a, b) => importance(b) - importance(a))
  .slice(0, 25);

console.log(`\n--- TOP 25 MISSING (ranked) ---`);
topMissing.forEach((x, i) => {
  console.log(`${String(i + 1).padStart(2)}. [${x.cat}] ${x.chain} :: text="${x.text || '(none)'}"`);
});

fs.writeFileSync('D:/project 2/cloner/scripts/audit-1-result.json', JSON.stringify({
  counts: {
    triggersInHtml: inventory.triggerEls.length,
    runtimeInteractions: interactions.length,
    iconTotal: uniq(inventory.iconButtons).length, iconMissing: iconMissing.length,
    btnTotal: uniq(inventory.btns).length, btnMissing: btnMissing.length,
    toolbarTotal: uniq(inventory.toolbar).length, toolbarMissing: toolbarMissing.length,
  },
  topMissing, triggerEls: inventory.triggerEls,
}, null, 2));
console.log('\n[saved] scripts/audit-1-result.json');
