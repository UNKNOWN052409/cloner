// Clone blueprint — the fidelity contract between exploration evidence and
// reconstruction. Converts recorded artifacts + the user's instructions into
// the structured plan the engine must honor (and verification can check later).
//
// Ported methodology (external skill research, 2026-11-05 — deterministic,
// no AI dependency):
//   • evidence ledger with observed / inferred / substituted statuses and the
//     rule "record unknowns instead of inventing certainty"
//     (github.com/atharvsinh-codez/skills — design-to-code/references/reference-forensics.md)
//   • the fidelity contract as a build gate + the ambiguity resolution order
//     (same source: forensics exit gate)
//   • interaction-model-before-building: click / scroll / hover / time is
//     identified explicitly, never assumed
//     (github.com/nelakay/ai-website-cloner-claudeskill — SKILL.md §6)
//   • deterministic scope extraction from user instructions over defaults
//     (same source: Scope Defaults)
//   • detected stack → output-framework recommendation honoring the user's
//     preference (same source: Technical Stack Analysis)
//
// Deterministic and local-first: reads artifacts only, writes one file
// (blueprint.json), never touches the network. blueprint.json is the record
// the realignment spec's canonical Understanding Record expects.
import fs from "node:fs";
import path from "node:path";

// ---------- instruction parsing (deterministic scope extraction) ----------

const INCLUDE_RE = /\b(only|just|sirf|only clone|limit to|restrict to)\b\s*[^.;\n]*/gi;
const EXCLUDE_RE = /\b(exclude|skip|without|ignore|no need for|do not clone|don't clone|not the)\b\s*[^.;\n]*/gi;

/** Split instruction text into clauses, then bucket them include / exclude / note. */
export function parseInstructions(raw) {
  const text = String(raw || "").trim();
  const scope = { include: [], exclude: [], notes: [] };
  if (!text) return { raw: text, applied: false, scope };
  const clauses = text.split(/[;\n]+|(?<=\.)\s+/).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    const inc = clause.match(INCLUDE_RE);
    const exc = clause.match(EXCLUDE_RE);
    if (inc) scope.include.push(...inc.map((s) => s.trim().slice(0, 160)));
    else if (exc) scope.exclude.push(...exc.map((s) => s.trim().slice(0, 160)));
    else scope.notes.push(clause.slice(0, 160));
  }
  return { raw: text, applied: scope.include.length > 0 || scope.exclude.length > 0, scope };
}

// ---------- stack detection (Technical Stack Analysis, ported) ----------

