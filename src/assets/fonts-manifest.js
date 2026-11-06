// Fonts manifest (font fidelity): the bridge between captured font FILES and
// the @font-face tokens the generated project needs. Exploration persists
// font files into artifacts/<job>/assets/fonts/ plus a fonts manifest
// ({ family, weight, style, file, format } — from @font-face rules discovered
// in captured CSS + network content-types). Reconstruction maps every MEASURED
// family (dom.json typography) to its captured files and emits @font-face into
// styles/tokens.css BEFORE the :root font tokens; a measured family with no
// captured file is substituted with the original's closest captured family of
// the same class and recorded honestly — never a silent Times fallback.
import fs from "node:fs";
import path from "node:path";

export const FONT_FORMAT = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype", eot: "embedded-opentype" };
export const FONT_EXT_RE = /^(woff2?|ttf|otf|eot)$/i;

export function formatFromExt(fileOrExt) {
  const ext = String(fileOrExt || "").split("?")[0].match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase()
    || String(fileOrExt || "").toLowerCase().replace(/^\./, "");
  return FONT_FORMAT[ext] || null;
}

function normalizeWeight(raw) {
  const v = String(raw || "").trim().split(/\s+/)[0].toLowerCase();
  if (!v) return null;
  if (v === "bold") return "700";
  if (v === "normal") return "400";
  if (/^\d{1,4}$/.test(v)) return v;
  return null;
}

function normalizeStyle(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "italic" || v === "oblique") return "italic";
  return "normal";
}

// @font-face rules from captured CSS text. srcs resolve against the CSS URL;
// data: URIs are skipped (already inline — nothing to download, recorded as
// an honest limitation in the manifest note rather than fabricated files).
export function parseFontFaceRules(cssText, baseUrl) {
  const rules = [];
  if (typeof cssText !== "string" || !cssText.includes("@font-face")) return rules;
  for (const block of cssText.match(/@font-face\s*\{[^}]*\}/g) || []) {
    const fam = block.match(/font-family\s*:\s*(?:"([^"]*)"|'([^']*)'|([^;}]+))/i);
    const family = (fam?.[1] ?? fam?.[2] ?? fam?.[3] ?? "").trim().replace(/^["']|["']$/g, "");
    if (!family) continue;
    const srcRaw = (block.match(/src\s*:\s*([^;}]+)/i) || [])[1] || "";
    const srcs = [];
    let m;
    const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"][^)]*?))\s*\)/g;
    while ((m = URL_RE.exec(srcRaw))) {
      const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (!raw || raw.startsWith("data:")) continue;
      let abs = null;
      try { abs = new URL(raw, baseUrl || "http://font-face.invalid/").href; } catch { continue; }
      const ext = abs.split("?")[0].match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || null;
      srcs.push({ url: abs, ext, format: ext && FONT_FORMAT[ext] || null });
    }
    if (!srcs.length) continue;
    rules.push({
      family,
      weight: normalizeWeight((block.match(/font-weight\s*:\s*([^;}]+)/i) || [])[1]),
      style: normalizeStyle((block.match(/font-style\s*:\s*([^;}]+)/i) || [])[1]),
      srcs,
    });
  }
  return rules;
}

// matching key: lowercase, quotes stripped, separators collapsed — "Open Sans",
// "open-sans" and open_sans are the same family for map/substitution purposes
export function normalizeFamilyName(name) {
  return String(name || "").replace(/["']/g, "").trim().toLowerCase().replace(/[\s_\-]+/g, " ").trim();
}

export function classifyFamilyClass(name) {
  const n = String(name || "").toLowerCase();
  if (/mono|consol|courier|menlo|monaco|source code|fira code/.test(n)) return "mono";
  if (/serif/.test(n) && !/sans/.test(n)) return "serif";
  if (/times|georgia|garamond|baskerville|didot|caslon|palatino|minion|charter|book antiqua|roman/.test(n)) return "serif";
  return "sans"; // deterministic default: the web's dominant class
}

// families the browser already ships — emitting @font-face for them would be
// noise; they render locally, so they can never "silently fall back to Times"
const SYSTEM_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "-apple-system", "blinkmacsystemfont", "segoe ui", "times", "times new roman",
  "georgia", "garamond", "arial", "helvetica", "verdana", "tahoma", "trebuchet ms", "impact", "courier",
  "courier new", "palatino", "palatino linotype", "book antiqua", "comic sans ms", "lucida sans",
  "lucida sans unicode", "lucida console", "lucida bright", "menlo", "monaco", "consolas", "cambria",
  "calibri", "candara", "corbel", "constantia", "franklin gothic", "franklin gothic medium",
  "century gothic", "arial black", "arial narrow", "geneva", "optima", "futura", "meiryo", "ms gothic",
].map(normalizeFamilyName)); // same key as the lookups (quotes stripped, hyphens collapsed)
export function isSystemFamily(name) {
  return SYSTEM_FAMILIES.has(normalizeFamilyName(name));
}

