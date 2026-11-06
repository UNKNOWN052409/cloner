#!/usr/bin/env node
// Slop-lint self-test (offline, 127.0.0.1-free, no network, no package changes):
// builds a fresh fixture project + fixture captured evidence in a temp dir, runs
// the ADR-0003 hygiene lint against it, and asserts every verdict traces to
// evidence: injected purple gradient + pill badges are flagged AND fixed, the
// gradient + font the fixture evidence really contains are kept untouched, and
// the report carries the {found, fixed, remaining} shape the pipeline reports.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { slopLint } from "../src/reconstruction/hygiene/slop-lint.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

// ---- fixture: captured evidence (the ORIGINAL's measured values) ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), "slop-lint-test-"));
const ev = path.join(root, "evidence");
const proj = path.join(root, "generated-project");
fs.mkdirSync(path.join(ev, "pages", "page-001"), { recursive: true });
fs.mkdirSync(path.join(proj, "styles"), { recursive: true });

fs.writeFileSync(path.join(ev, "pages", "page-001", "styles.json"), JSON.stringify({
  pageId: "page-001",
  typography: [{ font: "Georgia", size: "16px", weight: "w400", occurrences: 11 }],
  bodyStyle: { backgroundColor: "#ffffff", color: "#232936", fontFamily: "Georgia", fontSize: "16px" },
  elements: [
    { i: 0, tag: "header", style: { backgroundColor: "rgb(35, 41, 54)", backgroundImage: "linear-gradient(135deg, rgb(35, 41, 54) 0%, rgb(44, 74, 51) 100%)", fontFamily: "Georgia", fontSize: "16px", borderRadius: "0px" } },
    { i: 1, tag: "div", style: { backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: null, fontFamily: "Georgia", fontSize: "14px", borderRadius: "4px" } },
  ],
}, null, 2));
fs.writeFileSync(path.join(ev, "pages", "page-001", "dom.json"), JSON.stringify({
  pageId: "page-001", url: "http://127.0.0.1:1/", total: 4, sampled: 4,
  typography: [{ font: "Georgia", size: "16px", weight: "w400", occurrences: 11 }],
  elements: [
    { i: 0, tag: "header", cls: "metric", text: "🚀 Deploy status", parent: null, style: {} },
    { i: 1, tag: "p", cls: null, text: "Measured copy", parent: 0, style: {} },
  ],
  repeated: [],
}, null, 2));
fs.writeFileSync(path.join(ev, "design-tokens.json"), JSON.stringify({
  colors: [["#232936", 148], ["#2c4a33", 49], ["#ffffff", 14]],
  backgrounds: [["#ffffff", 10]],
  fonts: [["Georgia", 238]],
  fontSizes: [["14px", 110], ["16px", 67]],
  spacing: [], radii: [["4px", 3]],
  sourceEvidence: { stylesElements: 2, designTokens: true },
}, null, 2));

// ---- fixture: generated project (injected slop + evidence-backed values) ----
fs.writeFileSync(path.join(proj, "styles", "components.css"), [
  `.keep-hero { background: linear-gradient(135deg, #232936 0%, #2c4a33 100%); padding: 20px; }`,
  `.keep-body { font-family: Georgia; border-radius: 4px; }`,
  `.hero-cta { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; padding: 12px 24px; }`,
  `.badge { text-transform: uppercase; letter-spacing: 2px; font-size: 11px; border-radius: 9999px; }`,
  `.injected-font { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }`,
  `.card { box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1); border: 1px solid #eee; }`,
  `.panel { border-radius: 12px; }`,
].join("\n") + "\n");
fs.writeFileSync(path.join(proj, "index.html"), [
  "<!doctype html><html><body>",
  `  <span class="icon">🎨</span>`,
  `  <span data-replay-id="t1">🔒</span>`,
  `  <span>🚀</span>`,
  `  <div class="stat-card"><span>128</span><div>CPU</div></div>`,
  `  <div class="stat-card"><span>64</span><div>RAM</div></div>`,
  `  <div class="stat-card"><span>12</span><div>Nodes</div></div>`,
  `  <div class="stat-card"><span>3</span><div>Regions</div></div>`,
  "</body></html>",
].join("\n") + "\n");

// ---- run ----
const r = slopLint(proj, { artifactsDir: ev });
console.log(`\nslop-lint result: ok=${r.ok} found=${r.found} fixed=${r.fixed} remaining=${r.remaining} findings=${r.findings.length}`);

// ---- report shape ----
console.log("\n[report shape]");
check("ok:true on a scannable project with evidence", r.ok === true);
check("found/fixed/remaining are numbers", [r.found, r.fixed, r.remaining].every((n) => typeof n === "number"));
check("findings is a non-empty array", Array.isArray(r.findings) && r.findings.length > 0);
check("every finding carries pattern/file/line/evidenceChecked/verdict",
  r.findings.every((f) => f.pattern && f.file && typeof f.line === "number" && f.evidenceChecked && f.verdict));
