// probe rects in the exhaustive-test context
import { launchBrowser } from "../src/browser.js";
import path from "node:path";
const b = await launchBrowser({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const url = encodeURI("file:///" + path.resolve("platform-data/tmvvfttcya7to/out/index.html").replace(/\\/g, "/"));
await p.goto(url, { waitUntil: "load", timeout: 30000 });
await p.waitForTimeout(1500);
const probe = await p.evaluate(() => {
  const els = [...document.querySelectorAll("[data-cloner-trigger], button, .btn-icon")];
  const rects = els.slice(0, 5).map((e) => {
    const r = e.getBoundingClientRect();
    return Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.width) + "x" + Math.round(r.height);
  });
  return { count: els.length, rects, title: document.title, bodyLen: document.body.innerHTML.length, vis: window.innerWidth + "x" + window.innerHeight };
});
console.log(JSON.stringify(probe, null, 1));
await b.close();
process.exit(0);
