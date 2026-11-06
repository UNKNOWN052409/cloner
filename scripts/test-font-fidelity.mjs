#!/usr/bin/env node
// Offline font-fidelity test — the clone must render in the ORIGINAL's fonts,
// never a Times fallback. Runs a 127.0.0.1 fixture (page + linked stylesheet
// with real @font-face rules + REAL woff2 bytes captured from a previous real
// run — no external browsing, no network), then:
//   fixture exploration (font FILES captured from network + @font-face srcs,
//   fonts manifest written) → reconstruction (@font-face emitted into
//   tokens.css BEFORE the font tokens, measured families mapped, honest
//   substitutions) and asserts:
//   (a) the font file is captured under assets/fonts with the EXACT served bytes
//       (both the page-fetched weight and the @font-face-only weight);
//   (b) tokens.css contains an @font-face for the measured family pointing at
//       the captured file, and the @font-face block precedes --font-primary;
//   (c) the generated page CSS references the measured family;
//   (d) a measured family with NO captured file records an honest substitution
//       (fonts-manifest.json + a tokens.css note) instead of silently falling
//       back to Times.
// Prints PASS/FAIL counts; exit 1 on any failure. No package.json script here —
// the integrator owns package.json.
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // loopback fixture — documented opt-in (SSRF guard)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);
const { startFixtureServer } = await import("../scripts/fixtures/server.mjs");
const { runExplorationJob } = await import("../src/pipeline/exploration-pipeline.js");
const { reconstructFromArtifacts } = await import("../src/reconstruction/reconstruction-pipeline.js");

const results = [];
const failures = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ---- real woff2 bytes for the fixture: harvested from the previous real
// capture (artifacts/*/assets/fonts/), verified by the wOF2 magic — the test
// never fabricates font bytes and never touches the network.
function findRealWoff2(minDistinct) {
  const found = new Map(); // sha → path
  let roots = [];
  try { roots = fs.readdirSync("artifacts", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join("artifacts", d.name)); } catch { return []; }
  for (const root of roots) {
    const dir = path.join(root, "assets", "fonts");
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".woff2")); } catch { continue; }
    for (const f of files) {
      const buf = fs.readFileSync(path.join(dir, f));
      if (buf.length < 1000 || buf.subarray(0, 4).toString("ascii") !== "wOF2") continue;
      found.set(sha256(buf), buf);
      if (found.size >= minDistinct) return [...found.values()];
    }
  }
  return [...found.values()];
}

const fontBytes = findRealWoff2(2);
if (!fontBytes.length) {
  check("real woff2 bytes available for the fixture", false, "no artifacts/*/assets/fonts/*.woff2 with wOF2 magic found — run a real exploration first");
  console.log(`\nRESULT: FAIL  (0/${results.length})`);
  process.exit(1);
}
const bytes400 = fontBytes[0];
const bytes700 = fontBytes[1] || fontBytes[0]; // second distinct weight, else same file (dedupe covered)
console.log(`info  fixture fonts: 400=${bytes400.length}B (${sha256(bytes400).slice(0, 12)}…) 700=${bytes700.length}B`);

