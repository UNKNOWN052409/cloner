// Slop lint (ADR-0003 hygiene): deterministic scan of the GENERATED project for
// generator-injected generic patterns that the captured evidence never shows —
// the clone must look like the ORIGINAL, never AI-generic. Technique from the
// ui-unslop audit catalog (github.com/Microck/ui-unslop, references/pattern-catalog.md
// cloned to /tmp/ext-uislop-read during development): decision probes only, zero
// code copied from it.
//
// Evidence contract — every verdict traces to captured artifacts:
//   pages/<id>/styles.json  (elements[].style, typography, bodyStyle/htmlStyle)
//   pages/<id>/dom.json     (elements[].text/.cls/.style, typography)
//   design-tokens.json      (colors, backgrounds, fonts, fontSizes, radii)
// A value present in evidence is NEVER flagged (a gradient the original really
// has stays). A pattern whose treatment appears nowhere in evidence is verdict
// "injected". Deterministically fixable injections are fixed in place (drop the
// injected declaration / replace with the nearest measured token); everything
// else is listed honestly, not guessed.
//
// Non-capture honesty: phase-1 does not record box-shadow or text-transform
// (see exploration extractor — no boxShadow/textTransform field anywhere), so
// those treatments can never be evidence-backed; findings say that explicitly.
//
// Returns { ok, found, fixed, remaining, findings, notes }; ok=false means the
// scan could not run honestly (no evidence) — it never flags without evidence.
import fs from "node:fs";
import path from "node:path";

// canonical AI-default font stacks (first token identifies the stack)
const DEFAULT_STACK_FIRST = new Set([
  "system-ui", "-apple-system", "segoe ui", "roboto", "helvetica", "helvetica neue",
  "arial", "inter", "ui-sans-serif", "sf pro display", "sf pro text", "sans-serif", "roboto mono",
]);
// purple/violet/indigo hue band of the default AI gradient signature
const AI_HUE_MIN = 240, AI_HUE_MAX = 300;
// canonical default shadows + the generous AI rounding scale (not the small
// 2-6px radii, which may be UA/structural)
const DEFAULT_SHADOW_RE = /box-shadow:\s*(0\s+(?:[1-9]|1[0-9]|2[0-9])[a-z%]*\s+[1-9][0-9]*(?:px|rem)?|0\s+0\s+(?:2[0-9]|3[0-9]|4[0-9])[a-z%]*|var\(--tw-shadow\))/i;
const DEFAULT_RADII = new Set(["8px", "10px", "12px", "14px", "16px", "18px", "20px", "24px", "28px", "32px", "36px", "40px", "9999px", "999px", "0.5rem", "0.75rem", "1rem", "1.25rem", "1.5rem", "1.75rem", "2rem", "2.5rem", "3rem"]);
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
const ONLY_EMOJI_RE = /^(?:\s|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]){1,6}$/u;

const normFont = (v) => String(v || "").toLowerCase().split(",")[0].trim().replace(/['"]/g, "").trim();

function hexToHsl(hex) {
  const m = String(hex).trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60); if (h < 0) h += 360;
  }
  const l = (max + min) / 2, s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { h, s: Math.round(s * 100) / 100, l: Math.round(l * 100) / 100 };
}