check("verdicts restricted to injected|evidence-backed",
  r.findings.every((f) => f.verdict === "injected" || f.verdict === "evidence-backed"));
check("found = findings.length", r.found === r.findings.length, `got ${r.found} vs ${r.findings.length}`);
const injected = r.findings.filter((f) => f.verdict === "injected");
const backed = r.findings.filter((f) => f.verdict === "evidence-backed");
check("fixed counts only fixed injected findings", r.fixed === injected.filter((f) => f.fixed).length);
check("remaining = injected unfixed", r.remaining === injected.length - r.fixed);

// ---- (a) injected purple gradient + pill badges → flagged AND fixed ----
console.log("\n[injected patterns are flagged and fixed]");
const cssAfter = fs.readFileSync(path.join(proj, "styles", "components.css"), "utf8");
const grad = r.findings.find((f) => f.pattern === "default-gradient");
check("purple/blue gradient flagged", !!grad && grad.verdict === "injected");
check("purple/blue gradient cites evidence consulted", /design-tokens|styles\.json/.test(grad?.evidenceChecked || ""));
check("purple/blue gradient FIXED (decl dropped)", grad?.fixed === true && !cssAfter.includes("#667eea") && !cssAfter.includes("#764ba2"));
const pill = r.findings.find((f) => f.pattern === "pill-badge-uppercase");
check("pill badge (uppercase+tracking) flagged", !!pill && pill.verdict === "injected");
check("pill badge FIXED (treatment dropped)", pill?.fixed === true && !/text-transform/.test(cssAfter) && !/letter-spacing/.test(cssAfter));
const font = r.findings.find((f) => f.pattern === "default-font-stack");
check("default font stack flagged", !!font && font.verdict === "injected");
check("default font stack FIXED → nearest measured token", font?.fixed === true && /font-family:Georgia/.test(cssAfter) && !cssAfter.includes("system-ui"));
const shadow = r.findings.find((f) => f.pattern === "default-box-shadow");
check("default box-shadow flagged + fixed (no captured shadow anywhere)", !!shadow && shadow.verdict === "injected" && shadow.fixed === true && !cssAfter.includes("box-shadow"));
const radii = r.findings.filter((f) => f.pattern === "default-border-radius");
check("default radii (9999px, 12px) flagged", radii.length === 2);
check("default radii FIXED → nearest measured 4px", radii.every((f) => f.fixed) && !cssAfter.includes("9999px") && !cssAfter.includes("border-radius: 12px") && !cssAfter.includes("border-radius:12px") && cssAfter.includes("border-radius:4px"));

// ---- (b) evidence-backed gradient + font → kept ----
console.log("\n[evidence-backed values are kept]");
const keepGrad = r.findings.find((f) => f.pattern === "gradient" && f.verdict === "evidence-backed");
check("fixture's real gradient kept (verdict evidence-backed)", !!keepGrad);
check("fixture's real gradient untouched in file", /linear-gradient\(135deg, #232936 0%, #2c4a33 100%\)/.test(cssAfter));
check("measured font Georgia never flagged", !r.findings.some((f) => f.pattern === "default-font-stack" && /keep-body/.test(f.decl || "")));
check("measured radius 4px never flagged", !r.findings.some((f) => f.pattern === "default-border-radius" && f.decl.includes("4px")));

// ---- HTML findings: emoji + stat strip ----
console.log("\n[html findings]");
const htmlAfter = fs.readFileSync(path.join(proj, "index.html"), "utf8");
const emoji = r.findings.filter((f) => f.pattern === "emoji-as-icon");
check("2 injected emoji-as-icon findings (🎨 unwired, 🔒 wired)", emoji.length === 2, `got ${emoji.length}`);
check("unwired emoji fixed (text stripped)", emoji.some((f) => f.fixed) && !htmlAfter.includes("🎨"));
check("wired emoji (data-replay-id) listed honestly, not edited", emoji.some((f) => !f.fixed) && htmlAfter.includes("🔒"));
check("original's own emoji 🚀 never flagged", !emoji.some((f) => f.decl.includes("🚀")) && htmlAfter.includes("🚀"));
const strip = r.findings.find((f) => f.pattern === "uniform-stat-strip");
check("4-card stat strip flagged (absent from evidence)", !!strip && strip.verdict === "injected");
check("stat strip listed, not content-deleted", strip?.fixed === false && (htmlAfter.match(/class="stat-card"/g) || []).length === 4);

// ---- evidence-gate: no evidence → refuse to verdict ----
console.log("\n[evidence gate]");
const noEv = slopLint(proj, { artifactsDir: path.join(root, "missing-evidence") });
check("no evidence → ok:false, zero findings, honest note", noEv.ok === false && noEv.found === 0 && noEv.findings.length === 0 && /refusing/.test(noEv.notes[0] || ""));
const noProj = slopLint(path.join(root, "missing-project"), { artifactsDir: ev });
check("no project dir → ok:false", noProj.ok === false && noProj.found === 0);

// ---- verdict ----
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