// ---- fixture site: a page whose stylesheet declares @font-face for
// "Fixture Sans" (weights 400 + 700 — the page only RENDERS 400, so the 700
// file must be discovered through the @font-face rules, not the network) and
// a heading family "Fixture Serif" that has NO @font-face at all → measured,
// never captured → the substitution path.
const site = {
  name: "font-fidelity",
  entry: "/",
  handle(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    const send = (ct, body) => { res.writeHead(200, { "content-type": ct }); res.end(body); };
    if (u.pathname === "/") return send("text/html; charset=utf-8", `<!DOCTYPE html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles/site.css"><title>Font Fidelity Fixture</title></head>
<body>
  <header><nav><a href="/">Home</a></nav></header>
  <main>
    <h1>Fixture Serif Heading</h1>
    <p>Body copy rendered in the captured webfont — the engine must reproduce it.</p>
    <p>A second paragraph so sampling has volume.</p>
  </main>
  <footer><span>footer note</span></footer>
</body></html>`);
    if (u.pathname === "/styles/site.css") return send("text/css; charset=utf-8", `@font-face {
  font-family: "Fixture Sans";
  font-style: normal;
  font-weight: 400;
  src: url("/fonts/fixture-sans-400.woff2") format("woff2");
}
@font-face {
  font-family: "Fixture Sans";
  font-style: normal;
  font-weight: 700;
  src: url("/fonts/fixture-sans-700.woff2") format("woff2");
}
body { margin: 0; font-family: "Fixture Sans", sans-serif; }
h1 { font-family: "Fixture Serif", serif; font-weight: 700; }
nav a { font-family: "Fixture Sans", sans-serif; }`);
    if (u.pathname === "/fonts/fixture-sans-400.woff2") return send("font/woff2", bytes400);
    if (u.pathname === "/fonts/fixture-sans-700.woff2") return send("font/woff2", bytes700);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "font-fidelity-"));
