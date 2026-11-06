// Unit check: the fixed DOM extractor captures flexWrap + textAlign; the fixed
// buildComponentCss emits position/top-left/flex-wrap/text-align from capture.
import { DOM_EXTRACTOR_SCRIPT } from "../src/intelligence/dom-extractor.js";
import { buildComponentCss } from "../src/reconstruction/generation/project-generator.js";
import { analyzeLayout } from "../src/reconstruction/analysis/layout-analyzer.js";
import { launchBrowser } from "../src/browser.js";
import fs from "node:fs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

// 1) extractor captures flexWrap + textAlign on a fixture with both
const html = `<!DOCTYPE html><html><head><style>
  .wrap { display:flex; flex-wrap:wrap; text-align:right; width:400px; }
  .item { width:250px; height:20px; }
</style></head><body><div class="wrap"><div class="item">a</div><div class="item">b</div></div></body></html>`;
fs.writeFileSync("scripts/_fixture-extractor.html", html);
const b = await launchBrowser({ headless: true });
const p = await b.newPage({ viewport: { width: 800, height: 600 } });
await p.goto("file:///" + process.cwd().replace(/\\/g, "/") + "/scripts/_fixture-extractor.html");
const intel = await p.evaluate(DOM_EXTRACTOR_SCRIPT);
const wrap = intel.elements.find((e) => e.cls === "wrap");
check("extractor captures flexWrap", wrap?.layout?.flexWrap === "wrap", JSON.stringify(wrap?.layout));
check("extractor captures textAlign", wrap?.style?.textAlign === "right", JSON.stringify(wrap?.style));
await b.close();
fs.rmSync("scripts/_fixture-extractor.html");

// 2) generator emits position + top/left for a fixed element (rect = viewport coords)
const els = [
  { i: 0, tag: "div", cls: "", parent: null, rect: { x: 13, y: 843, w: 44, h: 44 }, layout: { display: "block", position: "fixed" }, style: { backgroundColor: "rgb(1,2,3)" } },
  { i: 3, tag: "div", cls: "", parent: null, rect: { x: 0, y: 0, w: 1440, h: 138 }, layout: { display: "block", position: "relative" }, style: {} },
  { i: 1, tag: "div", cls: "", parent: 3, rect: { x: 150, y: 43, w: 219, h: 65 }, layout: { display: "block", position: "absolute" }, style: {} },
  { i: 2, tag: "div", cls: "", parent: 0, rect: { x: 100, y: 300, w: 1140, h: 200 }, layout: { display: "flex", position: "static", flexDirection: "row", flexWrap: "wrap" }, style: { textAlign: "center" } },
];
const css = buildComponentCss(els, new Map());
check("generator emits position:fixed + viewport top/left", /cx-0 \{[^}]*position:fixed/.test(css) && /cx-0 \{[^}]*left:13px/.test(css) && /cx-0 \{[^}]*top:843px/.test(css), css.split("\n")[0]);
check("generator emits absolute offset relative to positioned ancestor", /cx-1 \{[^}]*position:absolute/.test(css) && /cx-1 \{[^}]*left:150px/.test(css) && /cx-1 \{[^}]*top:43px/.test(css), css.split("\n")[2]);
check("generator emits flex-wrap + text-align from capture", /cx-2 \{[^}]*flex-wrap:wrap/.test(css) && /cx-2 \{[^}]*text-align:center/.test(css), css.split("\n")[3]);

// 3) layout-analyzer infers flex-wrap from multi-row children of a flex container
const rowEls = [
  { i: 5, tag: "div", cls: "", parent: null, rect: { x: 150, y: 733, w: 1140, h: 884 }, layout: { display: "flex", position: "static", flexDirection: "row", flexWrap: null, justifyContent: "normal", alignItems: "normal", gap: null, gridTemplateColumns: null } },
  { i: 6, tag: "div", cls: "", parent: 5, rect: { x: 150, y: 733, w: 570, h: 201 }, layout: { display: "block", position: "static" } },
  { i: 7, tag: "div", cls: "", parent: 5, rect: { x: 720, y: 990, w: 570, h: 201 }, layout: { display: "block", position: "static" } },
];
const rectMap = new Map(rowEls.map((e) => [e.i, { x: e.rect.x, y: e.rect.y, width: e.rect.w, height: e.rect.h }]));
const lay = analyzeLayout(rowEls, rectMap)[5];
check("analyzeLayout infers flex-wrap:wrap from 2-row children", lay?.flexWrap === "wrap", JSON.stringify(lay));
check("analyzeLayout passes through captured display", lay?.display === "flex", JSON.stringify(lay));

process.exit(fails ? 1 : 0);
