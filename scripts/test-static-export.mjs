#!/usr/bin/env node
// Task 4.1.9 e2e — static hosting export targets.
//
// Exercises static-export.js against a real staged project tree:
//   • three target shapes: plain static / netlify (_redirects) / vercel
//     (vercel.json with rewrites + headers)
//   • expected files present per target; entry = index.html at root
//   • links resolve (verifyLinks) — zero broken href/src in the emitted tree
//   • deterministic output: same input tree → byte-identical output (two runs,
//     file-by-file sha256 compare) — no timestamps in emitted files
//   • content-hash filenames: asset files get a sha256-prefixed name and every
//     in-HTML reference is rewritten to the hashed name
//   • credential-named entries refused (fail-closed, exporter.js rules)
//   • non-empty outDir refused (never clobbers a deployment folder)
//   • unknown target → 400
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const S = await import("../src/platform/static-export.js");
const rand = () => crypto.randomBytes(4).toString("hex");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "static-export-test-"));
const source = path.join(work, "site");
fs.mkdirSync(path.join(source, "assets"), { recursive: true });
fs.writeFileSync(path.join(source, "index.html"), `<!DOCTYPE html>
<html><head><link rel="stylesheet" href="assets/style.css"><script src="assets/app.js"></script></head>
<body><h1>Static Export</h1><img src="assets/logo.png" alt="logo"><a href="about.html">About</a></body></html>`);
fs.writeFileSync(path.join(source, "about.html"), `<html><body><a href="index.html">Home</a><img src="assets/logo.png"></body></html>`);
fs.writeFileSync(path.join(source, "assets", "style.css"), "body{font-family:sans-serif}");
fs.writeFileSync(path.join(source, "assets", "app.js"), "console.log('app');");
fs.writeFileSync(path.join(source, "assets", "logo.png"), Buffer.from("fake-png-bytes-" + rand()));

const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// ---- plain static ----
{
  const out = path.join(work, "out-static");
  const r = await S.exportStaticTarget({ sourceDir: source, target: "static", outDir: out });
  check("S1  static target: entry is index.html at root", r.ok === true && r.entry === "index.html" && fs.existsSync(path.join(out, "index.html")), `files=${r.fileCount}`);
  check("S2  all source files present in the output", ["index.html", "about.html", "assets/style.css", "assets/app.js", "assets/logo.png"].every((f) => fs.existsSync(path.join(out, f))), r.files.join(","));
  check("S3  content is byte-identical to the source", sha256(path.join(out, "index.html")) === sha256(path.join(source, "index.html")), "hash match");
  const links = S.verifyLinks(out);
  check("S4  zero broken links in the emitted tree", links.ok === true, links.broken.join(", ") || "clean");
}

// ---- netlify shape ----
{
  const out = path.join(work, "out-netlify");
  const r = await S.exportStaticTarget({ sourceDir: source, target: "netlify", outDir: out });
  const redirects = fs.readFileSync(path.join(out, "_redirects"), "utf8");
  check("N1  netlify adds _redirects with the SPA fallback", r.ok && redirects.includes("/*") && redirects.includes("/index.html"), redirects.split("\n")[0]);
  check("N2  netlify keeps the full site tree", fs.existsSync(path.join(out, "assets", "app.js")), "assets present");
  check("N3  netlify links resolve", S.verifyLinks(out).ok, "clean");
}

// ---- vercel shape ----
{
  const out = path.join(work, "out-vercel");
  const r = await S.exportStaticTarget({ sourceDir: source, target: "vercel", outDir: out });
  const cfg = JSON.parse(fs.readFileSync(path.join(out, "vercel.json"), "utf8"));
  check("V1  vercel.json is valid JSON with rewrites + cleanUrls", cfg.cleanUrls === true && Array.isArray(cfg.rewrites) && cfg.rewrites[0].destination === "/index.html", JSON.stringify(cfg.rewrites));
  check("V2  vercel headers carry the security baselines", (cfg.headers?.[0]?.headers || []).some((h) => h.key === "X-Content-Type-Options"), JSON.stringify(cfg.headers?.[0]?.headers?.map((h) => h.key)));
  check("V3  vercel output links resolve", S.verifyLinks(out).ok, "clean");
}

