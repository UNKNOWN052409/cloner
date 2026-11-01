// Application state builder (task 3.5.3, step 2): turns captured application
// state (exploration/application-state-capture.js fixtures) into a generated
// runtime that restores URL-driven state, nested navigation state and supported
// persistence in the reconstructed clone.
//
// What the runtime does (all evidence-driven, no app-specific assumptions):
//   1. DEEP LINKS: a captured deep-link hash (#/items?view=active with
//      hashQuery) is replayed as an on-load URL restore — when the page loads
//      WITHOUT its hash state, the runtime writes the captured hash/query back
//      (history.replaceState + hashchange dispatch). Direct URL loading and
//      browser back/forward then behave like the original.
//   2. NESTED STATE: the LAST captured probe (app debug API or marked controls)
//      records the observed combination (cat/sort/page/view in the fixture). On
//      load the runtime drives the clone's own controls — clicks buttons with
//      the captured label/value and sets select values — so nested state comes
//      back through the clone's real handlers, not by overwriting text.
//   3. PERSISTENCE: captured localStorage/sessionStorage entries are written
//      back on load (absent entries are NOT recreated — honest absence).
//   4. PRECEDENCE (from observed original behavior — the risk note's stale/
//      contradictory-state guard): URL state wins over storage state; the
//      explicit storage map only fills keys URL restore does not own.
//
// Runtime output: runtime/app-state.js — an inert-on-empty ES5 IIFE in the
// pattern of src/runtimeTemplate.js / responsive-analyzer.bootstrapScript.
//
// Integration hook (reconstruction-pipeline.js, applied by the integration
// agent — one call after the round loop, additive):
//   import { buildAppStatePlan, augmentProjectWithAppState } from "./application-state-builder.js"; // task 3.5.3
//   report.appState = summarizeAppStatePlan(plan);
//   report.appStateAugmentation = augmentProjectWithAppState(outDir, plan, { pages: genFiles });
import fs from "node:fs";
import path from "node:path";
import { parseStateUrl, appStateFingerprint } from "../exploration/application-state-capture.js";
import { stableStringify } from "../exploration/websocket-session-capture.js";

export const APP_STATE_RUNTIME_FILE = "runtime/app-state.js";

// ---------- analysis ----------

