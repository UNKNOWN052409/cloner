#!/usr/bin/env node
// 4.5.6 completeness-audit-engine — systematic finder for half-finished work.
// Owner complaint: "bahut sa kaam adha chod diya" (lots of work left half-done).
//
// What it hunts (regex/static analysis, zero deps):
//   1. todo-marker        TODO / FIXME left in code                          → critical (product) / warning (tooling)
//   2. marker             XXX / HACK comments                                → warning (product) / info (tooling)
//   3. not-implemented    "not implemented" / unimplemented / NotImplemented → critical
//   4. stub-return        placeholder returns annotated stub/fake/placeholder → critical (product) / warning (tooling)
//   5. empty-function     named function/const-arrow with an empty body      → warning
//   6. mock-in-product    mock imports/identifiers OUTSIDE test files        → critical
//                          (mocks are legal ONLY under test/ or test-* files —
//                           they simulate the REMOTE side there, per the
//                           no-mocks mandate; in product paths they are poison)
//   7. dead-501           a 501 response paired with not-implemented language → critical
//   8. http-501           any bare 501 status use                            → warning (verify it's intentional)
//   9. unwired-export     exported symbol never referenced anywhere else     → warning
//  10. test-code-in-product  test/spec files living inside src/              → warning
//  11. placeholder-copy  user-facing "coming soon" / "under construction"   → warning
//
// Product paths  = src/, bin/, platform-ui/, dashboard/ (and anything under the
//                  scan root that is not a test path).
// Test paths     = files under test/tests/__tests__/fixtures dirs or named
//                  test-*/spec-*/…-test/…-spec/*.test.*
// Tooling paths  = scripts/, docs/ — findings there are tiered one level down.
//
// Output: output/completeness-report.md (+ .json). Exit code: 1 iff criticals > 0.
// Run:     node scripts/audit-completeness.mjs [--root DIR] [--out PATH] [--json PATH]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ─────────────────────────────────────────────────────────── configuration ──
const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".html", ".htm", ".css"]);
const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".zcode", ".cache",
  "output", "artifacts", "backups", "platform-data", "fixtures", "fixture",
  "hunt-shots", ".probe-sr", "test-results", "playwright-report",
]);
// "Product" top-level dirs: findings there use the strict severity tier.
const PRODUCT_DIRS = new Set(["src", "bin", "platform-ui", "dashboard"]);
const TOOLING_DIRS = new Set(["scripts", "docs"]);

const TEST_DIR_SEGMENTS = new Set(["test", "tests", "__tests__", "__mocks__", "__fixtures__"]);
// `foo.spec.js` / `foo.test.js` / `foo-test.js` / `test-foo.js` are tests;
// `foo-spec.js` (a specification document like style-spec.js) is NOT.
const TEST_BASENAME_RE = /^(test|spec)[.\-_].*|\..*\.(test|spec)\.[cm]?jsx?$|[.\-_]test\.[cm]?jsx?$/i;

// ───────────────────────────────────────────────────────────── path utils ──
function toPosix(p) { return p.split(path.sep).join("/"); }

function isTestPath(rel) {
  const posix = toPosix(rel);
  const segments = posix.split("/");
  if (segments.slice(0, -1).some((s) => TEST_DIR_SEGMENTS.has(s.toLowerCase()))) return true;
  return TEST_BASENAME_RE.test(path.posix.basename(posix));
}

function classifyFile(root, absFile) {
  const rel = toPosix(path.relative(root, absFile));
  const top = rel.split("/")[0];
  const test = isTestPath(rel);
  let tier;
  if (test) tier = "test";
  else if (PRODUCT_DIRS.has(top)) tier = "product";
  else if (TOOLING_DIRS.has(top)) tier = "tooling";
  else tier = "product"; // root-level code files are product by default
  return { rel, tier };
}

