// Original vs clone comparison: pixel diff + heatmap + design-token deltas.
// Usage: node scripts/compare-clone.mjs <runDir> [port] [origPng] [cloneHtml] [outDir]
//   v1 layout: original at <runDir>/_reference/page-1.png, clone at <runDir>/index.html
//   v2 layout: pass explicit origPng (exploration screenshot) + cloneHtml
//     (<artifactsDir>-project/index.html) + outDir (artifactsDir for _reference/)
//  - pixel diff: mean delta, % pixels differing, 12×8 grid heatmap → _reference/diff.png
//  - token deltas: design-tokens.json (captured from the LIVE site) vs tokens
//    re-measured from the rendered clone — exact colors/fonts/spacing drift
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, renderCloneScreenshot } from "../src/browser.js";

const runDir = path.resolve(process.argv[2] || "");
const port = Number(process.argv[3]) || 4199;
const origPath = process.argv[4] ? path.resolve(process.argv[4]) : path.join(runDir, "_reference", "page-1.png");
const cloneHtml = process.argv[5] ? path.resolve(process.argv[5]) : path.join(runDir, "index.html");
const outDir = process.argv[6] ? path.resolve(process.argv[6]) : runDir;
const refDir = path.join(outDir, "_reference");
fs.mkdirSync(refDir, { recursive: true });
if (!fs.existsSync(origPath) || !fs.existsSync(cloneHtml)) {
  console.error("usage: node scripts/compare-clone.mjs <runDir> [port] [origPng] [cloneHtml] [outDir]  (needs an original screenshot + clone index.html)");
  process.exit(1);
}

const b = await launchBrowser({ headless: true });
const viewport = { width: 1440, height: 900 };

// render the clone (same engine as verify.mjs)
const cloneShot = await renderCloneScreenshot(b, cloneHtml, viewport);
if (!cloneShot) { console.error("clone render failed"); process.exit(1); }
const clonePath = path.join(refDir, "clone-verify.png");
fs.writeFileSync(clonePath, cloneShot);

// ---- pixel diff in-browser (no new deps) ----
const p = await b.newPage({ viewport });
await p.setContent("<canvas id='c'></canvas>");
const stats = await p.evaluate(async ({ aData, bData }) => {
  const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const [A, B] = await Promise.all([load(aData), load(bData)]);
  const W = Math.min(A.width, B.width), H = Math.min(A.height, B.height);
  const c = document.getElementById("c");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.drawImage(A, 0, 0, W, H);
  const a = ctx.getImageData(0, 0, W, H).data;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(B, 0, 0, W, H);
  const bb = ctx.getImageData(0, 0, W, H).data;
  const GX = 12, GY = 8;
  const grid = Array.from({ length: GX * GY }, () => ({ diff: 0, n: 0 }));
  let differing = 0, total = 0, sum = 0;
  const out = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = Math.max(Math.abs(a[i] - bb[i]), Math.abs(a[i + 1] - bb[i + 1]), Math.abs(a[i + 2] - bb[i + 2]));
      sum += d; total++;
      const g = Math.floor((y / H) * GY) * GX + Math.floor((x / W) * GX);
      grid[g].diff += d; grid[g].n++;
      if (d > 30) { differing++; out.data[i] = 255; out.data[i + 3] = 180; } // heatmap: red where different
      else { out.data[i + 3] = 0; }
    }
  }
  ctx.putImageData(out, 0, 0);
  // overlay on the clone for context
  ctx.globalAlpha = 0.85;
  ctx.drawImage(B, 0, 0, W, H);
  ctx.globalAlpha = 1;
  ctx.putImageData(out, 0, 0);
  return {
    w: W, h: H,
    meanDelta: +(sum / total).toFixed(2),
    diffPct: +((differing / total) * 100).toFixed(2),
    cells: grid.map((g, idx) => ({ cell: idx, score: +(g.diff / (g.n || 1)).toFixed(1) })),
    heat: c.toDataURL("image/png"),
  };
}, { aData: "data:image/png;base64," + fs.readFileSync(origPath).toString("base64"), bData: "data:image/png;base64," + cloneShot.toString("base64") });

