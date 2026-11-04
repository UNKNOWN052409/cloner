#!/usr/bin/env node
// Task 3.3.1 e2e — exact interaction element matching in the generated clone.
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // G5.3 SSRF guard: loopback fixture targets — documented opt-in (production default stays strict)
//
// Boots the fixture-toolbar site (scripts/fixture-toolbar.html) on an ephemeral
// node:http port, runs a real exploration (runExplorationJob) + reconstruction
// (reconstructFromArtifacts), then loads the generated index.html with Playwright
// and asserts the replay runtime's findRec match order:
//
//   1. attr match (data-cloner-trigger / data-cloner-inner) — the exact marked
//      button opens the picker, never a duplicate/stacked overlay
//   2. data-replay-id — generator wiring; resolves when the capture-time attr
//      was pruned (simulated SPA re-render)
//   3. structural DOM path (rec.path, tag.class:nth-of-type chain) — the pure
//      layer: an attr-less, label-less click still resolves; and with a DECOY
//      record carrying the same text signature as the real control but a
//      different structural path, the duplicate twin resolves to the decoy
//      (structural beats text) while the real button still hits the real record
//   4. text signature — LAST resort: an element whose structural identity is
//      broken (class renamed → path differs, attrs gone) still replays by label
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT);

const { runExplorationJob } = await import("../src/pipeline/exploration-pipeline.js");
const { reconstructFromArtifacts, deriveInteractionRecords } = await import("../src/reconstruction/reconstruction-pipeline.js");
const { buildRuntime } = await import("../src/runtimeTemplate.js");
const { launchBrowser } = await import("../src/browser.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- ephemeral servers ------------------------------------------------------

// serves one html string at "/" (the fixture-toolbar site)
function startHtmlServer(html) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    base: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((r) => server.close(r)),
  })));
}

// serves the generated project dir; runtime/interactions.js can be swapped at
// test time (runtimePatch) to inject a decoy record for the ambiguity scenario
function startProjectServer(root) {
  const state = { runtimePatch: null };
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const fp = path.resolve(root, rel);
    if (!fp.startsWith(path.resolve(root)) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
    let body = fs.readFileSync(fp);
    if (rel === "runtime/interactions.js" && state.runtimePatch) body = state.runtimePatch;
    res.writeHead(200, { "content-type": types[path.extname(fp).toLowerCase()] || "application/octet-stream" });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    base: "http://127.0.0.1:" + server.address().port,
    setRuntimePatch: (v) => { state.runtimePatch = v; },
    close: () => new Promise((r) => server.close(r)),
  })));
}

// mirror of the replay runtime's domPath() — computes the structural path of a
// live element in the generated clone (used to aim the decoy record exactly).
// Passed to page.evaluate as a real function value: Playwright does NOT
// auto-invoke string expressions that evaluate to functions.
const replicaPath = (el) => {
  const isReplayUi = (n) => !!(n.getAttribute && (n.getAttribute("data-cloner-overlay") || n.getAttribute("data-cloner-module")));
  const parts = [];
  let node = el, guard = 0;
  while (node && node.tagName && node !== document.body && guard < 24) {
    guard++;
    if (isReplayUi(node)) return null;
    const tag = node.tagName.toLowerCase();
    let cls = "";
    const cl = node.classList;
    for (let i = 0; i < cl.length; i++) if (!/^cx-\d+$/.test(cl[i])) { cls = cl[i]; break; }
    let k = 0;
    const par = node.parentElement, sib = par ? par.children : [];
    for (let s = 0; s < sib.length; s++) {
      const t = sib[s];
      if (!t.tagName || t.tagName !== node.tagName) continue;
      if (t !== node && isReplayUi(t)) continue;
      k++;
      if (t === node) break;
    }
    parts.unshift(tag + (cls ? "." + cls : "") + ":nth-of-type(" + k + ")");
    node = par;
  }
  return parts.length ? parts.join(">") : null;
};

// inject a visible structural twin of the marked button right after it (same
// cx-N class → same rendered size; no cloner attrs → invisible to attr matching)
const injectDup = () => {
  const real = document.querySelector('[aria-label="Add module"]');
  const g = real.parentElement;
  const dup = document.createElement("div");
  dup.className = real.className;
  dup.setAttribute("aria-label", "Add module");
  dup.setAttribute("data-test-dup", "1");
  g.insertBefore(dup, real.nextElementSibling);
  return true;
};