// ────────────────────────────────────────────────────── source masking ──
// Replaces comment bodies and string-literal contents with spaces while
// PRESERVING every character position and newline. Findings computed on the
// masked source therefore carry correct line/column numbers, and phrases like
// "there are no mocks in this file" inside comments cannot create findings.
// Regex literals are not modeled: worst case is over-masking (a missed
// finding), never a false positive.
export function maskCommentsAndStrings(src) {
  const out = src.split("");
  const n = src.length;
  let mode = "code";      // 'code' | 'str'
  let quote = "";         // active quote char when mode === 'str'
  let inExpr = false;     // true only while inside a template ${...} expression
  let depth = 0;          // brace depth within that expression
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : "";
    if (mode === "code") {
      if (c === "/" && d === "/") {
        while (i < n && src[i] !== "\n") { out[i] = " "; i++; }
        continue;
      }
      if (c === "/" && d === "*") {
        out[i] = " "; out[i + 1] = " "; i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
          if (src[i] !== "\n") out[i] = " ";
          i++;
        }
        if (i < n) { out[i] = " "; out[i + 1] = " "; i += 2; }
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { mode = "str"; quote = c; i++; continue; }
      if (inExpr) {
        if (c === "{") { depth++; i++; continue; }
        if (c === "}") {
          if (depth > 0) depth--;
          else { inExpr = false; mode = "str"; quote = "`"; }
          i++; continue;
        }
      }
      i++; continue;
    }
    // mode === 'str'
    if (c === "\\") { out[i] = " "; if (i + 1 < n) out[i + 1] = " "; i += 2; continue; }
    if (quote === "`" && c === "$" && d === "{") { mode = "code"; inExpr = true; depth = 0; out[i] = "$"; i += 2; continue; }
    if (c === quote) { mode = "code"; quote = ""; i++; continue; }
    if (c !== "\n") out[i] = " ";
    i++;
  }
  return out.join("");
}

// Second mask flavor: string contents masked, comments KEPT — used by the
// marker detector so `const label = "TODO list"` (a feature name) cannot fire
// while `// TODO` still does. On this flavor any `//` is a real line comment.
export function maskStringsOnly(src) {
  const out = src.split("");
  const n = src.length;
  let mode = "code";
  let quote = "";
  let inExpr = false;     // true only while inside a template ${...} expression
  let depth = 0;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : "";
    if (mode === "code") {
      if (c === '"' || c === "'" || c === "`") { mode = "str"; quote = c; i++; continue; }
      if (inExpr) {
        if (c === "{") { depth++; i++; continue; }
        if (c === "}") {
          if (depth > 0) depth--;
          else { inExpr = false; mode = "str"; quote = "`"; }
          i++; continue;
        }
      }
      i++; continue;
    }
    if (c === "\\") { out[i] = " "; if (i + 1 < n) out[i + 1] = " "; i += 2; continue; }
    if (quote === "`" && c === "$" && d === "{") { mode = "code"; inExpr = true; depth = 0; i += 2; continue; }
    if (c === quote) { mode = "code"; quote = ""; i++; continue; }
    if (c !== "\n") out[i] = " ";
    i++;
  }
  return out.join("");
}

function commentRegionOfLine(stringsMaskedLine) {
  const li = stringsMaskedLine.indexOf("//");
  const bi = stringsMaskedLine.indexOf("/*");
  if (li === -1 && bi === -1) return "";
  if (li !== -1 && (bi === -1 || li < bi)) return stringsMaskedLine.slice(li);
  return stringsMaskedLine.slice(bi);
}

function lineOf(src, index) { return src.slice(0, index).split("\n").length; }
function lineTextAt(src, line) { return (src.split("\n")[line - 1] || "").trim(); }