// Load captured evidence into lookup sets. No evidence files → null (caller
// must not flag without evidence to compare against).
function loadEvidence(artifactsDir) {
  if (!artifactsDir || !fs.existsSync(artifactsDir)) return null;
  const ev = {
    gradients: new Set(), colors: new Set(), fonts: new Set(), fontDisplay: [], fontSizes: new Set(),
    radii: new Set(), emoji: new Set(), classCounts: new Map(), pages: 0,
  };
  // measured font (normalized for comparison, original casing kept for the
  // replacement token — the clone must read "Georgia", not "georgia")
  const addFont = (raw) => {
    const n = normFont(raw);
    if (n && !ev.fonts.has(n)) { ev.fonts.add(n); ev.fontDisplay.push(String(raw).split(",")[0].trim().replace(/['"]/g, "").trim()); }
  };
  // design-tokens.json — the persisted measured tokens
  try {
    const t = JSON.parse(fs.readFileSync(path.join(artifactsDir, "design-tokens.json"), "utf8"));
    for (const [v] of [...(t.colors || []), ...(t.backgrounds || [])]) if (v) ev.colors.add(String(v).toUpperCase());
    for (const [v] of t.fonts || []) if (v) addFont(v);
    for (const [v] of t.fontSizes || []) if (v) ev.fontSizes.add(String(v));
    for (const [v] of t.radii || []) if (v) ev.radii.add(String(v).toLowerCase());
  } catch {}
  // per-page captured styles + dom
  let pageDirs = [];
  try {
    pageDirs = fs.readdirSync(path.join(artifactsDir, "pages"), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {}
  for (const pid of pageDirs) {
    const stylesPath = path.join(artifactsDir, "pages", pid, "styles.json");
    try {
      const s = JSON.parse(fs.readFileSync(stylesPath, "utf8"));
      ev.pages++;
      for (const ty of s.typography || []) {
        if (ty.font) addFont(ty.font);
        if (ty.size) ev.fontSizes.add(String(ty.size));
      }
      for (const root of [s.bodyStyle, s.htmlStyle]) {
        if (root?.fontFamily) addFont(root.fontFamily);
        if (root?.backgroundColor) ev.colors.add(String(root.backgroundColor).toUpperCase());
      }
      for (const el of s.elements || []) {
        const st = el.style || {};
        const bg = String(st.backgroundImage || "");
        if (bg.includes("gradient(")) ev.gradients.add(bg.replace(/\s+/g, "").toLowerCase());
        for (const k of ["backgroundColor", "color"]) if (st[k]) ev.colors.add(String(st[k]).toUpperCase());
        if (st.fontFamily) addFont(st.fontFamily);
        if (st.fontSize) ev.fontSizes.add(String(st.fontSize));
        if (st.borderRadius) ev.radii.add(String(st.borderRadius).toLowerCase());
      }
    } catch {}
    const domPath = path.join(artifactsDir, "pages", pid, "dom.json");
    try {
      const d = JSON.parse(fs.readFileSync(domPath, "utf8"));
      for (const ty of d.typography || []) {
        if (ty.font) addFont(ty.font);
        if (ty.size) ev.fontSizes.add(String(ty.size));
      }
      for (const el of d.elements || []) {
        if (el && typeof el.cls === "string" && el.cls.trim()) {
          for (const c of el.cls.trim().split(/\s+/)) {
            ev.classCounts.set(c, (ev.classCounts.get(c) || 0) + 1);
          }
        }
        if (el && typeof el.text === "string") for (const ch of el.text) if (EMOJI_RE.test(ch)) ev.emoji.add(ch);
      }
    } catch {}
  }
  if (!ev.pages) return null; // no per-page evidence to trace against
  return ev;
}

// ---- CSS scan: declarations inside the generated project's stylesheets ----
// fixes are line-scoped: each carries the 1-based line it was found on and is
// applied only there, linked to the finding that owns it (owner index) so
// "fixed" is claimed only when that line's text actually changed on disk.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function scanCss(cssText, fileName, ev, findings, fixes) {
  const lines = cssText.split("\n");
  const declRe = /([a-z-]+)\s*:\s*([^;{}]+)([;}]|$)/gi;
  lines.forEach((lineText, li) => {
    const lineNo = li + 1;
    let m;
    declRe.lastIndex = 0;
    while ((m = declRe.exec(lineText))) {
      const prop = m[1].toLowerCase(), val = m[2].trim();
      const full = `${prop}:${val}`;
      const where = { file: fileName, line: lineNo, decl: full };
      // 1. default purple/blue gradient — evidence-backed when the captured
      // backgroundImage matches OR every color stop is a measured color
      if (/background(-image)?/.test(prop) && /gradient\(/i.test(val)) {
        const norm = val.replace(/\s+/g, "").toLowerCase();
        const stops = [...val.matchAll(/#[0-9a-f]{3,8}|rgba?\([^)]*\)/gi)].map((x) => x[0]);
        const inEv = ev.gradients.has(norm) || (stops.length && stops.every((c) => ev.colors.has(String(c).toUpperCase())));
        if (inEv) { findings.push({ pattern: "gradient", ...where, evidenceChecked: "captured backgroundImage/colors (pages/*/styles.json elements, design-tokens.json colors)", verdict: "evidence-backed" }); continue; }
        const aiSig = stops.some((c) => { const h = hexToHsl(c); return h && h.h >= AI_HUE_MIN && h.h <= AI_HUE_MAX && h.s >= 0.2 && h.l >= 0.2 && h.l <= 0.85; });
        if (aiSig) {
          findings.push({ pattern: "default-gradient", ...where, evidenceChecked: `pages/*/styles.json backgroundImages + design-tokens.json colors: no captured gradient matches and stops ${stops.join(", ")} are absent from measured colors → purple/blue default signature`, verdict: "injected" });
          fixes.push({ file: fileName, line: lineNo, re: escapeRe(prop) + "\\s*:\\s*" + escapeRe(val), replace: "", owner: findings.length - 1 });
        }
        continue;
      }
      // 2. default font stack overriding measured typography
      if (prop === "font-family" || prop === "font") {
        const f = normFont(val);
        if (ev.fonts.has(f)) continue; // measured font — never a finding
        if (DEFAULT_STACK_FIRST.has(f)) {
          const nearest = ev.fontDisplay[0] || [...ev.fonts][0] || null;
          findings.push({ pattern: "default-font-stack", ...where, evidenceChecked: `measured fonts (pages/*/styles.json elements + typography, design-tokens.json fonts): ${ev.fontDisplay.slice(0, 4).join(", ") || "none"}; "${f}" is a generic default stack`, verdict: "injected" });
          if (nearest) fixes.push({ file: fileName, line: lineNo, re: escapeRe(prop) + "\\s*:\\s*" + escapeRe(val), replace: `${prop}:${nearest}`, owner: findings.length - 1 });
        }
        continue;
      }
      // 3. default box-shadow (phase-1 captures no shadow → never evidence-backed)
      if (prop === "box-shadow" && DEFAULT_SHADOW_RE.test(full)) {
        findings.push({ pattern: "default-box-shadow", ...where, evidenceChecked: "phase-1 styles.json/dom.json record no box-shadow anywhere → default elevation signature unverifiable", verdict: "injected" });
        fixes.push({ file: fileName, line: lineNo, re: escapeRe(prop) + "\\s*:\\s*" + escapeRe(val), replace: "", owner: findings.length - 1 });
        continue;
      }
      // 4. default border radius absent from measured radii
      if (prop === "border-radius") {
        const r = val.toLowerCase();
        if (ev.radii.has(r)) continue; // measured radius stays
        if (DEFAULT_RADII.has(r)) {
          const parsed = parseFloat(r);
          const measured = [...ev.radii].map((x) => parseFloat(x)).filter((x) => !Number.isNaN(x));
          const nearest = measured.length ? measured.sort((a, b) => Math.abs(a - parsed) - Math.abs(b - parsed))[0] : null;
          findings.push({ pattern: "default-border-radius", ...where, evidenceChecked: `measured radii: ${[...ev.radii].slice(0, 5).join(", ") || "none"}; "${r}" appears nowhere in captured styles`, verdict: "injected" });
          fixes.push({ file: fileName, line: lineNo, re: escapeRe(prop) + "\\s*:\\s*" + escapeRe(val), replace: nearest !== null ? `${prop}:${nearest}px` : "", owner: findings.length - 1 });
        }
        continue;
      }
      // 5. pill badge: uppercase + tracking (phase-1 captures neither field →
      //    the eyebrow treatment is unverifiable → injected per ADR-0003)
      if (prop === "text-transform" && /uppercase/i.test(val)) {
        const ls = lineText.toLowerCase().match(/letter-spacing:\s*([0-9.]+)\s*(px|em|rem)/);
        const tracked = ls && (ls[2] === "px" ? parseFloat(ls[1]) >= 1 : parseFloat(ls[1]) >= 0.05);
        if (tracked) {
          findings.push({ pattern: "pill-badge-uppercase", ...where, evidenceChecked: "no text-transform/letter-spacing captured in pages/*/styles.json or dom.json typography → uppercase+tracking eyebrow unverifiable", verdict: "injected" });
          fixes.push({ file: fileName, line: lineNo, re: "text-transform\\s*:\\s*uppercase\\s*;?", replace: "", owner: findings.length - 1 });
          fixes.push({ file: fileName, line: lineNo, re: "letter-spacing\\s*:\\s*[^;}]+;?", replace: "", owner: findings.length - 1 });
        }
      }
    }
  });
}

// ---- HTML scan: emoji-as-icon + identical stat strip ----
// Content-mutating fixes are limited to emoji text inside elements that carry
// NO wiring attributes (data-replay-id etc.) — everything else is listed
// honestly rather than edited.
function scanHtml(htmlText, fileName, ev, findings, fixes) {
  const lines = htmlText.split("\n");
  lines.forEach((lineText, li) => {
    const lineNo = li + 1;
    // emoji used as the entire content of an element (icon slot)
    const elRe = /<(span|i|b|em|div|p|button|a)\b([^>]*)>((?:\s|[^<]){1,12}?)<\/\1>/gi;
    let m;
    elRe.lastIndex = 0;
    while ((m = elRe.exec(lineText))) {
      const inner = m[3];
      if (!ONLY_EMOJI_RE.test(inner) || !EMOJI_RE.test(inner)) continue;
      const chars = [...inner].filter((c) => EMOJI_RE.test(c));
      if (chars.every((c) => ev.emoji.has(c))) continue; // original's own emoji — never flagged
      const wired = /\bdata-[\w-]+=/.test(m[2]);
      findings.push({
        pattern: "emoji-as-icon", file: fileName, line: lineNo,
        decl: `<${m[1]}${m[2]}>${inner}</${m[1]}>`.slice(0, 120),
        evidenceChecked: `element text captured across ${ev.pages} page(s) of dom.json contains none of ${[...new Set(chars)].join(" ")}`,
        verdict: "injected", fixed: false,
      });
      if (!wired) fixes.push({ file: fileName, line: lineNo, find: inner, replace: inner.replace(new RegExp(EMOJI_RE.source + "|\\u{FE0F}", "gu"), "").trimEnd(), owner: findings.length - 1 });
    }
  });
  // uniform stat strip: same class on >=3 block elements while the captured
  // dom.json shows the class on fewer — the 4-card metric-card tell
  const stripRe = /<(div|section|li|article)\b[^>]*class="([^"]+)"[^>]*>/gi;
  const seen = new Map();
  let sm;
  while ((sm = stripRe.exec(htmlText))) {
    const cls = sm[2].trim().split(/\s+/)[0];
    if (cls) seen.set(cls, (seen.get(cls) || 0) + 1);
  }
  for (const [cls, count] of seen) {
    if (count < 3) continue;
    const evCount = ev.classCounts.get(cls) || 0;
    if (evCount >= count) continue; // the original really has this many — keep
    const lineNo = lines.findIndex((l) => l.includes(`class="${cls}"`)) + 1;
    findings.push({
      pattern: "uniform-stat-strip", file: fileName, line: Math.max(lineNo, 1),
      decl: `${count}× <${cls}> metric-card blocks`,
      evidenceChecked: `captured dom.json shows class "${cls}" on ${evCount} element(s) across ${ev.pages} page(s) — a ${count}-card strip appears nowhere in evidence`,
      verdict: "injected", fixed: false,
      note: "content-block deletion is not deterministically fixable — listed, not edited",
    });
  }
}

// Apply line-scoped fixes and rewrite the touched files. A finding counts as
// fixed only when every fix linked to it actually changed the file text.
function applyFixes(fixes, fileTexts, findings, notes) {
  const byFile = new Map();
  for (const f of fixes) { if (!byFile.has(f.file)) byFile.set(f.file, []); byFile.get(f.file).push(f); }
  const ownerOk = new Map(); // owner index → all fixes applied?
  for (const [file, list] of byFile) {
    const lines = fileTexts.get(file).split("\n");
    for (const f of list) {
      let applied = false;
      const line = lines[f.line - 1];
      if (typeof line !== "string") continue;
      if (f.re) {
        const re = new RegExp(f.re);
        if (re.test(line)) { lines[f.line - 1] = line.replace(re, f.replace); applied = true; }
      } else if (f.find && line.includes(f.find)) {
        lines[f.line - 1] = line.split(f.find).join(f.replace); applied = true;
      }
      ownerOk.set(f.owner, (ownerOk.get(f.owner) ?? true) && applied);
    }
    const text = lines.join("\n");
    try { fs.writeFileSync(file, text); fileTexts.set(file, text); } catch (e) { notes.push(`could not rewrite ${path.basename(file)}: ${e?.message}`); }
  }
  for (const [owner, ok] of ownerOk) if (findings[owner] && ok) findings[owner].fixed = true;
}

// Scan the generated project against captured evidence. ok=false means the scan
// could not run honestly (no evidence, no files) — it never flags without
// evidence to trace against.
export function slopLint(outDir, { artifactsDir } = {}) {
  const findings = [], fixes = [], notes = [];
  const fail = (why) => ({ ok: false, found: 0, fixed: 0, remaining: 0, findings: [], notes: [why] });
  if (!outDir || !fs.existsSync(outDir)) return fail("generated project directory missing — nothing scanned");
  const ev = loadEvidence(artifactsDir);
  if (!ev) return fail(`no captured evidence traceable under ${artifactsDir} — refusing to verdict without evidence (ADR-0003)`);
  // gather generated CSS + HTML files (all depths, deterministic order)
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (/\.(css|html)$/i.test(e.name)) files.push(p);
    }
  };
  walk(outDir);
  if (!files.length) return fail("no CSS/HTML files in the generated project — nothing scanned");
  const fileTexts = new Map();
  for (const f of files) {
    try { fileTexts.set(f, fs.readFileSync(f, "utf8")); } catch { notes.push(`unreadable: ${path.basename(f)}`); }
  }
  for (const [f, text] of fileTexts) {
    if (/\.css$/i.test(f)) scanCss(text, f, ev, findings, fixes);
    else scanHtml(text, f, ev, findings, fixes);
  }
  applyFixes(fixes, fileTexts, findings, notes);
  const injected = findings.filter((x) => x.verdict === "injected");
  const found = findings.length;
  const fixed = injected.filter((x) => x.fixed).length;
  const remaining = injected.length - fixed;
  return { ok: true, evidencePages: ev.pages, found, fixed, remaining, findings, notes };
}