// exploration-side fonts manifest: artifacts/<job>/assets/fonts/fonts-manifest.json
export function readFontsManifest(jobDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(jobDir, "assets", "fonts", "fonts-manifest.json"), "utf8"));
  } catch { return null; }
}

// measured families from the exploration DOM evidence: pages/*/dom.json
// typography entries { font, size, weight ("w700"), occurrences } — aggregated
// per family with the dominant measured weight for substitution faces
export function readMeasuredFamilies(jobDir) {
  const agg = new Map(); // family → { family, occurrences, weights: Map }
  const pagesDir = path.join(jobDir, "pages");
  let dirs = [];
  try { dirs = fs.readdirSync(pagesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  for (const pageId of dirs) {
    let dom = null;
    try { dom = JSON.parse(fs.readFileSync(path.join(pagesDir, pageId, "dom.json"), "utf8")); } catch { continue; }
    for (const t of Array.isArray(dom?.typography) ? dom.typography : []) {
      if (!t?.font) continue;
      const occ = Number(t.occurrences) || 1;
      const key = t.font;
      if (!agg.has(key)) agg.set(key, { family: key, occurrences: 0, weights: new Map() });
      const a = agg.get(key);
      a.occurrences += occ;
      const w = String(t.weight || "").replace(/^w/, "");
      if (/^\d+$/.test(w)) a.weights.set(w, (a.weights.get(w) || 0) + occ);
    }
  }
  return [...agg.values()]
    .map((a) => ({ family: a.family, occurrences: a.occurrences, dominantWeight: [...a.weights.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null }))
    .sort((a, b) => b.occurrences - a.occurrences);
}

// family heads of the :root font tokens ("--font-primary: Open Sans, sans-serif;")
// so the families actually referenced by the emitted var() are always mapped,
// even when dom.json sampling missed them
export function tokenFamilyHeads(tokensCssText) {
  const heads = [];
  if (typeof tokensCssText !== "string") return heads;
  for (const m of tokensCssText.matchAll(/--font-(?:primary|secondary)\s*:\s*([^;]+);/g)) {
    const head = m[1].split(",")[0].replace(/["']/g, "").trim();
    if (head && !heads.includes(head)) heads.push(head);
  }
  return heads;
}

function mergeMeasured(fromDom, fromTokens) {
  const byKey = new Map();
  for (const m of fromDom) byKey.set(normalizeFamilyName(m.family), m);
  for (const fam of fromTokens) {
    const key = normalizeFamilyName(fam);
    if (byKey.has(key)) continue;
    byKey.set(key, { family: fam, occurrences: 0, dominantWeight: null });
  }
  return [...byKey.values()];
}

// reconstruction-side font tokens: @font-face rules for the captured original
// fonts + substitution rules for measured families with no captured file.
// Returns { css, manifest } — css is PREPENDED to tokens.css (before the :root
// font tokens), manifest is written to styles/fonts-manifest.json.
export function buildTokenFontFaces({ jobDir, tokensCssText = "", outDir, webRelDir = "public/assets" }) {
  const manifest = readFontsManifest(jobDir);
  const captured = manifest && Array.isArray(manifest.fonts) ? manifest.fonts : [];
  const measured = mergeMeasured(readMeasuredFamilies(jobDir), tokenFamilyHeads(tokensCssText));
  const cssWebBase = "../" + webRelDir.replace(/\/+$/, "") + "/";

  // copy a captured font file into the project; returns the CSS url or null
  const placed = new Map(); // artifact rel → url | null
  const placeFile = (rel) => {
    if (placed.has(rel)) return placed.get(rel);
    let url = null;
    try {
      const src = path.join(jobDir, rel);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.join(outDir, webRelDir), { recursive: true });
        const dest = path.join(outDir, webRelDir, path.basename(rel));
        if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) url = cssWebBase + path.basename(rel);
      }
    } catch { url = null; }
    placed.set(rel, url);
    return url;
  };

  // captured families grouped by normalized name, entries with a placeable file
  const groups = new Map();
  for (const e of captured) {
    if (!e?.family || !e?.file) continue;
    const key = normalizeFamilyName(e.family);
    if (!groups.has(key)) groups.set(key, { family: e.family, entries: [] });
    groups.get(key).entries.push(e);
  }

  const emitted = [];   // ordered @font-face descriptors
  const missingFiles = [];
  for (const g of groups.values()) {
    for (const e of g.entries) {
      const url = placeFile(e.file);
      if (!url) { missingFiles.push({ family: g.family, file: e.file }); continue; }
      emitted.push({ family: g.family, weight: e.weight || null, style: e.style || "normal", url, format: e.format || formatFromExt(e.file), file: e.file, source: "captured" });
    }
  }
  const placeable = new Map();
  for (const [key, g] of groups) {
    const withUrl = emitted.filter((f) => normalizeFamilyName(f.family) === key);
    if (withUrl.length) placeable.set(key, withUrl);
  }

  // substitution: the measured family gets an @font-face under ITS OWN name
  // pointing at the substitute's file, so elements keep asking for the measured
  // family and still render real captured bytes instead of a Times fallback
  const substitutions = [];
  const systemFonts = [];
  const unresolved = [];
  for (const m of measured) {
    const key = normalizeFamilyName(m.family);
    if (groups.has(key)) continue;            // covered by its own captured files
    if (isSystemFamily(m.family)) { systemFonts.push(m.family); continue; }
    const cls = classifyFamilyClass(m.family);
    const occOf = (key) => measured.find((x) => normalizeFamilyName(x.family) === key)?.occurrences || 0;
    const rank = (cands) => [...cands].sort((a, b) =>
      occOf(b.key) - occOf(a.key)   // dominant in the original first
      || b.files - a.files
      || (a.key < b.key ? -1 : 1))[0];
    const sameClass = rank([...placeable].filter(([k]) => classifyFamilyClass(k) === cls)
      .map(([k, fs]) => ({ key: k, files: fs.length })));
    const any = sameClass || rank([...placeable].map(([k, fs]) => ({ key: k, files: fs.length })));
    if (!any) { unresolved.push({ family: m.family, occurrences: m.occurrences, reason: "no captured font file available for any family — the clone may render this family with a local fallback" }); continue; }
    const sub = placeable.get(any.key);
    const weightMatch = m.dominantWeight && sub.find((f) => f.weight === m.dominantWeight);
    const chosen = weightMatch || sub[0];
    emitted.push({ family: m.family, weight: chosen.weight, style: chosen.style || "normal", url: chosen.url, format: chosen.format, file: chosen.file, source: "substituted", substitutedFrom: chosen.family });
    substitutions.push({
      measured: m.family, occurrences: m.occurrences,
      substitutedTo: chosen.family, file: chosen.url,
      reason: sameClass
        ? `measured family "${m.family}" has no captured font file — substituted the original's closest captured ${cls}-class family "${chosen.family}" (recorded here; never a silent fallback)`
        : `measured family "${m.family}" has no captured font file and no captured ${cls}-class family exists — substituted the original's dominant captured family "${chosen.family}" (recorded here; never a silent fallback)`,
    });
  }

  const lines = [
    "/* @font-face tokens (font fidelity): every measured family (dom.json typography)",
    "   resolves to font FILES captured from the original into assets/fonts/ —",
    "   see assets/fonts/fonts-manifest.json. Substitutions are recorded honestly in",
    "   styles/fonts-manifest.json; the clone never silently falls back to Times. */",
  ];
  for (const s of substitutions) lines.push(`/* substitution: "${s.measured}" → "${s.substitutedTo}" — ${s.reason} */`);
  for (const u of unresolved) lines.push(`/* unresolved: "${u.family}" — ${u.reason} */`);
  if (systemFonts.length) lines.push(`/* system families render locally, no @font-face needed: ${systemFonts.join(", ")} */`);
  if (!manifest) lines.push("/* note: exploration produced no fonts manifest — no captured font files were available */");
  for (const f of emitted) {
    const parts = [`font-family: "${f.family}"`];
    if (f.weight) parts.push(`font-weight: ${f.weight}`);
    parts.push(`font-style: ${f.style || "normal"}`, "font-display: swap", `src: url("${f.url}") format("${f.format}")`);
    lines.push(`@font-face { ${parts.join("; ")}; }`);
  }

  return {
    css: lines.length ? lines.join("\n") + "\n" : "",
    manifest: {
      generatedAt: new Date().toISOString(),
      source: "assets/fonts/fonts-manifest.json (exploration capture)",
      capturedManifestFound: !!manifest,
      measuredFamilies: measured.map((m) => ({ family: m.family, occurrences: m.occurrences })),
      fontFaces: emitted,
      substitutions,
      systemFonts,
      unresolved,
      missingFiles,
    },
  };
}