// Match closing brace for a `{` at index in MASKED source (strings/comments gone).
function matchBrace(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ────────────────────────────────────────────────────────────── detectors ──
function makeFinding(file, category, severity, line, snippet, hint) {
  return { category, severity, file, line, snippet: snippet.slice(0, 160), hint };
}

const MARKER_WORDS = [
  { word: "TODO", category: "todo-marker" },
  { word: "FIXME", category: "todo-marker" },
  { word: "XXX", category: "marker" },
  { word: "HACK", category: "marker" },
];
const STUB_LANGUAGE = /\b(stub|placeholder|fake|fake implementation|dummy|not implemented|todo|fixme)\b/i;
const NOT_IMPLEMENTED_RE = /\bnot[ _-]?implemented\b|\bunimplemented\b|\bNotImplementedError\b/i;
const MOCK_SPECIFIER_RE = /(^|[/\\._-])mock(s)?([/\\._-]|$)/i; // 'mock', './mocks/x', 'mock-server', '__mocks__'
const MOCK_IDENT_RE = /\b(?:jest|vi)\.mock\s*\(|\bmock[A-Z_$][A-Za-z0-9_$]*|\bMOCKS?_[A-Za-z0-9_$]+|\bmocks?\b/g;

function severityFor(category, base, tier) {
  // base: severity in product code; drops one tier in tooling; test files are
  // informational for completeness purposes (their "502 not implemented" SMTP
  // chatter etc. is remote-side SIMULATION, not unfinished product work).
  if (tier === "test") return "info";
  if (tier !== "tooling") return base;
  return base === "critical" ? "warning" : base === "warning" ? "info" : "info";
}

function detectMarkers(rel, tier, src, push) {
  const maskedLines = maskStringsOnly(src).split("\n");
  const rawLines = src.split("\n");
  for (let ln = 0; ln < maskedLines.length; ln++) {
    // Marker words only count inside comments — identifiers like "TODOListMode"
    // and string contents like "TODO list feature" (a domain feature!) must not fire.
    const comment = commentRegionOfLine(maskedLines[ln]);
    if (!comment) continue;
    for (const { word, category } of MARKER_WORDS) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])${word}([^A-Za-z0-9_]|$)`);
      if (!re.test(comment)) continue;
      const severity = category === "todo-marker"
        ? severityFor("todo-marker", "critical", tier)
        : severityFor("marker", "warning", tier);
      push(makeFinding(rel, category, severity, ln + 1, (rawLines[ln] || "").trim(),
        category === "todo-marker"
          ? "TODO/FIXME left in code — finish the work or delete the marker"
          : "XXX/HACK annotation — replace the shortcut with a real implementation"));
      break; // one marker finding per line
    }
  }
}

function detectNotImplemented(rel, tier, src, masked, push) {
  const lines = src.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    if (NOT_IMPLEMENTED_RE.test(line)) {
      push(makeFinding(rel, "not-implemented", severityFor("not-implemented", "critical", tier), ln + 1,
        line.trim(), "declared not-implemented — implement it or remove the surface"));
    }
  }
}

function matchBraceAt(masked, openIdx) {
  return matchBrace(masked, openIdx);
}

function detectStubReturns(rel, tier, src, masked, push) {
  const lines = src.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const placeholderReturn = /^\s*return\s+(null|undefined|\{\}|\[\]|""|''|0)\s*;?\s*$/.test(line);
    if (!placeholderReturn) continue;
    const prev = ln > 0 ? lines[ln - 1] : "";
    const context = `${prev}\n${line}`;
    if (!STUB_LANGUAGE.test(context)) continue;
    push(makeFinding(rel, "stub-return", severityFor("stub-return", "critical", tier), ln + 1,
      line.trim(), "placeholder return annotated as stub/fake — implement the real behavior"));
  }
}

// Names that are conventional intentional no-ops in shipped code.
const NOOP_NAME_RE = /^(noo?p|noOpFn|identity|noopfn)$/i;

function detectEmptyFunctions(rel, tier, src, masked, push) {
  const re = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    if (NOOP_NAME_RE.test(m[1])) continue; // `function noop() {}` is an idiom, not a stub
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchBraceAt(masked, openIdx);
    if (closeIdx === -1) continue;
    const body = masked.slice(openIdx + 1, closeIdx).trim();
    if (body === "") {
      push(makeFinding(rel, "empty-function", severityFor("empty-function", "warning", tier),
        lineOf(src, m.index),
        `function ${m[1]}(${m[2].slice(0, 40)}) {} — empty body`,
        "empty function body in shipped code — either wire it up or delete it"));
    }
  }
  // named const arrow / const function with empty body
  const arrowRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\([^)]*\)\s*\{|\([^)]*\)\s*=>\s*\{|[A-Za-z_$][\w$]*\s*=>\s*\{)/g;
  while ((m = arrowRe.exec(masked)) !== null) {
    if (NOOP_NAME_RE.test(m[1])) continue;
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchBraceAt(masked, openIdx);
    if (closeIdx === -1) continue;
    const body = masked.slice(openIdx + 1, closeIdx).trim();
    if (body === "") {
      push(makeFinding(rel, "empty-function", severityFor("empty-function", "warning", tier),
        lineOf(src, m.index), `const ${m[1]} = ... {} — empty body`,
        "empty function body in shipped code — either wire it up or delete it"));
    }
  }
}

function detectMockInProduct(rel, tier, src, masked, push) {
  if (tier === "test") return; // mocks are LEGAL under test files (remote-end simulator)
  // (a) import / require of a module whose specifier looks like a mock
  const importRe = /\b(?:import\s+(?:[\w$*\s{},]*?\s+from\s+)?|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  const severity = severityFor("mock-in-product", "critical", tier);
  while ((m = importRe.exec(src)) !== null) {
    const spec = m[1];
    if (spec.startsWith("node:")) continue;
    if (MOCK_SPECIFIER_RE.test(spec) || /__mocks__/.test(spec)) {
      push(makeFinding(rel, "mock-in-product", severity, lineOf(src, m.index),
        lineTextAt(src, lineOf(src, m.index)),
        `imports mock module "${spec}" from a non-test file — mocks may live only under test files`));
    }
  }
  // (b) mock* identifiers used in real code (comments and strings already masked)
  MOCK_IDENT_RE.lastIndex = 0;
  while ((m = MOCK_IDENT_RE.exec(masked)) !== null) {
    push(makeFinding(rel, "mock-in-product", severity, lineOf(src, m.index),
      lineTextAt(src, lineOf(src, m.index)),
      "mock identifier in product code path — mocks are only allowed under test files"));
  }
}

function detect501Routes(rel, tier, src, masked, push) {
  const lines = src.split("\n");
  const use501 = /(status\s*\(\s*501\s*\)|sendJson\s*\(\s*[^,()]*,\s*501\b|writeHead\s*\(\s*501\b|statusCode\s*[:=]\s*501\b|http\.STATUS_CODES\.NOT_IMPLEMENTED)/;
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    if (!use501.test(line)) continue;
    if (NOT_IMPLEMENTED_RE.test(line) || /\b(stub|todo|fixme|dead route)\b/i.test(line)) {
      push(makeFinding(rel, "dead-501", severityFor("dead-501", "critical", tier), ln + 1, line.trim(),
        "501 route paired with not-implemented language — dead endpoint, implement or remove"));
    } else {
      push(makeFinding(rel, "http-501", "warning", ln + 1, line.trim(),
        "501 status returned — verify this is an intentional capability gate, not an unfinished route"));
    }
  }
}

function collectExports(masked) {
  const names = [];
  let m;
  const decl = /\bexport\s+(?:async\s+)?(?:function\s*\*?|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/g;
  while ((m = decl.exec(masked)) !== null) names.push(m[1]);
  const list = /\bexport\s*\{([^}]*)\}/g;
  while ((m = list.exec(masked)) !== null) {
    if (/from\s*['"`]/.test(m[1])) continue; // re-export pass-through: wiring lives in the source module
    for (const part of m[1].split(",")) {
      // `export { local as publicName }` — importers see publicName
      const pieces = part.split(/\bas\b/);
      const id = (pieces.length > 1 ? pieces[1] : pieces[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) names.push(id);
    }
  }
  return names;
}

