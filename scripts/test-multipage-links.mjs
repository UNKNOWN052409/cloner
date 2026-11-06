#!/usr/bin/env node
// Offline multipage-navigation test — asserts that the generated project's
// internal links actually NAVIGATE (the "1st page hi clone hota hai, kaam nahi
// karta, image jaisa hai" contract), served statically.
//
// What it does (read-only over the REAL artifacts dir):
//   1. hashes the artifacts job dir, then copies it into the OS temp dir —
//      reconstructFromArtifacts writes blueprint.json / design-tokens.json /
//      pages/<id>/understanding.json next to its INPUT and logs beside it, so
//      the reconstruction runs against the COPY and the original provably
//      never changes (re-hashed at the end; equality is itself an assertion);
//   2. runs reconstructFromArtifacts with outDir inside the temp dir, no
//      visionFn/visionCfg → the deterministic no-provider path, zero network;
//   3. asserts:
//      (a) a page file exists per explored route — honest, listed exception:
//          a manifest page whose dom.json is missing/malformed or has ZERO
//          captured elements has nothing to generate from;
//      (b) every <a href> in every generated page either resolves to an
//          existing local file, is "#" + data-cloner-unexplored="true", or is
//          external (different origin / protocol-relative / non-navigational
//          scheme); a same-origin absolute href is a FAIL (the generator must
//          have rewritten it to a relative local file or marked it unexplored);
//      (c) when more than one route was explored, index.html links to at least
//          one sibling page (an anchor resolving to a generated page file that
//          is not index.html itself).
//
// Prints PASS/FAIL/EXCEPTION counts and every failure; exit 1 on any failure.
// No package.json script here — the integrator owns package.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { reconstructFromArtifacts } from "../src/reconstruction/reconstruction-pipeline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_JOB = "bench-documentation-mvwxrhct";

const jobIds = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!jobIds.length) jobIds.push(DEFAULT_JOB);

let passCount = 0;
let failCount = 0;
let exceptionCount = 0;
const failures = [];

function check(label, ok, detail = "") {
  if (ok) { passCount++; console.log(`  PASS  ${label}`); }
  else { failCount++; failures.push(`${label}${detail ? " — " + detail : ""}`); console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
}
function exception(label, detail = "") {
  exceptionCount++;
  console.log(`  EXC   ${label}${detail ? " — " + detail : ""}  (honest listed exception)`);
}

function hashDir(dir) {
  const h = crypto.createHash("sha256");
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) { h.update(`L\0${rel}\0${fs.readlinkSync(abs)}\0`); return; }
    if (st.isDirectory()) { h.update(`D\0${rel}\0`); for (const e of fs.readdirSync(abs).sort()) walk(path.join(rel, e)); return; }
    if (!st.isFile()) { h.update(`O\0${rel}\0`); return; }
    h.update(`F\0${rel}\0${st.size}\0`);
    h.update(fs.readFileSync(abs));
  };
  for (const e of fs.readdirSync(dir).sort()) walk(e);
  return h.digest("hex");
}

// same deterministic route→file slug the pipeline assigns (reconstruction-pipeline.js)
function expectedFileFor(page) {
  const raw = page.route?.url || page.url || "/";
  const pathname = new URL(raw, "http://x").pathname;
  if (page.pageId === "page-001") return "index.html";
  const slug = pathname.replace(/^\//, "").replace(/\/+$/, "").replace(/\.html?$/i, "").replace(/[?&#]/g, "_").replace(/\//g, "_").replace(/_+$/, "");
  return (slug || page.pageId) + ".html";
}

const SCHEME_OK_RE = /^(javascript|mailto|tel|sms|data|blob|ftp|file):/i;
function canonical(p) {
  let x = String(p ?? "").split("?")[0].split("#")[0];
  if (!x.startsWith("/")) x = "/" + x;
  x = x.replace(/\/+$/, "").replace(/\/index\.html?$/i, "").replace(/\/+$/, "");
  return x || "/";
}

function auditLinks(outDir, fileRel, appOrigin, exploredCanonicals) {
  const html = fs.readFileSync(path.join(outDir, fileRel), "utf8");
  const pageDir = path.posix.dirname(fileRel);
  const problems = [];
  let siblingLinks = 0;
  const anchorRe = /<a\b([^>]*)>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const attrs = m[1];
    const hrefM = attrs.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!hrefM) continue;
    const href = hrefM[1] !== undefined ? hrefM[1] : hrefM[2];
    const cls = (() => {
      if (href === "") return { ok: true, why: "empty href (self)" };
      if (SCHEME_OK_RE.test(href)) return { ok: true, why: "non-navigational scheme" };
      if (href.startsWith("#")) {
        const marked = /data-cloner-unexplored\s*=\s*("true"|'true'|true)/i.test(attrs);
        if (href === "#" && marked) return { ok: true, why: "unexplored marker" };
        return { ok: false, why: "fragment anchor not marked unexplored" };
      }
      if (href.startsWith("//")) return { ok: true, why: "protocol-relative external" };
      if (/^https?:\/\//i.test(href)) {
        try {
          const u = new URL(href);
          if (appOrigin && u.origin === appOrigin) return { ok: false, why: "same-origin absolute left absolute" };
          if (!appOrigin) return { ok: false, why: "absolute href to unknown origin origin" };
          return { ok: true, why: "external" };
        } catch { return { ok: false, why: "unparseable absolute href" }; }
      }
      const rel = path.posix.normalize(path.posix.join(pageDir === "." ? "" : pageDir, href.split("#")[0]));
      if (rel.startsWith("..")) return { ok: false, why: "escapes the project root" };
      if (fs.existsSync(path.join(outDir, rel))) {
        if (rel.endsWith(".html") && exploredCanonicals.size > 0) {
          // a link to one of the generated PAGES counts as sibling navigation
          if (rel !== "index.html" && rel.endsWith(".html")) siblingLinks++;
        }
        return { ok: true, why: `local file (${rel})` };
      }
      if (href.startsWith("/")) return { ok: false, why: "site-absolute left absolute and unresolvable" };
      return { ok: false, why: `unresolvable relative (${rel})` };
    })();
    if (!cls.ok) problems.push(`href="${href}" — ${cls.why}`);
  }
  return { problems, siblingLinks };
}