// buildAppStatePlan(artifactsDir, opts) →
// { ok, sources: { deepLinks, controls, storage }, deepLinks, controls, storage,
//   notes } — a pure analysis of pages/*/application-state.json. Empty sources
//   → ok:true with everything empty (the runtime is a no-op; uncertainty stays
//   honest instead of fabricated).
export function buildAppStatePlan(artifactsDir, opts = {}) {
  const notes = [];
  const pagesRoot = path.join(artifactsDir, "pages");
  let pageDirs = [];
  try {
    pageDirs = fs.readdirSync(pagesRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return emptyPlan("no pages/ directory under artifacts");
  }

  const deepLinks = [];  // [{ url: {pathname,search,hashPath,hashQuery}, hash, query, probe, source }]
  const controls = [];   // [{ id, cls, tag, value, checked }]
  const storage = { localStorage: {}, sessionStorage: {} }; // last-wins merged maps
  let controlCount = 0;

  for (const pageId of pageDirs) {
    const fixturePath = path.join(pagesRoot, pageId, "application-state.json");
    let fixture = null;
    try { fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")); } catch { continue; }
    if (!fixture || !Array.isArray(fixture.states)) { notes.push(`${pageId}: application-state.json malformed — skipped`); continue; }
    for (const st of fixture.states) {
      if (st.kind === "error") continue;
      // URL state: only states that actually CARRY state in the URL are
      // deep-link candidates (a bare pathname is a route, not app state)
      const parsed = parseStateUrl(st.url);
      if (parsed) {
        const hasHashQuery = Object.keys(parsed.hashQuery || {}).length > 0;
        const hasSearch = Object.keys(queryOf(parsed.search) || {}).length > 0;
        if (hasHashQuery || hasSearch) {
          deepLinks.push({
            source: pageId,
            phase: st.phase || null,
            fingerprint: appStateFingerprint(st),
            url: { pathname: parsed.pathname, search: parsed.search, hashPath: parsed.hashPath, hashQuery: parsed.hashQuery },
            hash: hashOf(st.url),
            query: parsed.search,
            probe: st.probe || null,
          });
        }
      }
      // nested controls: marked inputs/selects observed in ANY state.
      // LAST observation wins per id — the same last-wins rule storage uses:
      // restore means "where the captured session ended", not its start.
      for (const c of Array.isArray(st.controls) ? st.controls : []) {
        if (!c || typeof c !== "object" || !c.id) continue;
        const existing = controls.find((x) => x.id === c.id);
        if (existing) {
          existing.tag = String(c.tag || existing.tag).slice(0, 20);
          existing.cls = c.cls ?? existing.cls;
          existing.value = c.value ?? existing.value;
          existing.checked = !!c.checked;
          continue;
        }
        controls.push({ id: String(c.id).slice(0, 60), tag: String(c.tag || "input").slice(0, 20), cls: c.cls || null, value: c.value ?? null, checked: !!c.checked });
      }
      controlCount++;
      // persistence: merge storage (later pages win — last observed state);
      // absent/redacted entries are skipped (honest absence, never fabricated)
      for (const ns of ["localStorage", "sessionStorage"]) {
        const entries = st.storage?.[ns] || {};
        for (const [k, v] of Object.entries(entries)) {
          if (!v || typeof v !== "object" || v.absent || v.redacted) continue;
          if (v.t === "string" && typeof v.v === "string") storage[ns][k] = v.v;
          else if (v.t === "number" && typeof v.v === "number") storage[ns][k] = String(v.v);
          else if (v.t === "boolean") storage[ns][k] = v.v ? "true" : "false";
          // truncated values are shape-only — never written back
        }
      }
    }
  }
  if (!controlCount && !deepLinks.length) notes.push("no application-state captures found — runtime will be a no-op");
  if (!deepLinks.length) notes.push("no URL-carried state observed — deep-link restore disabled");
  const storageKeys = Object.keys(storage.localStorage).length + Object.keys(storage.sessionStorage).length;
  if (!storageKeys) notes.push("no replayable storage entries captured — persistence restore disabled");
  if (opts.maxDeepLinks) deepLinks.splice(opts.maxDeepLinks);
  return {
    ok: true,
    sources: { deepLinks: deepLinks.length, controls: controls.length, storage: storageKeys, pages: pageDirs.length },
    deepLinks,
    controls,
    storage,
    notes,
  };
}

function emptyPlan(why) {
  return { ok: false, why, sources: { deepLinks: 0, controls: 0, storage: 0, pages: 0 }, deepLinks: [], controls: [], storage: { localStorage: {}, sessionStorage: {} }, notes: [why] };
}

function hashOf(url) {
  try { return new URL(String(url)).hash || ""; } catch { return ""; }
}

function queryOf(search) {
  try { return Object.fromEntries(new URLSearchParams(search)); } catch { return null; }
}

// deep links with BOTH a hash query and a matching probe are the strongest
// evidence (the app demonstrably routes state through the URL); probes without
// one degrade to control restore only.
export function primaryDeepLink(plan) {
  return (plan?.deepLinks || []).find((d) => d.hash && Object.keys(d.url.hashQuery || {}).length && d.probe) || (plan?.deepLinks || [])[0] || null;
}

// summarizeAppStatePlan(plan) → the reconstruction-report block.
export function summarizeAppStatePlan(plan) {
  if (!plan) return { ok: false, why: "no plan" };
  return {
    ok: plan.ok,
    deepLinks: plan.sources.deepLinks,
    controls: plan.sources.controls,
    storageKeys: plan.sources.storage,
    pagesScanned: plan.sources.pages,
    notes: plan.notes.slice(0, 6),
  };
}

// ---------- runtime ----------

// buildAppStateRuntime(plan) → runtime/app-state.js source. Empty plan → a
// documented no-op (the file is still emitted so the wiring never 404s).
export function buildAppStateRuntime(plan) {
  const deep = primaryDeepLink(plan);
  const controls = (plan?.controls || []).slice(0, 24);
  const storage = plan?.storage || { localStorage: {}, sessionStorage: {} };
  const payload = {
    schema: "1.0.0",
    hash: deep?.hash || "",
    query: deep?.query || "",
    controls,
    storage: {
      localStorage: Object.fromEntries(Object.entries(storage.localStorage || {}).slice(0, 24)),
      sessionStorage: Object.fromEntries(Object.entries(storage.sessionStorage || {}).slice(0, 24)),
    },
  };
  return `// runtime/app-state.js — application-state reconstruction bootstrap (task 3.5.3).
// Restores captured URL state (deep-link hash/query), nested control state and
// localStorage/sessionStorage persistence. Evidence-derived only: empty payload
// = inert. Precedence from observed original behavior: URL state wins; storage
// fills only what the URL restore does not own. Generated by
// src/reconstruction/application-state-builder.js.
(function () {
  var D = ${JSON.stringify(payload)};
  var applied = { url: false, controls: 0, storage: 0 };

  // ---- 3) persistence first (URL restore may legitimately overwrite these)
  try {
    var ns, k;
    for (k in D.storage.localStorage) { try { localStorage.setItem(k, D.storage.localStorage[k]); applied.storage++; } catch (e) {} }
    for (k in D.storage.sessionStorage) { try { sessionStorage.setItem(k, D.storage.sessionStorage[k]); applied.storage++; } catch (e) {} }
  } catch (e) {}

  // ---- 1) URL state: deep-link restore when the page loads bare
  try {
    if (D.hash || D.query) {
      var bare = !location.hash && !location.search;
      if (bare) {
        var q = D.query && location.search !== D.query ? D.query : "";
        var h = D.hash && location.hash !== D.hash ? D.hash : "";
        if (q || h) {
          history.replaceState(null, "", location.pathname + q + h);
          applied.url = true;
          // SPA apps listen for hashchange — notify AFTER the URL is in place
          if (h) { try { window.dispatchEvent(new HashChangeEvent("hashchange")); } catch (e) {} }
        }
      }
    }
  } catch (e) {}

  // ---- 2) nested control state: drive the clone's own controls by id/value
  // (delayed one task: SPA renderers may rebuild controls after load)
  function restoreControls() {
    try {
      for (var i = 0; i < D.controls.length; i++) {
        var c = D.controls[i];
        if (!c.id) continue;
        var el = document.getElementById(c.id);
        if (!el) continue;
        if (c.tag === "select" && typeof c.value === "string") {
          var has = false;
          for (var oi = 0; oi < el.options.length; oi++) if (el.options[oi].value === c.value) { has = true; break; }
          if (has && el.value !== c.value) { el.value = c.value; el.dispatchEvent(new Event("change", { bubbles: true })); applied.controls++; }
        } else if (c.tag === "input" && (c.type === "checkbox" || c.type === "radio")) {
          if (el.checked !== !!c.checked) { el.checked = !!c.checked; el.dispatchEvent(new Event("change", { bubbles: true })); applied.controls++; }
        }
      }
    } catch (e) {}
    if (window.__APP_STATE_APPLIED === undefined) window.__APP_STATE_APPLIED = applied;
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", restoreControls);
  else setTimeout(restoreControls, 0);
})();`;
}

// ---------- augmentation ----------

// augmentProjectWithAppState(outDir, plan, opts) — one-call hook for
// reconstructFromArtifacts: writes runtime/app-state.js and links it in the
// generated pages. Returns { applied, runtimeFile, linked, files, notes }.
export function augmentProjectWithAppState(outDir, plan, opts = {}) {
  const notes = [];
  const result = { applied: false, runtimeFile: APP_STATE_RUNTIME_FILE, linked: 0, files: [], notes };
  const pages = (opts.pages && opts.pages.length ? opts.pages : ["index.html"]).filter((p) => typeof p === "string");
  try { fs.mkdirSync(path.join(outDir, "runtime"), { recursive: true }); } catch (e) { notes.push("runtime dir: " + String(e?.message || e).slice(0, 60)); }
  const src = buildAppStateRuntime(plan);
  fs.writeFileSync(path.join(outDir, APP_STATE_RUNTIME_FILE), src);
  result.applied = true;
  const tag = '<script src="' + APP_STATE_RUNTIME_FILE + '"></script>';
  for (const rel of pages) {
    const fp = path.join(outDir, rel);
    if (!fs.existsSync(fp)) continue;
    let html = fs.readFileSync(fp, "utf8");
    if (html.includes(tag)) {
      // idempotent re-application (the pipeline may already have linked this
      // runtime): the page still ENDS UP linked, so it counts
      result.linked++;
      result.files.push(rel);
      continue;
    }
    if (html.includes('<script src="runtime/interactions.js"></script>')) {
      html = html.replace('<script src="runtime/interactions.js"></script>', '<script src="runtime/interactions.js"></script>\n  ' + tag);
    } else if (html.includes("</body>")) {
      html = html.replace("</body>", "  " + tag + "\n</body>");
    } else { notes.push(rel + ": no script/body anchor — not linked"); continue; }
    fs.writeFileSync(fp, html);
    result.linked++;
    result.files.push(rel);
  }
  if (result.linked === 0) notes.push("app-state runtime not linked into any page");
  return result;
}

// Deterministic serialization of a plan (reports/tests).
export function planToJson(plan) {
  return stableStringify({
    ok: plan.ok,
    sources: plan.sources,
    deepLinks: (plan.deepLinks || []).map((d) => ({ hash: d.hash, query: d.query, phase: d.phase, url: d.url })),
    controls: plan.controls,
    storage: plan.storage,
    notes: plan.notes,
  });
}
