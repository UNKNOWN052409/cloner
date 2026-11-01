// Render a ChatGPT share page headless and extract the plan text.
import fs from "node:fs";
import { chromium } from "playwright";

const url = process.argv[2];
const out = process.argv[3] || "output/chatgpt-phase50-plan.md";
if (!url) { console.error("usage: node scripts/extract-chatgpt-share.mjs <share-url> [outfile]"); process.exit(1); }

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
// wait for the response text to render (share pages lazy-render)
await p.waitForTimeout(6000);
// scroll through to force lazy renders
for (let i = 0; i < 8; i++) {
  await p.keyboard.press("End");
  await p.waitForTimeout(700);
}
await p.keyboard.press("Control+Home");
await p.waitForTimeout(800);
const text = await p.evaluate(() => {
  // ChatGPT renders messages in <article> / .markdown prose blocks — take the largest text body
  const blocks = [...document.querySelectorAll("article, .markdown, [data-message-author-role]")];
  let best = "";
  for (const el of blocks) {
    const t = (el.innerText || "").trim();
    if (t.length > best.length) best = t;
  }
  return best || document.body.innerText;
});
await b.close();

if (!text.includes("Phase 5.0")) {
  console.error("extraction did not find Phase 5.0 content — got", text.length, "chars, head:", text.slice(0, 120));
  process.exit(2);
}
fs.writeFileSync(out, text);
console.log("SAVED", out, "—", text.length, "chars");
