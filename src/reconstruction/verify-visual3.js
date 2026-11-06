// Stage-2 OPTIMIZATION & COMPLETENESS engine (split from verify.js, file-size
// cap): required artifacts, exploration/replay data gates, asset weight and
// render performance — moved verbatim; verifyTask in verify.js drives it.
import fs from "node:fs";
import path from "node:path";
import { launchBrowser } from "../browser.js";
import { parseRuntimeRecords } from "./verify-visual.js";

// ================================================== STEP 2 — OPTIMIZATION & COMPLETENESS
const REQUIRED_ARTIFACTS = [
  { file: "index.html", label: "static clone page" },
  { file: "clone.json", label: "run metadata" },
  { file: "snapshot.mhtml", label: "exact rendered capture" },
  { file: "exploration.json", label: "interaction exploration" },
  { file: "design-tokens.json", label: "measured design tokens" },
  { file: "cloner-runtime.js", label: "interaction replay runtime" },
];
// v2 reconstruction contract: editable project tree + pipeline artifacts
const REQUIRED_ARTIFACTS_V2 = [
  { file: "index.html", label: "static clone page" },
  { file: "styles/tokens.css", label: "design tokens stylesheet" },
  { file: "styles/layout.css", label: "layout stylesheet" },
  { file: "styles/components.css", label: "component stylesheet" },
  { file: "runtime/interactions.js", label: "interaction replay runtime" },
];