fs.writeFileSync(path.join(refDir, "diff.png"), Buffer.from(stats.heat.split(",")[1], "base64"));
const hot = [...stats.cells].sort((x, y) => y.score - x.score).slice(0, 5);

// ---- token deltas: live-site tokens (design-tokens.json) vs clone-rendered tokens ----
let tokenRows = [];
try {
  const live = JSON.parse(fs.readFileSync(path.join(outDir, "design-tokens.json"), "utf8"));
  const cp = await b.newPage({ viewport });
  await cp.goto("file:///" + cloneHtml.replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 }).catch(() => {});
  await cp.waitForTimeout(900);
  const cloneTokens = await cp.evaluate(() => {
    const freq = { colors: {}, backgrounds: {}, fonts: {}, fontSizes: {} };
    const els = document.querySelectorAll("body *");
    const step = Math.max(1, Math.floor(els.length / 3500));
    for (let i = 0; i < els.length; i += step) {
      const el = els[i]; const cs = getComputedStyle(el);
      if (cs.color) freq.colors[cs.color] = (freq.colors[cs.color] || 0) + 1;
      if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") freq.backgrounds[cs.backgroundColor] = (freq.backgrounds[cs.backgroundColor] || 0) + 1;
      const f = (cs.fontFamily || "").split(",")[0].replace(/["']/g, "");
      if (f) freq.fonts[f] = (freq.fonts[f] || 0) + 1;
      if (cs.fontSize) freq.fontSizes[cs.fontSize] = (freq.fontSizes[cs.fontSize] || 0) + 1;
    }
    const top = (o, n = 12) => Object.entries(o).sort((a, b2) => b2[1] - a[1]).slice(0, n);
    return { colors: top(freq.colors), backgrounds: top(freq.backgrounds), fonts: top(freq.fonts, 6), fontSizes: top(freq.fontSizes, 10) };
  });
  await cp.close();
  // normalize both sides before comparing: live tokens are hex (buildTokens),
  // clone-measured values are rgb()/rgba() computed strings — transparent
  // colors map to null and drop out so they can't masquerade as black
  const toHexNorm = (v) => {
    const m = String(v || "").match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?)\s*)?\)/);
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("").toLowerCase();
  };
  const norm = (arr) => arr.map(([v, n]) => [toHexNorm(v) ?? String(v).toLowerCase(), n]).filter((x) => x[0] !== "null");
  const overlap = (liveArr, cloneArr) => {
    const cs = new Set(norm(cloneArr).map((x) => x[0]));
    const hit = norm(liveArr).filter((x) => cs.has(x[0])).length;
    return `${hit}/${liveArr.length} match`;
  };
  tokenRows = [
    ["text colors", overlap(live.colors, cloneTokens.colors)],
    ["background colors", overlap(live.backgrounds, cloneTokens.backgrounds)],
    ["font families", overlap(live.fonts, cloneTokens.fonts)],
    ["font sizes", overlap(live.fontSizes, cloneTokens.fontSizes)],
  ];
} catch (e) {
  tokenRows = [["token comparison", "failed: " + e.message.slice(0, 60)]];
}
await b.close();

// ---- report ----
const lines = [
  "CLONE COMPARISON — " + path.basename(outDir),
  "═".repeat(52),
  `pixels compared   : ${stats.w}×${stats.h} (original vs clone render)`,
  `mean channel delta: ${stats.meanDelta}/255`,
  `pixels differing  : ${stats.diffPct}% (threshold 30/255)`,
  `heatmap           : _reference/diff.png (red = different)`,
  "",
  `hottest regions (12×8 grid): ${hot.map((h) => `#${h.cell}=${h.score}`).join(", ")}`,
  "",
  "token drift (live site vs clone render):",
  ...tokenRows.map(([k, v]) => `  ${k.padEnd(20)} ${v}`),
  "",
  "grade: " + (stats.diffPct < 15 ? "A — near-identical" : stats.diffPct < 35 ? "B — same layout, visible drift" : stats.diffPct < 60 ? "C — recognizable, meaningful drift" : "D — substantial drift"),
];
const report = lines.join("\n");
console.log(report);
fs.writeFileSync(path.join(refDir, "comparison.txt"), report);
const fail = stats.diffPct >= 60;
process.exit(fail ? 1 : 0);