const STACK_SIGNALS = [
  ["nextjs", /\/_next\/|__NEXT_DATA__|next-image/i],
  ["nuxt", /\/_nuxt\/|__NUXT__/i],
  ["angular", /ng-version|ng-app|angular\.min\.js/i],
  ["react", /data-reactroot|react(-dom)?[-.]production|__REACT_DEVTOOLS/i],
  // bundle-level markers: SPA frameworks name their chunks/scripts even when
  // the sampled DOM carries no framework attrs (measured on trader.tradovate.com
  // — react chunks + vite/webpack fingerprints live in script/asset URLs)
  ["react", /\breact(-dom)?[-_.@][0-9a-z~]|react-dom\.client|react-router|jsx-runtime|@react/i],
  ["vue", /vue(\.runtime)?\.[a-z]+\.(js|mjs)|\/vue[.-]|__VUE__|data-v-[0-9a-f]{6,}/i],
  ["vite", /vite\/modulepreload-polyfill|__vite__|vite\.preload|\/assets\/(index|vendor)-[0-9a-f]{8}\.js/i],
  ["webpack", /webpack(chunk|Runtime|jsonP)?[-_.]|__webpack_require__|webpack-[0-9a-f]{6,}/i],
  ["svelte", /class=["'][^"']*svelte-[a-z0-9]{4,}/i],
  ["wordpress", /wp-content|wp-includes|wp-json/i],
  ["shopify", /cdn\.shopify\.com|shopify-section|Shopify\.theme/i],
  ["wix", /wix(static|\.com)|wix-code/i],
  ["squarespace", /squarespace|static1\.sqspcdn/i],
  ["webflow", /w-(nav|container|button|section|col|row)[\s"']/i],
  ["bootstrap", /col-(md|sm|lg|xl)-|btn-(primary|secondary|success)/i],
  ["tailwind", /\b(flex|grid)\b[^"']*\b(items-center|justify-between|gap-\d)/i],
  ["gsap", /gsap|TweenMax/i],
  ["swiper", /swiper-(container|slide|wrapper)/i],
  ["smooth-scroll", /lenis|locomotive-scroll|smooth-scroll/i],
];

/** Scan URLs + sampled element attributes for framework vocabulary. */
export function detectStack(artifactsDir, manifest) {
  const haystacks = [];
  const urls = [manifest?.originalUrl, ...(manifest?.pages || []).map((p) => p?.url)].filter(Boolean);
  haystacks.push(...urls);
  const pagesDir = path.join(artifactsDir, "pages");
  let pageIds = [];
  try { pageIds = fs.readdirSync(pagesDir).slice(0, 5); } catch { /* no pages dir */ }
  for (const pid of pageIds) {
    try {
      const dom = JSON.parse(fs.readFileSync(path.join(pagesDir, pid, "dom.json"), "utf8"));
      for (const el of (dom.elements || []).slice(0, 300)) {
        if (el.cls) haystacks.push(String(el.cls));
        if (el.src) haystacks.push(String(el.src));
        if (el.href) haystacks.push(String(el.href));
      }
    } catch { /* malformed page — skip */ }
  }
  const hay = haystacks.join(" \n ");
  const detected = STACK_SIGNALS.filter(([, re]) => re.test(hay)).map(([name]) => name);
  return { detected, scannedUrls: urls.length, scannedPages: pageIds.length };
}

// ---------- region classification (observed, from dom.json) ----------

const REGION_RULES = [
  ["header", (el) => el.tag === "header" || /^header|topbar|navbar|site-header$/i.test(el.cls || "")],
  ["navigation", (el) => el.tag === "nav" || /^nav|main-nav|sidebar-nav/i.test(el.cls || "")],
  ["footer", (el) => el.tag === "footer" || /footer$/i.test(el.cls || "")],
  ["hero", (el) => /hero|banner|jumbotron/i.test(el.cls || "") || (el.tag === "h1" && (el.rect?.y ?? 999) < 400)],
  ["sidebar", (el) => /sidebar|aside|panel-left/i.test(el.cls || "") || (el.layout?.position === "sticky" && (el.rect?.w ?? 0) < 500)],
];

function classifyRegions(elements) {
  const regions = [];
  for (const [name, test] of REGION_RULES) {
    const hit = (elements || []).find(test);
    if (hit) regions.push({ region: name, selectorHint: `${hit.tag}${hit.cls ? "." + String(hit.cls).split(/\s+/)[0] : ""}`, evidence: "observed" });
  }
  return regions;
}

// ---------- interaction model (identify before building) ----------

function inferInteractionModel(artifactsDir, manifest) {
  const out = { model: "unknown", evidence: "inferred", triggers: 0, stateNodes: 0, scrollHints: 0 };
  try {
    const states = JSON.parse(fs.readFileSync(path.join(artifactsDir, "graph", "states.json"), "utf8"));
    out.stateNodes = (states.nodes || []).length;
  } catch { /* optional artifact */ }
  try {
    const routes = JSON.parse(fs.readFileSync(path.join(artifactsDir, "graph", "routes.json"), "utf8"));
    for (const r of routes.routes || []) {
      if (/scroll|intersection|lazy/i.test(JSON.stringify(r.reasons || []) + " " + (r.via || ""))) out.scrollHints++;
    }
  } catch { /* optional artifact */ }
  for (const p of manifest?.pages || []) out.triggers += Number(p?.records) || 0;
  if (out.triggers > 0) { out.model = "click-driven"; out.evidence = "observed"; }
  else if (out.stateNodes > 1 || out.scrollHints > 0) { out.model = "scroll/state-driven"; out.evidence = "observed"; }
  return out;
}

// ---------- the blueprint (fidelity contract) ----------

/**
 * Build the clone blueprint from recorded evidence + user instructions.
 * @param {string} artifactsDir  exploration artifacts root for one job
 * @param {object} [opts]
 * @param {string} [opts.instructions]          raw user instructions ("" when none)
 * @param {string|null} [opts.frameworkPreference]  user's output-framework choice
 * @returns {{ ok: boolean, why?: string, blueprint?: object, warnings: string[] }}
 */
export function buildBlueprint(artifactsDir, { instructions = "", frameworkPreference = null } = {}) {
  const warnings = [];
  const manifestPath = path.join(artifactsDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return { ok: false, why: "manifest.json missing — not an exploration artifact dir", warnings: [] };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch (e) { return { ok: false, why: "manifest.json malformed: " + String(e?.message || e).slice(0, 120), warnings: [] }; }

  const parsed = parseInstructions(instructions);
  const stack = detectStack(artifactsDir, manifest);

  // framework preference: the user's explicit choice wins; else recommend from
  // the detected stack; the CURRENT engine always emits static output — that
  // fact is recorded so the gap is visible, never hidden.
  const recommendation = stack.detected.includes("nextjs") || stack.detected.includes("react") ? "react"
    : stack.detected.includes("nuxt") || stack.detected.includes("vue") ? "vue" : "static";
  const framework = frameworkPreference || recommendation;
  const output = {
    framework,
    reason: frameworkPreference ? "user preference (framework option)" : `recommended from detected stack [${stack.detected.join(", ") || "none"}]`,
    engineOutput: "static",
    note: frameworkPreference && frameworkPreference !== "static"
      ? "preference recorded — the current engine emits static HTML/CSS/runtime; framework output is spec P1 work"
      : undefined,
  };

  // per-page regions + components (observed), capped for large sites
  const pagesDir = path.join(artifactsDir, "pages");
  let pageIds = [];
  try { pageIds = fs.readdirSync(pagesDir); } catch { /* no pages */ }
  const pages = [];
  for (const pid of pageIds.slice(0, 10)) {
    const meta = (manifest.pages || []).find((p) => p.pageId === pid) || { url: null, route: null };
    let regions = [];
    let components = [];
    try {
      const dom = JSON.parse(fs.readFileSync(path.join(pagesDir, pid, "dom.json"), "utf8"));
      regions = classifyRegions(dom.elements);
      components = (dom.repeated || []).slice(0, 5).map((r) => `${r.signature} ×${r.count}`);
    } catch { warnings.push(`${pid}: dom.json unreadable — regions inferred absent`); }
    pages.push({ pageId: pid, url: meta.url, route: meta.route?.url || null, regions, components, evidence: regions.length ? "observed" : "inferred" });
  }

  const interactions = inferInteractionModel(artifactsDir, manifest);

  // acceptance evidence — what verification must check against this blueprint
  const acceptanceEvidence = [];
  if ((manifest.coverage?.routesExplored || 0) > 0) acceptanceEvidence.push(`replay ${manifest.coverage.routesExplored} explored route(s)`);
  if (interactions.triggers > 0) acceptanceEvidence.push(`replay ${interactions.triggers} recorded trigger(s)`);
  if (pages.length) acceptanceEvidence.push(`reconstruct ${pages.length} page(s) with observed regions`);
  acceptanceEvidence.push("token match: colors/typography/spacing from measured dom.json typography");

  // ambiguities — recorded, never silently resolved (resolution order in ADR-0003)
  const ambiguities = [];
  if (!parsed.applied && !parsed.raw) ambiguities.push("no user instructions — cloning full visible scope by defaults");
  if (interactions.model === "unknown") ambiguities.push("no interaction evidence — page may be static or unexplored");
  if ((manifest.coverage?.routesDiscovered || 0) > (manifest.coverage?.routesExplored || 0)) {
    ambiguities.push(`${manifest.coverage.routesDiscovered - manifest.coverage.routesExplored} discovered route(s) unexplored — reconstruction covers explored routes only`);
  }
  if (frameworkPreference && frameworkPreference !== "static") ambiguities.push(`framework preference "${frameworkPreference}" exceeds current engine output (static) — recorded, not silently ignored`);

  const blueprint = {
    version: 1,
    generatedAt: new Date().toISOString(),
    jobId: manifest.jobId || path.basename(artifactsDir),
    source: { url: manifest.originalUrl || null, status: manifest.status || null },
    instructions: parsed,
    stack: { ...stack, output },
    pages,
    interactions,
    assets: { count: manifest.assets || 0, strategy: "reuse-local", evidence: "observed" },
    designTokens: { source: "pages/*/dom.json typography + styles", evidence: "observed" },
    responsive: { captured: "see pages/*/responsive.json when present", evidence: "unverified" },
    acceptanceEvidence,
    ambiguities,
    coverage: manifest.coverage || null,
  };

  try {
    fs.writeFileSync(path.join(artifactsDir, "blueprint.json"), JSON.stringify(blueprint, null, 2));
  } catch (e) {
    warnings.push("blueprint.json write failed: " + String(e?.message || e).slice(0, 120));
  }
  return { ok: true, blueprint, warnings };
}