async function runJob(jobId) {
  console.log(`\n=== job: ${jobId} ===`);
  const artifactsDir = path.join(ROOT, "artifacts", jobId);
  if (!fs.existsSync(path.join(artifactsDir, "manifest.json"))) {
    check(`artifacts job dir exists with manifest.json (${jobId})`, false, artifactsDir);
    return;
  }

  // mutation guard: hash original → copy → reconstruct from the copy → re-hash
  const before = hashDir(artifactsDir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multipage-links-"));
  const copyDir = path.join(tmp, "artifacts", jobId);
  fs.cpSync(artifactsDir, copyDir, { recursive: true });
  const outDir = path.join(tmp, "project");

  let result = null;
  let runError = null;
  try {
    result = await reconstructFromArtifacts(copyDir, { outDir });
  } catch (e) {
    runError = e;
  }
  check(`reconstructFromArtifacts completed without throwing (${jobId})`, !runError, runError ? String(runError?.message || runError).slice(0, 160) : "");
  if (runError) return;
  console.log(`  info  ok=${result?.ok} status=${result?.report?.status} generatedFiles=${result?.report?.generatedFiles} limitations=${(result?.report?.limitations || []).length}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(artifactsDir, "manifest.json"), "utf8"));
  const manifestPages = manifest.pages || [];
  const originalUrl = manifest.originalUrl || null;
  const appOrigin = originalUrl ? new URL(originalUrl).origin : null;
  const exploredCanonicals = new Set(manifestPages.map((p) => canonical(new URL(p.route?.url || p.url || "/", "http://x").pathname)));

  // ---- (a) a page file per explored route, honest exceptions listed ----
  let emitted = 0;
  for (const page of manifestPages) {
    const expected = expectedFileFor(page);
    const exists = fs.existsSync(path.join(outDir, expected));
    if (exists) { emitted++; check(`page file for ${page.pageId} (${expected})`, true); continue; }
    // honest exception only when there was nothing to generate from
    let domOk = false;
    try {
      const dom = JSON.parse(fs.readFileSync(path.join(artifactsDir, "pages", page.pageId, "dom.json"), "utf8"));
      domOk = Array.isArray(dom.elements) && dom.elements.length > 0;
    } catch { domOk = false; }
    if (!domOk) exception(`page file for ${page.pageId} (${expected})`, "no usable captured DOM for this route");
    else check(`page file for ${page.pageId} (${expected})`, false, `DOM evidence exists but the file was not emitted`);
  }
  check(`at least one page emitted (${jobId})`, emitted > 0);

  // ---- (b) every <a href> in every generated page is resolvable/marked/external ----
  let totalLinks = 0;
  const pageFiles = fs.readdirSync(outDir).filter((f) => f.endsWith(".html"));
  for (const f of pageFiles.sort()) {
    const { problems, siblingLinks } = auditLinks(outDir, f, appOrigin, exploredCanonicals);
    totalLinks += siblingLinks;
    if (f === "index.html") auditSiblingCounts.set(jobId, siblingLinks);
    check(`all <a href> in ${f} resolve / are marked / are external`, problems.length === 0, problems.slice(0, 4).join("; ").slice(0, 400));
  }

  // ---- (c) index.html links to a sibling page when >1 route explored ----
  const routesWithDom = manifestPages.filter((p) => {
    try {
      const dom = JSON.parse(fs.readFileSync(path.join(artifactsDir, "pages", p.pageId, "dom.json"), "utf8"));
      return Array.isArray(dom.elements) && dom.elements.length > 0;
    } catch { return false; }
  }).length;
  if (routesWithDom > 1) {
    const siblings = auditSiblingCounts.get(jobId) || 0;
    check(`index.html links to at least one sibling page (${routesWithDom} routes explored)`, siblings > 0, `sibling links found: ${siblings}`);
  } else {
    exception(`sibling-page nav check skipped`, "single explored route — nothing to link to");
  }

  // ---- mutation guard: the REAL artifacts dir must be byte-identical ----
  const after = hashDir(artifactsDir);
  check(`original artifacts dir unmutated (${jobId})`, before === after);

  if (failCount === 0) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log(`  info  kept temp dir for diagnosis: ${tmp}`);
}

const auditSiblingCounts = new Map();

for (const jobId of jobIds) {
  await runJob(jobId);
}

console.log(`\n===== multipage-links: PASS ${passCount} / FAIL ${failCount} / EXCEPTION ${exceptionCount} =====`);
if (failures.length) {
  console.log("failures:");
  for (const f of failures) console.log("  - " + f);
}
process.exit(failCount > 0 ? 1 : 0);