try {
  const { base, close } = await startFixtureServer(site);
  let artifactsDir = null;
  try {
    // ---- exploration: font FILES + fonts manifest ----
    const job = await runExplorationJob({
      url: base + "/",
      artifactsRoot: path.join(tmp, "artifacts"),
      config: { policy: { budgets: { maxRoutes: 1, maxTotalTimeMs: 120000 } } },
    });
    artifactsDir = job.artifactsDir;
    check("exploration completed (manifest.json written)", fs.existsSync(path.join(artifactsDir, "manifest.json")));

    const fontsDir = path.join(artifactsDir, "assets", "fonts");
    const manifest = JSON.parse(fs.readFileSync(path.join(fontsDir, "fonts-manifest.json"), "utf8"));
    check("fonts manifest written (assets/fonts/fonts-manifest.json)", Array.isArray(manifest.fonts), `${manifest.fonts?.length || 0} @font-face entries, ${manifest.networkOnly?.length || 0} network-only`);

    // (a) captured bytes are byte-identical to the served font
    const fontEntries = manifest.fonts || [];
    const e400 = fontEntries.find((e) => e.family === "Fixture Sans" && e.weight === "400");
    const e700 = fontEntries.find((e) => e.family === "Fixture Sans" && e.weight === "700");
    check("(a) fonts manifest records family/weight/style/file/format for the measured family", !!(e400 && e400.file && e400.format), JSON.stringify(e400 || null).slice(0, 200));
    const buf400 = e400 ? fs.readFileSync(path.join(artifactsDir, e400.file)) : null;
    check("(a) captured font file bytes equal the served woff2 (hash-dedupe integrity)", !!buf400 && sha256(buf400) === sha256(bytes400), buf400 ? e400.file.replace(/\\/g, "/") : "no file");
    check("(a) captured under assets/fonts/", !!buf400 && e400.file.replace(/\\/g, "/").startsWith("assets/fonts/"), e400?.file || "n/a");
    const buf700 = e700 ? fs.readFileSync(path.join(artifactsDir, e700.file)) : null;
    check("(a) @font-face-only weight (700, never fetched by the page) captured from the CSS rules", !!buf700 && sha256(buf700) === sha256(bytes700) && e700.source === "font-face", e700 ? `${e700.file} (${e700.source})` : "700 entry missing");

    // ---- reconstruction: @font-face into tokens.css + honest substitutions ----
    const outDir = path.join(tmp, "project");
    const recon = await reconstructFromArtifacts(artifactsDir, { outDir });
    check("reconstruction completed", !!recon?.ok, recon ? `status=${recon.report?.status}` : "no result");

    const tokensCss = fs.readFileSync(path.join(outDir, "styles", "tokens.css"), "utf8");
    const faceIdx = tokensCss.indexOf("@font-face");
    const varIdx = tokensCss.indexOf("--font-primary");
    check("(b) tokens.css contains @font-face rules", faceIdx >= 0);
    check("(b) @font-face block precedes the font tokens (--font-primary)", faceIdx >= 0 && varIdx >= 0 && faceIdx < varIdx, `@font-face@${faceIdx}, --font-primary@${varIdx}`);
    const faceRe = /@font-face\s*\{[^}]*font-family:\s*"Fixture Sans"[^}]*\}/;
    const faceMatch = tokensCss.match(faceRe);
    check("(b) @font-face declared for the measured family (Fixture Sans)", !!faceMatch);
    const srcM = faceMatch?.[0]?.match(/src:\s*url\("([^"]+)"\)\s*format\("([^"]+)"\)/);
    check("(b) @font-face src points at the captured file with its format", !!srcM && srcM[2] === "woff2", srcM ? `${srcM[1]} (${srcM[2]})` : "no src");
    const srcOnDisk = srcM ? fs.existsSync(path.join(outDir, "styles", srcM[1])) : false;
    check("(b) @font-face src resolves to an existing file in the project", srcOnDisk, srcM?.[1] || "n/a");
    const srcHashOk = srcOnDisk && sha256(fs.readFileSync(path.join(outDir, "styles", srcM[1]))) === sha256(bytes400);
    check("(b) project font file is byte-identical to the original", srcHashOk);

    // (c) the generated page CSS references the family
    const indexHtml = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
    check("(c) index.html links tokens.css", indexHtml.includes('href="styles/tokens.css"'));
    const componentsCss = fs.readFileSync(path.join(outDir, "styles", "components.css"), "utf8");
    const referencedInCss = /font-family:[^;{}]*Fixture Sans/.test(componentsCss);
    const referencedInHtml = /font-family:[^;{}"']*Fixture Sans/.test(indexHtml);
    check("(c) generated CSS references the measured family", referencedInCss || referencedInHtml, `components.css=${referencedInCss}, index.html=${referencedInHtml}`);

    // (d) measured family with no captured file → honest substitution, never silent Times
    const fontsManifestProj = JSON.parse(fs.readFileSync(path.join(outDir, "styles", "fonts-manifest.json"), "utf8"));
    const sub = (fontsManifestProj.substitutions || []).find((s) => s.measured === "Fixture Serif");
    check("(d) substitution recorded for the measured family with no captured file", !!sub, JSON.stringify(sub || fontsManifestProj.substitutions || []).slice(0, 220));
    check("(d) substitution note is honest (names the substitute + the no-captured-file reason)", !!sub && typeof sub.reason === "string" && /no captured font file/.test(sub.reason) && /never a silent fallback/.test(sub.reason) && !!sub.substitutedTo, sub?.reason?.slice(0, 160) || "");
    check("(d) tokens.css emits an @font-face for the substituted family (no Times fallback)", /@font-face\s*\{[^}]*font-family:\s*"Fixture Serif"/.test(tokensCss));
    check("(d) every measured web family resolves via @font-face (Fixture Sans + Fixture Serif)", /font-family:\s*"Fixture Sans"/.test(tokensCss) && /font-family:\s*"Fixture Serif"/.test(tokensCss));
    check("(d) engine emits no Times fallback of its own", !/font-family:\s*["']?Times/i.test(tokensCss));
    check("(d) substitution target file exists in the project", !!sub && fs.existsSync(path.join(outDir, "styles", sub.file)), sub?.file || "n/a");
  } finally {
    await close();
  }
  if (failures.length === 0) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log(`info  temp kept for diagnosis: ${tmp}`);
} catch (e) {
  check("no unexpected crash", false, String(e?.stack || e).split("\n").slice(0, 3).join(" | "));
}

const fails = results.filter((r) => !r).length;
console.log(`\n===== font-fidelity: PASS ${results.length - fails} / FAIL ${fails} =====`);
if (failures.length) { console.log("failures:"); for (const f of failures) console.log("  - " + f); }
process.exit(fails ? 1 : 0);
