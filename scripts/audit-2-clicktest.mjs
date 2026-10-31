// TASK 2 — Live click test of every [data-cloner-trigger] element
import { chromium } from 'playwright';

const URL = 'http://localhost:4173/preview/tradovate-live/index.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', e => console.error('[pageerror]', e.message.slice(0, 120)));
page.on('console', m => { if (m.type() === 'error') console.error('[console.error]', m.text().slice(0, 120)); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1200); // let runtime attach handlers

const triggers = await page.evaluate(() =>
  [...document.querySelectorAll('[data-cloner-trigger]')].map(el => el.getAttribute('data-cloner-trigger'))
);
console.log(`Found ${triggers.length} trigger elements: ${triggers.join(', ')}\n`);

const results = [];
for (const id of triggers) {
  const r = await page.evaluate(async (tid) => {
    const el = document.querySelector(`[data-cloner-trigger="${tid}"]`);
    if (!el) return { ok: false, reason: 'element not found' };
    const before = {
      overlays: document.querySelectorAll('[data-cloner-overlay],[data-cloner-module]').length,
    };
    // scroll into view + real click
    el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { ok: false, reason: 'zero-size element' };
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
    el.click();
    return { ok: true, before };
  }, id);

  if (!r.ok) {
    results.push({ id, opened: false, note: r.reason });
    continue;
  }

  await page.waitForTimeout(900);

  const state = await page.evaluate(() => {
    const ov = [...document.querySelectorAll('[data-cloner-overlay],[data-cloner-module]')];
    const visible = ov.filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 100 && r.height > 60 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
    });
    return {
      count: ov.length,
      visibleCount: visible.length,
      text: visible.length ? (visible[0].textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) : '',
      rect: visible.length ? (b => ({ w: Math.round(b.width), h: Math.round(b.height) }))(visible[0].getBoundingClientRect()) : null,
    };
  });

  results.push({
    id,
    opened: state.visibleCount > 0,
    overlaysTotal: state.count,
    size: state.rect,
    text: state.text,
  });

  // cleanup: Escape, then force-remove leftovers
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    document.querySelectorAll('[data-cloner-overlay],[data-cloner-module]').forEach(e => e.remove());
  });
  await page.waitForTimeout(150);
}

await browser.close();

const working = results.filter(r => r.opened);
const broken = results.filter(r => !r.opened);
console.log('=== RESULTS TABLE ===');
console.log('id      | opened | size        | overlay text (first 60)');
for (const r of results) {
  console.log(
    String(r.id).padEnd(7) + '| ' + (r.opened ? 'YES ' : 'NO  ') + ' | ' +
    (r.size ? `${r.size.w}x${r.size.h}` : ' -          ') + ' | ' + (r.text || r.note || '')
  );
}
console.log(`\nWORKING: ${working.length}/${results.length}  (ids: ${working.map(r => r.id).join(', ') || 'none'})`);
console.log(`BROKEN : ${broken.length}/${results.length}  (ids: ${broken.map(r => r.id).join(', ') || 'none'})`);