let fixtureServer = null, projectServer = null, browser = null;
try {
  // ---- 1) boot the fixture-toolbar site + explore + reconstruct ----
  const fixtureHtml = fs.readFileSync(path.join(PROJECT, "scripts", "fixture-toolbar.html"), "utf8");
  fixtureServer = await startHtmlServer(fixtureHtml);
  const { artifactsDir } = await runExplorationJob({
    url: fixtureServer.base + "/",
    artifactsRoot: "artifacts",
    config: { policy: { budgets: { maxRoutes: 2, maxStatesPerPage: 8, maxTotalTimeMs: 90000 } } },
  });
  check("exploration completed", fs.existsSync(path.join(artifactsDir, "manifest.json")), artifactsDir);

  // every captured interaction record must be mapped: pageId always, domIndex +
  // structural path whenever a dom.json element carries the matching
  // data-cloner-trigger attr (tN marks land before the DOM extractor runs)
  const records = deriveInteractionRecords(artifactsDir);
  const tRec = records.find((r) => /^t\d+$/.test(r.id) && r.kind === "overlay");
  const mRecs = records.filter((r) => /^m\d+$/.test(r.id));
  check("interaction records derived", records.length > 0 && !!tRec,
    `${records.length} record(s): [${records.map((r) => r.id).join(", ")}]`);
  check("every record is page-scoped", records.length > 0 && records.every((r) => typeof r.pageId === "string" && !!r.pageId),
    [...new Set(records.map((r) => r.pageId))].join(", "));
  check("t-record mapped to dom element (domIndex)", !!tRec && typeof tRec.domIndex === "number",
    tRec ? `t=${tRec.id} domIndex=${tRec.domIndex}` : "no t-record");
  check("t-record carries structural path", !!tRec && typeof tRec.path === "string" && tRec.path.includes(":nth-of-type("),
    tRec ? tRec.path : "none");
  check("inner (mN) records derived from captured overlay", mRecs.length >= 1,
    `${mRecs.length} inner record(s)`);

  const res = await reconstructFromArtifacts(artifactsDir, { outDir: artifactsDir + "-project" });
  check("reconstruction ok", res.ok === true, `rounds=${res.report.rounds.length}`);
  const projDir = artifactsDir + "-project";
  const indexHtml = fs.readFileSync(path.join(projDir, "index.html"), "utf8");
  const tid = tRec?.id;
  check("marked element wired with data-cloner-trigger", !!tid && indexHtml.includes(`data-cloner-trigger="${tid}"`), tid || "");
  check("every wired element carries data-replay-id", !!tid && indexHtml.includes(`data-replay-id="${tid}"`), tid || "");

  // ---- 2) drive the generated clone with Playwright ----
  projectServer = await startProjectServer(projDir);
  browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e).slice(0, 120)));
  const clearReplay = () => page.evaluate(() => {
    document.querySelectorAll("[data-cloner-overlay],[data-cloner-module]").forEach((n) => n.remove());
  });
  const overlayState = () => page.evaluate(() => {
    const ov = document.querySelector("[data-cloner-overlay]");
    const mod = document.querySelector("[data-cloner-module]");
    return {
      overlays: document.querySelectorAll("[data-cloner-overlay]").length,
      modules: document.querySelectorAll("[data-cloner-module]").length,
      text: ov ? (ov.innerText || "").slice(0, 200) : "",
      moduleText: mod ? (mod.innerText || "").slice(0, 200) : "",
    };
  });

  await page.goto(projectServer.base + "/index.html", { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(400);

  // A1 — exact marked button opens the picker (not a duplicate)
  await page.click(`[data-replay-id="${tid}"]`);
  await page.waitForTimeout(200);
  let st = await overlayState();
  check("A1 marked button opens the picker overlay", st.overlays === 1 && /Market Analyzer/i.test(st.text),
    `overlays=${st.overlays} text="${st.text.slice(0, 60)}"`);
  const innerEntries = await page.evaluate(() => document.querySelectorAll("[data-cloner-overlay] [data-cloner-inner]").length);
  check("A1 replayed picker carries the captured inner entries", innerEntries >= 3, `${innerEntries} entries`);
  await page.click(`[data-replay-id="${tid}"]`); // click again — must replace, not stack
  await page.waitForTimeout(200);
  st = await overlayState();
  check("A1 re-click does not stack a duplicate overlay", st.overlays === 1, `overlays=${st.overlays}`);

  // A2 — inner entry (mN) inside the replayed overlay → module panel
  await page.click("[data-cloner-overlay] [data-cloner-inner]");
  await page.waitForTimeout(200);
  st = await overlayState();
  check("A2 inner entry opens its captured module panel", st.modules === 1 && /Market Analyzer/i.test(st.moduleText),
    `modules=${st.modules} moduleText="${st.moduleText.slice(0, 60)}"`);
  await clearReplay();

  // A3a — capture-time attr pruned (SPA re-render): data-replay-id resolves
  await page.evaluate((id) => {
    document.querySelector(`[data-replay-id="${id}"]`).removeAttribute("data-cloner-trigger");
  }, tid);
  await page.click(`[data-replay-id="${tid}"]`);
  await page.waitForTimeout(200);
  st = await overlayState();
  check("A3a data-replay-id resolves without the trigger attr", st.overlays === 1 && /Market Analyzer/i.test(st.text),
    `overlays=${st.overlays}`);
  await clearReplay();

  // A3b — pure structural: no attrs, no label, no text → only rec.path can match
  const markedBox = await page.locator(`[data-replay-id="${tid}"]`).boundingBox();
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-replay-id="${id}"]`);
    el.removeAttribute("data-replay-id");
    el.removeAttribute("aria-label");
  }, tid);
  await page.mouse.click(markedBox.x + markedBox.width / 2, markedBox.y + markedBox.height / 2);
  await page.waitForTimeout(200);
  st = await overlayState();
  check("A3b structural DOM path resolves an attr-less, label-less click", st.overlays === 1 && /Market Analyzer/i.test(st.text),
    `overlays=${st.overlays} (no attribute or text signal remained)`);
  await clearReplay();

  // A4 — duplicate-button ambiguity: a decoy record with the SAME text signature
  // but a DIFFERENT structural path must win for its twin, while the real button
  // still resolves to the real record — structural beats text
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.evaluate(injectDup);
  const dupPath = await page.evaluate(replicaPath, await page.$('[data-test-dup="1"]'));
  check("A4 duplicate twin got a distinct structural path", typeof dupPath === "string" && /div\.btn:nth-of-type\(2\)$/.test(dupPath) && tRec.path !== dupPath,
    dupPath || "none");

  const rtSrc = fs.readFileSync(path.join(projDir, "runtime", "interactions.js"), "utf8");
  const dataStart = rtSrc.indexOf("= ", rtSrc.indexOf("window.__CLONER_INTERACTIONS")) + 2;
  const dataEnd = rtSrc.indexOf(";\n", dataStart);
  const rtRecords = JSON.parse(rtSrc.slice(dataStart, dataEnd));
  rtRecords.push({
    id: "tdecoy", kind: "overlay", text: "Add module", page: "index.html", path: dupPath,
    html: '<div style="padding:24px;font:14px system-ui">DECOY-PICKER</div>',
    box: { x: 40, y: 120, w: 260, h: 160 },
  });
  projectServer.setRuntimePatch(buildRuntime(rtRecords));
  await page.reload({ waitUntil: "load" }); // runtime re-parses DATA with the decoy
  await page.waitForTimeout(400);
  await page.evaluate(injectDup);
  await page.click('[data-test-dup="1"]');
  await page.waitForTimeout(200);
  st = await overlayState();
  check("A4 duplicate resolves to the structural (decoy) record, not the text match",
    st.overlays === 1 && /DECOY-PICKER/i.test(st.text) && !/Market Analyzer/i.test(st.text),
    `overlays=${st.overlays} text="${st.text.slice(0, 40)}"`);
  await page.click(`[data-cloner-trigger="${tid}"]`); // the real button still hits the real record
  await page.waitForTimeout(200);
  st = await overlayState();
  check("A4 real marked button still resolves to the real record", st.overlays === 1 && /Market Analyzer/i.test(st.text),
    `overlays=${st.overlays}`);
  await clearReplay();

  // A5 — text signature as LAST resort: structural identity broken (first class
  // renamed → path differs), attrs gone — the label still replays the record
  projectServer.setRuntimePatch(null);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const el = document.querySelector('[aria-label="Add module"]');
    el.setAttribute("class", el.className.replace(/(^|\s)btn(\s|$)/, "$1btnx$2")); // breaks div.btn:… path, keeps .cx-N layout
    el.removeAttribute("data-cloner-trigger");
    el.removeAttribute("data-replay-id");
  });
  await page.click('[aria-label="Add module"]');
  await page.waitForTimeout(200);
  st = await overlayState();
  check("A5 text signature replays when no attr and no structural path match",
    st.overlays === 1 && /Market Analyzer/i.test(st.text), `overlays=${st.overlays}`);

  check("no runtime page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (e) {
  check("no unexpected crash", false, String(e?.stack || e).split("\n").slice(0, 3).join(" | "));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (projectServer) await projectServer.close().catch(() => {});
  if (fixtureServer) await fixtureServer.close().catch(() => {});
}
const fails = results.filter((r) => !r).length;
console.log(`\n${fails ? "RESULT: FAIL" : "RESULT: PASS"}  (${results.length - fails}/${results.length})`);
process.exit(fails ? 1 : 0);