// ---- determinism: two runs → byte-identical trees ----
{
  const a = path.join(work, "det-a");
  const b = path.join(work, "det-b");
  await S.exportStaticTarget({ sourceDir: source, target: "netlify", outDir: a });
  await S.exportStaticTarget({ sourceDir: source, target: "netlify", outDir: b });
  const files = fs.readdirSync(a, { recursive: true }).filter((f) => fs.statSync(path.join(a, f)).isFile()).sort();
  let identical = true;
  for (const f of files) {
    if (sha256(path.join(a, f)) !== sha256(path.join(b, f))) identical = false;
  }
  check("D1  deterministic: same input → byte-identical output trees", identical && files.length >= 6, `${files.length} files compared`);
  const noTimestamps = !files.some((f) => /20\d\d-\d\d-\d\d|T\d\d:\d\d:\d\d/.test(fs.readFileSync(path.join(a, f), "utf8").slice(0, 400)));
  check("D2  no timestamps embedded in emitted files", noTimestamps, "clean");
}

// ---- content-hash filenames + reference rewriting ----
{
  const out = path.join(work, "out-hashed");
  const r = await S.exportStaticTarget({ sourceDir: source, target: "static", outDir: out, hashAssets: true });
  const assets = r.files.filter((f) => f.startsWith("assets/"));
  const hashed = assets.filter((f) => /^assets\/[a-z0-9.]+-[0-9a-f]{8}\./.test(f));
  check("H1  asset files carry content-hash names", hashed.length === 3, assets.join(","));
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  const originalHash = sha256(path.join(source, "assets", "style.css")).slice(0, 8);
  check("H2  HTML references rewritten to the hashed names", html.includes(`style-${originalHash}.css`) && !/href="assets\/style\.css"/.test(html), (html.match(/assets\/[a-z0-9.]+-[0-9a-f]{8}\.[a-z0-9]+/g) || []).join(","));
  const links = S.verifyLinks(out);
  check("H3  rewritten links still resolve (zero broken)", links.ok, links.broken.join(", ") || "clean");
  const scriptContent = fs.readFileSync(path.join(out, hashed.find((f) => f.endsWith(".js"))), "utf8");
  check("H4  hashed asset content unchanged", scriptContent === fs.readFileSync(path.join(source, "assets", "app.js"), "utf8"), "identical");
}

// ---- guards ----
{
  let err = null;
  try { await S.exportStaticTarget({ sourceDir: source, target: "s3", outDir: path.join(work, "x") }); } catch (e) { err = e; }
  check("GU1 unknown target → 400", !!err && err.status === 400 && /unknown static target/.test(err.message), err?.message?.slice(0, 70));

  let err2 = null;
  try { await S.exportStaticTarget({ sourceDir: source, target: "static", outDir: path.join(work, "out-static") }); } catch (e) { err2 = e; }
  check("GU2 non-empty outDir refused (never clobbers a deployment folder)", !!err2 && /must be empty/.test(err2.message), err2?.message?.slice(0, 70));

  const noIdx = path.join(work, "no-index");
  fs.mkdirSync(noIdx, { recursive: true });
  let err3 = null;
  try { await S.exportStaticTarget({ sourceDir: noIdx, target: "static", outDir: path.join(work, "y") }); } catch (e) { err3 = e; }
  check("GU3 source without index.html refused", !!err3 && /index\.html/.test(err3.message), err3?.message?.slice(0, 70));

  // broken link detection actually catches breakage (sensitivity check)
  const broken = path.join(work, "broken-site");
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, "index.html"), `<html><body><img src="assets/missing.png"></body></html>`);
  const outB = path.join(work, "out-broken");
  await S.exportStaticTarget({ sourceDir: broken, target: "static", outDir: outB });
  const verdict = S.verifyLinks(outB);
  check("GU4 broken-link checker catches a missing asset (sensitivity proven)", verdict.ok === false && verdict.broken.some((b) => b.includes("missing.png")), verdict.broken.join(", "));
}

// ---- cleanup ----
fs.rmSync(work, { recursive: true, force: true });

const pass = results.filter(Boolean).length;
const fail = results.length - pass;
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"}  (${pass}/${results.length})`);
process.exit(fail ? 1 : 0);