function detectUnwiredExports(rel, tier, src, masked, corpus, push) {
  if (tier !== "product") return;
  const top = rel.split("/")[0];
  if (top === "bin") return; // entry scripts, never imported
  for (const name of collectExports(masked)) {
    if (name === "default" || name.length < 3 || name.startsWith("_")) continue;
    const re = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`);
    let referenced = false;
    for (const other of corpus) {
      if (other.rel === rel) continue;
      if (re.test(other.masked) || re.test(other.raw)) { referenced = true; break; }
    }
    if (!referenced) {
      push(makeFinding(rel, "unwired-export", "warning", -1,
        `export ... ${name}`,
        `exported symbol "${name}" is referenced nowhere outside its own file — a hook that was never wired up`));
    }
  }
}

function detectTestCodeInProduct(rel, tier, push) {
  const top = rel.split("/")[0];
  if (top !== "src") return;
  // Keyed off the product top-dir, NOT the tier: a test-named file under src/
  // classifies as test-tier (mocks legal there) but is still misplacement.
  const inTestDir = rel.split("/").slice(0, -1).some((s) => TEST_DIR_SEGMENTS.has(s.toLowerCase()));
  const testBase = TEST_BASENAME_RE.test(path.posix.basename(rel));
  if (testBase || inTestDir) {
    push(makeFinding(rel, "test-code-in-product", "warning", -1, rel,
      "test/spec file shipped inside the product tree (src/) — move it to scripts/ or test/"));
  }
}

function detectPlaceholderCopy(rel, tier, src, masked, push) {
  const re = /\bcoming soon\b|\bunder construction\b|\blorem ipsum\b/i;
  // Scoped to markup/styles, where the copy IS the rendered page. In code files
  // the same phrase inside a string/template is usually instruction or prompt
  // text (e.g. src/prompts.js forbidding lorem ipsum), not visible UI — so it
  // is out of scope here rather than a standing false positive.
  const ext = path.posix.extname(rel).toLowerCase();
  if (ext !== ".html" && ext !== ".htm" && ext !== ".css") return;
  const lines = src.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    if (re.test(lines[ln])) {
      push(makeFinding(rel, "placeholder-copy", "warning", ln + 1, lines[ln].trim(),
        'user-facing placeholder copy ("coming soon" etc.) — a visible half-done surface'));
    }
  }
}

// ────────────────────────────────────────────────────────────── scanning ──
export function walkFiles(root) {
  const out = [];
  const rootName = path.basename(path.resolve(root));
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name === rootName && path.resolve(dir) === path.resolve(root)) { /* root itself */ }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) continue;
        visit(abs);
      } else if (e.isFile() && CODE_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
        out.push(abs);
      }
    }
  };
  visit(root);
  return out;
}

export function scan(root) {
  const started = Date.now();
  const absRoot = path.resolve(root);
  const files = walkFiles(absRoot);
  const findings = [];

  const corpus = [];
  for (const abs of files) {
    let raw = "";
    try { raw = fs.readFileSync(abs, "utf8"); } catch { continue; }
    const { rel, tier } = classifyFile(absRoot, abs);
    corpus.push({ rel, raw, masked: maskCommentsAndStrings(raw), tier });
  }

  for (const f of corpus) {
    const self = isSelfFile(f.rel);
    const push = (finding) => {
      if (self && LEXICAL_CATEGORIES.has(finding.category)) return; // self-exemption
      findings.push(finding);
    };
    detectMarkers(f.rel, f.tier, f.raw, push);
    detectNotImplemented(f.rel, f.tier, f.raw, f.masked, push);
    detectStubReturns(f.rel, f.tier, f.raw, f.masked, push);
    detectEmptyFunctions(f.rel, f.tier, f.raw, f.masked, push);
    detectMockInProduct(f.rel, f.tier, f.raw, f.masked, push);
    detect501Routes(f.rel, f.tier, f.raw, f.masked, push);
    detectUnwiredExports(f.rel, f.tier, f.raw, f.masked, corpus, push);
    detectTestCodeInProduct(f.rel, f.tier, push);
    detectPlaceholderCopy(f.rel, f.tier, f.raw, f.masked, push);
  }

  findings.sort((a, b) =>
    (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) ||
    a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0));

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const byCategory = {};
  for (const f of findings) byCategory[f.category] = (byCategory[f.category] || 0) + 1;

  return {
    root: absRoot,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    filesScanned: corpus.length,
    counts,
    byCategory,
    exitCode: counts.critical > 0 ? 1 : 0,
    findings,
  };
}

// The audit engine's own file necessarily contains every trigger pattern as
// DATA (regex tables, this header). Lexical self-detection there is definitionally
// a false positive, so only structural checks run against it. Documented in
// docs/COMPLETENESS-AUDIT.md.
const SELF_FILE = "scripts/audit-completeness.mjs";
const LEXICAL_CATEGORIES = new Set([
  "todo-marker", "marker", "not-implemented", "stub-return",
  "mock-in-product", "dead-501", "http-501", "placeholder-copy",
]);

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

function isSelfFile(rel) {
  const n = toPosix(rel);
  return n === SELF_FILE || n.endsWith("/" + SELF_FILE);
}

// ────────────────────────────────────────────────────────────── reporting ──
export function renderMarkdown(report) {
  const L = [];
  L.push("# Completeness Audit Report");
  L.push("");
  L.push(`- Generated: ${report.generatedAt}`);
  L.push(`- Root: \`${report.root}\``);
  L.push(`- Files scanned: ${report.filesScanned}`);
  L.push(`- Scan duration: ${report.durationMs} ms`);
  L.push(`- Verdict: **${report.counts.critical > 0 ? "INCOMPLETE" : "no critical findings"}** — ` +
    `${report.counts.critical} critical / ${report.counts.warning} warning / ${report.counts.info} info`);
  L.push(`- Exit code: ${report.exitCode}`);
  L.push("");
  L.push("## Summary by category");
  L.push("");
  L.push("| category | count |");
  L.push("|---|---|");
  const cats = Object.entries(report.byCategory).sort((a, b) => b[1] - a[1]);
  if (cats.length === 0) L.push("| (none) | 0 |");
  for (const [c, n] of cats) L.push(`| ${c} | ${n} |`);
  L.push("");
  for (const severity of ["critical", "warning", "info"]) {
    const items = report.findings.filter((f) => f.severity === severity);
    L.push(`## ${severity.charAt(0).toUpperCase() + severity.slice(1)} (${items.length})`);
    L.push("");
    if (items.length === 0) { L.push("(none)"); L.push(""); continue; }
    for (const f of items) {
      const loc = f.line > 0 ? `:${f.line}` : "";
      L.push(`- **${f.category}** \`${f.file}${loc}\` — ${f.snippet}`);
      L.push(`  - hint: ${f.hint}`);
    }
    L.push("");
  }
  L.push("## Methodology");
  L.push("");
  L.push("Static scan over code files (.js/.mjs/.cjs/.jsx/.ts/.tsx/.html/.css) under the root,");
  L.push("excluding node_modules, build outputs, generated clone output, artifacts and fixtures.");
  L.push("Comments and string contents are masked before identifier-level checks so documentation");
  L.push("phrases (\"no mocks here\") cannot create findings, while marker words inside comments still do.");
  L.push("Severity tiers: product code (src/, bin/, platform-ui/, dashboard/) is strict; scripts/docs tier down;");
  L.push("findings inside test files are informational (remote-side simulation data is not unfinished product work).");
  L.push("Mocks are legal ONLY under test files, where they stand in for the REMOTE third-party side.");
  L.push("The audit engine's own file (scripts/audit-completeness.mjs) is exempt from lexical");
  L.push("self-detection — its regex tables contain every trigger pattern as data.");
  L.push("Detector reference: docs/COMPLETENESS-AUDIT.md. Sensitivity proof: scripts/test-audit-completeness.mjs");
  L.push("(seeded fixture fixtures/completeness-audit/ — every seeded violation is asserted caught).");
  L.push("");
  return L.join("\n");
}

// ──────────────────────────────────────────────────────────────── main ──
function parseArgs(argv) {
  const args = { root: null, out: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") args.root = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--json") args.json = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

async function main() {
  const self = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(self), "..");
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/audit-completeness.mjs [--root DIR] [--out PATH] [--json PATH]");
    return;
  }
  const root = args.root ? path.resolve(args.root) : projectRoot;
  const outPath = args.out ? path.resolve(args.out) : path.join(projectRoot, "output", "completeness-report.md");
  const jsonPath = args.json ? path.resolve(args.json) : outPath.replace(/\.md$/, ".json");

  const report = scan(root);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderMarkdown(report), "utf8");
  if (jsonPath !== outPath) {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  }

  console.log(`completeness-audit: scanned ${report.filesScanned} files under ${report.root}`);
  console.log(`  critical: ${report.counts.critical}  warning: ${report.counts.warning}  info: ${report.counts.info}`);
  for (const [c, n] of Object.entries(report.byCategory)) console.log(`  ${c}: ${n}`);
  console.log(`  report: ${outPath}`);
  console.log(`  verdict: ${report.counts.critical > 0 ? "INCOMPLETE (criticals present)" : "no critical findings"}`);
  process.exitCode = report.exitCode;
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