export async function stage2Optimization(out, task = null, artifactsDir = null) {
  const checks = [];
  const required = artifactsDir ? REQUIRED_ARTIFACTS_V2 : REQUIRED_ARTIFACTS;
  const b = await launchBrowser({ headless: true });
  let loadMs = null;
  try {
    const t0 = Date.now();
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await p.goto("file:///" + path.join(out, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: 30000 });
    loadMs = Date.now() - t0;
    await p.close();
  } catch {}
  await b.close().catch(() => {});

  // asset weight by type (v1: assets/ · v2: public/assets/). The v2 project
  // layout writes assets FLAT under public/assets/ (reconstruction-pipeline.js
  // asset copy: "public/assets/" + basename), so the old single-level walk —
  // which only counted first-level DIRECTORIES — reported 0 files on a
  // 201-asset job. Recursive walk instead: every regular file under the root
  // counts, grouped by its first path segment (nested groups keep per-group
  // weights, flat files group as "(root)").
  const weights = {};
  let totalBytes = 0, totalFiles = 0;
  const assetsDir = artifactsDir ? path.join(out, "public", "assets") : path.join(out, "assets");
  const walkAssets = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walkAssets(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      const size = (fs.statSync(p) || { size: 0 }).size;
      const segs = path.relative(assetsDir, p).split(path.sep);
      const top = segs.length > 1 ? segs[0] : "(root)";
      const w = weights[top] || (weights[top] = { files: 0, kb: 0 });
      w.files++; w.kb += Math.round(size / 1024);
      totalBytes += size; totalFiles++;
    }
  };
  walkAssets(assetsDir);

  // completeness: required artifacts (v2 also requires pipeline-level artifacts
  // in the artifacts dir: exploration manifest + measured tokens + the report)
  const missingArtifacts = required.filter((a) => !fs.existsSync(path.join(out, a.file)));
  if (artifactsDir) {
    for (const a of [{ file: "manifest.json", label: "exploration manifest" }, { file: "design-tokens.json", label: "measured design tokens" }]) {
      if (!fs.existsSync(path.join(artifactsDir, a.file))) missingArtifacts.push(a);
    }
  }
  checks.push({
    name: "required artifacts complete",
    ok: missingArtifacts.length === 0,
    detail: missingArtifacts.length ? `missing: ${missingArtifacts.map((m) => m.label + " (" + m.file + ")").join(", ")}` : `all ${required.length} present`,
  });

  // completeness: exploration coverage + replay data (v1: exploration.json in
  // the clone dir · v2: exploration.json in the artifacts dir)
  const { records, error } = parseRuntimeRecords(out);
  let behaviors = 0, explMissing = false;
  const explFile = artifactsDir ? path.join(artifactsDir, "exploration.json") : path.join(out, "exploration.json");
  try { behaviors = (JSON.parse(fs.readFileSync(explFile, "utf8")).behaviors || []).length; } catch { explMissing = true; }
  // workspace parity (G4.2, evidence-gated FAIL-CLOSED): dock-native app pages
  // legitimately record ZERO overlay behaviors — their controls (tabs/splitters/
  // close/collapse) belong to the workspace runtime, and the explorer's
  // exploration.json only carries overlay records (src/interactions.js:766-768).
  // When ALL of the following evidence is present, the documented dock coverage
  // (manifest statesRecorded) counts toward completeness; any missing/weak
  // evidence keeps today's strict gate. The existing overlay path above is
  // byte-identical — this branch only adds the workspace evidence source.
  let workspaceEvidence = null;
  if (explMissing && artifactsDir) {
    try {
      const wsCss = fs.existsSync(path.join(out, "styles", "workspace.css"));
      const wsRuntime = /__CLONER_WORKSPACE_RUNTIME__/.test(fs.readFileSync(path.join(out, "runtime", "interactions.js"), "utf8"));
      const summary = JSON.parse(fs.readFileSync(path.join(artifactsDir, "reports", "exploration-summary.json"), "utf8"));
      const manifest = JSON.parse(fs.readFileSync(path.join(artifactsDir, "manifest.json"), "utf8"));
      const statesRecorded = Number((manifest.coverage || {}).statesRecorded) || 0;
      if (wsCss && wsRuntime && summary.status === "completed" && (summary.errors || []).length === 0 && statesRecorded > 0) {
        behaviors += statesRecorded;
        workspaceEvidence = `workspace runtime owns the dock controls (styles/workspace.css + __CLONER_WORKSPACE_RUNTIME__): ${statesRecorded} recorded dock state(s) from reports/exploration-summary.json (status completed, 0 errors), no overlay behaviors to explore`;
        explMissing = false;
      }
    } catch { /* weak/missing evidence → keep the strict gate below */ }
  }
  // G4.1 self-reverse: control-free SOURCE pages. A static page with zero
  // interactive controls (example.com, a plain document) legitimately produces
  // no exploration.json — the explorer sampled every page and recorded nothing
  // (src/interactions.js writes the behavior report only when behaviors.length
  // > 0). Stage 1 already treats "no recorded interactions on this page" as a
  // pass; this branch gives stage 2 the same honest treatment for that one
  // shape, evidenced by manifest.pages[].records === 0 on EVERY explored page
  // (the explorer's own per-page capture counts). Strict default preserved:
  // without CLONER_VERIFY_REQUIRE_INTERACTIONS=0 the gate is byte-identical to
  // the overlay/workspace paths above — real app clones still need behavior +
  // replay data.
  let controlFreeEvidence = null;
  if (explMissing && artifactsDir) {
    try {
      const man = JSON.parse(fs.readFileSync(path.join(artifactsDir, "manifest.json"), "utf8"));
      if (Array.isArray(man.pages) && man.pages.length > 0 && man.pages.every((p) => (p.records || 0) === 0)) {
        controlFreeEvidence = `source pages carry zero interactive controls — the explorer sampled ${man.pages.length} page(s) and recorded no interactions to document or replay`;
      }
    } catch { /* no/invalid manifest → keep the strict gate */ }
  }
  // SPA state depth (state-discovery.js enumerateInAppStates): authed shells
  // legitimately record ZERO overlay behaviors — their view switches are
  // in-app tab/nav clicks that keep the URL put, documented as url#state
  // states (status "in-url") in graph/states.json and as page-level entries in
  // manifest.pages. When the evidence is REAL — every in-URL state carries an
  // existing domRef artifact — those documented states count toward
  // completeness. Fail-closed like the branches above: no graph, no in-url
  // nodes, or one missing dom artifact keeps the strict gate.
  let inUrlEvidence = null;
  if (!explMissing && behaviors === 0) {
    try {
      const graphRoot = artifactsDir || out;
      const gs = JSON.parse(fs.readFileSync(path.join(graphRoot, "graph", "states.json"), "utf8"));
      const inUrl = (gs.nodes || []).filter((n) => n && n.status === "in-url");
      const evidenced = inUrl.filter((n) => n.domRef && fs.existsSync(path.join(graphRoot, n.domRef)));
      if (inUrl.length > 0 && evidenced.length === inUrl.length) {
        behaviors += inUrl.length;
        inUrlEvidence = `${inUrl.length} in-URL view state(s) documented (url#state page entries, dom evidence on disk)`;
      }
    } catch { /* no/invalid graph → keep the strict gate */ }
  }
  const requireInteractions = process.env.CLONER_VERIFY_REQUIRE_INTERACTIONS !== "0";
  const controlFreePass = controlFreeEvidence !== null && !requireInteractions;
  // The workspace parity branch also covers the "replayable records" half: a
  // dock-native page records ZERO overlay replay records by construction (the
  // explorer's own summary documents interactions: 0), and the clone's replay
  // engine for its controls is the workspace runtime itself — which the
  // evidence gate above already verified is present. Same fail-closed gate:
  // without the full workspace evidence, records.length > 0 stays required.
  const workspacePass = workspaceEvidence !== null;
  checks.push({
    name: "exploration + replay data complete",
    // Boolean(): the || chain must not leak the evidence STRING into ok (JSON
    // consumers check ok === true / !ok — a truthy string breaks the former)
    ok: Boolean((!explMissing && behaviors > 0 && (records.length > 0 || workspacePass || inUrlEvidence)) || controlFreePass),
    detail: controlFreePass ? `0 interactive controls on the source — nothing to explore or replay (${controlFreeEvidence})` : workspacePass
      ? `${behaviors} documented behaviors, ${records.length} overlay replay record(s) — ${workspaceEvidence}; dock controls replay via the workspace runtime`
      : inUrlEvidence
        ? `${behaviors} documented behaviors, ${records.length} overlay replay record(s) — ${inUrlEvidence}; view switches replay via their url#state pages`
        : explMissing ? "exploration.json missing" : `${behaviors} documented behaviors, ${records.length} replayable records`,
  });

  // no unnecessary elements: dead trigger attrs (no runtime record) + empty modules
  let html = "";
  try { html = fs.readFileSync(path.join(out, "index.html"), "utf8"); } catch {}
  const htmlTriggers = [...html.matchAll(/data-cloner-trigger="(t\d+)"/g)].map((m) => m[1]);
  const recordIds = new Set(records.map((r) => r.id));
  const deadAttrs = htmlTriggers.filter((id) => !recordIds.has(id));
  const emptyModules = records.filter((r) => r.kind === "module" && (!r.html || r.html.length < 50)).length;
  checks.push({
    name: "no unnecessary/dead elements",
    ok: deadAttrs.length === 0 && emptyModules === 0,
    detail: `${deadAttrs.length} dead trigger attrs, ${emptyModules} empty module records`,
  });

  // performance: clone must render fast and stay lean (budgets generous for app clones)
  checks.push({ name: "clone render performance", ok: loadMs !== null && loadMs < 8000, detail: loadMs !== null ? `renders in ${loadMs}ms (budget 8s)` : "render failed" });
  checks.push({ name: "asset weight", ok: totalBytes < 120 * 1024 * 1024, detail: `${totalFiles} files, ${(totalBytes / 1024 / 1024).toFixed(1)}MB total (${Object.entries(weights).map(([k, v]) => `${k}:${v.files}`).join(", ")})` });

  // task requirements actually carried: read the blueprint.json the
  // reconstruction wrote (src/reconstruction/blueprint.js:218) and verify the
  // instruction text survived into it — the old check echoed the raw
  // instruction string with a hard-coded ok:true and proved nothing.
  if (task?.instructions) {
    const bpFile = path.join(artifactsDir || out, "blueprint.json");
    let bp = null, bpErr = null;
    try { bp = JSON.parse(fs.readFileSync(bpFile, "utf8")); } catch (e) { bpErr = e.message.slice(0, 60); }
    const carried = !!bp && String(bp.instructions?.raw || "").trim().length > 0;
    const sc = bp?.instructions?.scope || {};
    checks.push({
      name: "task instructions carried",
      ok: carried,
      detail: carried
        ? `blueprint.json instructions.applied=${!!bp.instructions.applied}, scope include:${(sc.include || []).length} exclude:${(sc.exclude || []).length} notes:${(sc.notes || []).length} — "${String(bp.instructions.raw).slice(0, 80)}"`
        : bpErr ? `blueprint.json unreadable (${bpErr}) — instructions not verifiably carried`
        : "blueprint.json missing — instructions not verifiably carried",
    });
  }

  return {
    stage: "optimization-completeness",
    passed: checks.every((c) => c.ok),
    checks,
    metrics: { loadMs, totalFiles, totalMB: +(totalBytes / 1024 / 1024).toFixed(1), weights, behaviors, records: records.length, deadAttrs: deadAttrs.length },
  };
}
