import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(pathToFileURL('D:/project 2/cloner/artifacts/exp-mw60jhf5pwjh-project/page-001-state-03.html').href);
await page.waitForTimeout(400);
const r = await page.evaluate(() => {
  const sel = 'a, button, [role="button"], input, select, textarea, [data-cloner-trigger]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) continue;
    out.push(`<${el.tagName.toLowerCase()} class="${String(el.className).split(' ').slice(0,2).join(' ')}" ${el.getAttribute('aria-label') ? 'aria-label="'+el.getAttribute('aria-label')+'"' : ''} text="${(el.innerText||'').trim().slice(0,30)}" href="${el.getAttribute('href')||''}">`);
  }
  return out;
});
console.log('HIDDEN_INTERACTIVE=' + r.length); r.forEach(x => console.log(x));
await browser.close();
