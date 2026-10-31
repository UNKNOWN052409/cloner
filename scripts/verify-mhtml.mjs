// Verify snapshot.mhtml actually renders in Chromium. Chrome/Edge render .mhtml
// natively; a correct capture shows the full styled page, not raw MIME text.
// Chromium must open it via file:// with the .mhtml extension (its MHTML viewer
// doesn't engage for http multipart/related responses).
// Usage: node scripts/verify-mhtml.mjs <runDir>
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const runDir = process.argv[2];
if (!runDir || !fs.existsSync(path.join(runDir, "snapshot.mhtml"))) {
  console.error("usage: node scripts/verify-mhtml.mjs <runDir-with-snapshot.mhtml>");
  process.exit(1);
}
const mhtmlPath = path.resolve(runDir, "snapshot.mhtml");

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("file:///" + mhtmlPath.replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 }).catch((e) => console.error("goto:", e.message.slice(0, 80)));
await p.waitForTimeout(1500);
const bodyText = await p.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => "");
const bodyHtmlLen = await p.evaluate(() => document.body.innerHTML.length).catch(() => 0);
await p.screenshot({ path: path.join(runDir, "_reference", "mhtml-verify.png"), timeout: 15000 }).catch(() => {});
await b.close();

const looksRaw = /^\s*(From:|Snapshot-Content-Location:|MIME-Version:|Content-Type:)/m.test(bodyText);
console.log(`body innerHTML: ${bodyHtmlLen}B, first text: ${JSON.stringify(bodyText.slice(0, 120))}`);
const ok = !looksRaw && bodyHtmlLen > 2000;
console.log(ok ? "PASS — snapshot rendered as a page" : "FAIL — browser did not render the snapshot (raw MIME or empty body)");
process.exit(ok ? 0 : 1);
