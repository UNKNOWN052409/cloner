#!/usr/bin/env node
// Task 4.2.5 verification — Kubernetes PROFILE (control-plane + regional
// workers + HPA manifests in k8s/).
//
//   node scripts/test-k8s-manifests.mjs
//
// Sections (each prints PASS/FAIL/SKIP; any FAIL exits non-zero):
//
//   1. [unit]        YAML-subset parser self-tests. The parser below is the
//                    only YAML reader that does not depend on anything outside
//                    this repository, so it is unit-tested first.
//   2. [structure]   Manifest structure validation (ALWAYS runs, no cluster):
//                    parse every k8s/*.yaml, verify kind coverage, namespace,
//                    selectors↔labels, resource requests+limits, security
//                    context, probe paths cross-checked against the REAL
//                    src/platform/health-routes.js routes, PVC references,
//                    secret-ref discipline (no secret values inlined anywhere),
//                    regional pools structurally identical, HPA targets exist.
//   3. [env-schema]  Assembles ConfigMap + Secret keys from the manifests and
//                    runs the REAL src/config-schema.js validateEnv() for the
//                    api / worker / migrator roles in production mode, plus
//                    negative controls proving the check engages.
//   4. [pyyaml]      Independent-parser agreement: when python + PyYAML are
//                    installed, every manifest is parsed a second time and the
//                    two parse trees must be deep-equal. Missing python →
//                    SKIP loudly (the structure section still ran).
//   5. [live-cluster] Only when kubectl is installed, a kubeconfig exists
//                    (KUBECONFIG or ~/.kube/config) AND the cluster answers:
//                    applies every manifest into a THROWAWAY namespace
//                    (namespace token rewritten per file), verifies the
//                    created resource set, then deletes the namespace.
//                    Any gate missing → SKIP loudly with the exact reason.
//
// No mocks: section 2/3 validate the real shipped manifests against the real
// product source; section 5 talks to a real API server when one exists.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEnv, SECRET_KEYS } from "../src/config-schema.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const K8S_DIR = path.join(ROOT, "k8s");
const results = { pass: 0, fail: 0, skip: 0 };

function pass(name, detail = "") {
  results.pass++;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  results.fail++;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}
function skip(name, detail = "") {
  results.skip++;
  console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ""}`);
}
function ok(cond, name, detail = "") {
  cond ? pass(name, detail) : fail(name, detail);
}
function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
}

// ===========================================================================
// 1. YAML-subset parser (block maps/sequences, quoted + plain scalars, flow
//    collections, quote-aware comments, multi-document). Manifests in k8s/
//    intentionally stay inside this subset; anything outside it is a hard
//    parse error, never a silent mis-parse.
// ===========================================================================

class YamlParseError extends Error {
  constructor(msg, lineNo) {
    super(lineNo ? `yaml line ${lineNo}: ${msg}` : msg);
    this.name = "YamlParseError";
  }
}

/** Strip a trailing comment that is OUTSIDE quotes. "#" must start the line
 *  content or follow whitespace (YAML rule); "foo#bar" survives. */
function stripComment(text, lineNo) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i++; // skip escaped char
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  if (quote !== null) throw new YamlParseError("unterminated quote", lineNo);
  return text.trimEnd();
}

function tokenize(text) {
  const lines = [];
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  for (let idx = 0; idx < raw.length; idx++) {
    const lineNo = idx + 1;
    if (/^\s*---\s*(#.*)?$/.test(raw[idx])) return { lines, docSeps: true }; // caller splits docs
    let line = raw[idx];
    const indent = line.length - line.trimStart().length;
    if (line.includes("\t") && line.trim() !== "") {
      throw new YamlParseError("tabs are not allowed for indentation", lineNo);
    }
    const content = stripComment(line.trim(), lineNo);
    if (content === "") continue;
    lines.push({ no: lineNo, indent, content });
  }
  return { lines, docSeps: false };
}

const isSeqItem = (t) => t.content === "-" || t.content.startsWith("- ");

/** Split "key: value" at the first ':' that is followed by space/EOL and not
 *  inside quotes. Plain keys only (dots/slashes are fine inside them). */
function splitKey(token) {
  let quote = null;
  for (let i = 0; i < token.content.length; i++) {
    const ch = token.content[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":" && (i + 1 === token.content.length || /\s/.test(token.content[i + 1]))) {
      const key = token.content.slice(0, i).trim();
      const rest = token.content.slice(i + 1).trim();
      if (key === "") throw new YamlParseError("empty key", token.no);
      return { key, rest, lineNo: token.no };
    }
  }
  throw new YamlParseError(`expected "key: value", got: ${token.content.slice(0, 80)}`, token.no);
}

function unquote(s, lineNo) {
  if (s.startsWith('"')) {
    // double-quoted: find the closing quote honoring backslash escapes
    let out = "";
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\\") {
        const esc = s[++i];
        const map = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "0": "\0" };
        if (!(esc in map)) throw new YamlParseError(`unsupported escape \\${esc}`, lineNo);
        out += map[esc];
      } else if (ch === '"') {
        if (s.slice(i + 1).trim() !== "") throw new YamlParseError("text after closing quote", lineNo);
        return out;
      } else out += ch;
    }
    throw new YamlParseError("unterminated double-quoted scalar", lineNo);
  }
  if (s.startsWith("'")) {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        if (s.slice(i + 1).trim() !== "") throw new YamlParseError("text after closing quote", lineNo);
        return out;
      }
      out += s[i];
    }
    throw new YamlParseError("unterminated single-quoted scalar", lineNo);
  }
  throw new YamlParseError("not a quoted scalar", lineNo);
}

function coercePlain(s) {
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~" || s === "") return null;
  return s; // k8s values like "4180"-quoted, "20Gi", "250m", URLs stay strings
}

/** Flow collections: [a, b] / {k: v, k2: v2} — minimal but correct for the
 *  constructs manifests may legitimately use. */
function parseFlow(s, lineNo) {
  let i = 0;
  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  function parseNode() {
    skipWs();
    if (s[i] === "[") {
      i++;
      const arr = [];
      skipWs();
      if (s[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseNode());
        skipWs();
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "]") {
          i++;
          return arr;
        }
        throw new YamlParseError(`bad flow sequence near "${s.slice(i, i + 20)}"`, lineNo);
      }
    }
    if (s[i] === "{") {
      i++;
      const obj = {};
      skipWs();
      if (s[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        skipWs();
        const keyMatch = /^[^:,{}[\]]+/.exec(s.slice(i));
        if (!keyMatch) throw new YamlParseError("bad flow map key", lineNo);
        const key = keyMatch[0].trim();
        i += keyMatch[0].length;
        skipWs();
        if (s[i] !== ":") throw new YamlParseError(`flow map key "${key}" missing ':'`, lineNo);
        i++;
        obj[key] = parseNode();
        skipWs();
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "}") {
          i++;
          return obj;
        }
        throw new YamlParseError("bad flow map", lineNo);
      }
    }
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      let j = i + 1;
      while (j < s.length && s[j] !== q) j += q === '"' && s[j] === "\\" ? 2 : 1;
      if (j >= s.length) throw new YamlParseError("unterminated quoted flow scalar", lineNo);
      const inner = s.slice(i, j + 1);
      i = j + 1;
      return unquote(inner, lineNo);
    }
    // plain flow scalar: up to a top-level , ] }
    let j = i;
    while (j < s.length && !",]}".includes(s[j])) j++;
    const raw = s.slice(i, j).trim();
    i = j;
    return coercePlain(raw);
  }
  const value = parseNode();
  skipWs();
  if (i < s.length) throw new YamlParseError(`trailing text after flow value: "${s.slice(i, i + 20)}"`, lineNo);
  return value;
}

function scalarValue(s, lineNo) {
  const t = s.trim();
  if (t === "") return null;
  if (t.startsWith('"') || t.startsWith("'")) return unquote(t, lineNo);
  if (t.startsWith("[") || t.startsWith("{")) return parseFlow(t, lineNo);
  return coercePlain(t);
}

/** Parse one block (map or sequence) whose entries sit at exactly `indent`. */
function parseBlock(lines, i, indent) {
  if (i >= lines.length) throw new YamlParseError("unexpected end of document");
  if (lines[i].indent < indent) throw new YamlParseError("block missing", lines[i].no);
  if (isSeqItem(lines[i])) return parseSeq(lines, i, indent);
  return parseMap(lines, i, indent);
}

function parseMap(lines, i, indent) {
  const map = {};
  while (i < lines.length && lines[i].indent === indent && !isSeqItem(lines[i])) {
    const { key, rest, lineNo } = splitKey(lines[i]);
    if (rest !== "") {
      map[key] = scalarValue(rest, lineNo);
      i++;
      // a deeper-indented line right after an inline scalar is a multi-line
      // scalar continuation — unsupported subset, fail loudly
      if (i < lines.length && lines[i].indent > indent && !isSeqItem(lines[i])) {
        throw new YamlParseError(
          `multi-line scalars are outside the supported subset (continuation of "${key}")`,
          lines[i].no
        );
      }
    } else if (i + 1 < lines.length && lines[i + 1].indent > indent) {
      const childIndent = lines[i + 1].indent;
      const [v, ni] = parseBlock(lines, i + 1, childIndent);
      map[key] = v;
      i = ni;
    } else if (i + 1 < lines.length && lines[i + 1].indent === indent && isSeqItem(lines[i + 1])) {
      // YAML allows a block sequence at the SAME indent as its key
      const [v, ni] = parseSeq(lines, i + 1, indent);
      map[key] = v;
      i = ni;
    } else {
      map[key] = null;
      i++;
    }
  }
  if (i < lines.length && lines[i].indent > indent && !isSeqItem(lines[i])) {
    throw new YamlParseError(`unexpected deeper indentation (map at indent ${indent})`, lines[i].no);
  }
  return [map, i];
}

function parseSeq(lines, i, indent) {
  const arr = [];
  while (i < lines.length && lines[i].indent === indent && isSeqItem(lines[i])) {
    const item = lines[i];
    const afterDash = item.content.slice(1);
    if (afterDash.trim() === "") {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [v, ni] = parseBlock(lines, i + 1, lines[i + 1].indent);
        arr.push(v);
        i = ni;
      } else {
        arr.push(null);
        i++;
      }
      continue;
    }
    const spaces = afterDash.length - afterDash.trimStart().length;
    const restContent = afterDash.trim();
    // inline scalar item ("- sh", "- -c", "- node app.js") — unless it looks
    // like "key: value", in which case it starts an inline map
    const looksLikeKey = /:(\s|$)/.test(restContent.replace(/"[^"]*"|'[^']*'/g, ""));
    if (!looksLikeKey) {
      arr.push(scalarValue(restContent, item.no));
      i++;
      continue;
    }
    // inline map item: "- name: x" behaves as if "name: x" were indented by
    // (dash offset + following spaces) — rewrite and parse from there
    const virtualIndent = indent + 1 + spaces;
    const virtualLines = [{ no: item.no, indent: virtualIndent, content: restContent }, ...lines.slice(i + 1)];
    const [v, ni] = parseBlock(virtualLines, 0, virtualIndent);
    arr.push(v);
    i = i + ni; // virtualLines[0] ↔ original lines[i]; virtualLines[ni] ↔ lines[i + ni]
  }
  return [arr, i];
}

/** Parse one YAML document (already split from the file). */
function parseYamlDoc(text) {
  const { lines } = tokenize(text);
  if (lines.length === 0) return null;
  const [doc, consumed] = parseBlock(lines, 0, lines[0].indent);
  if (consumed < lines.length) {
    throw new YamlParseError(
      `unexpected content after block end: "${lines[consumed].content.slice(0, 60)}"`,
      lines[consumed].no
    );
  }
  return doc;
}

/** Parse a whole file into an array of documents ("" docs skipped). */
function parseYamlFile(text) {
  const docs = [];
  let current = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*---\s*(#.*)?$/.test(raw)) {
      const t = current.join("\n");
      const doc = t.trim() === "" ? null : parseYamlDoc(t);
      if (doc !== null) docs.push(doc);
      current = [];
    } else {
      current.push(raw);
    }
  }
  const t = current.join("\n");
  if (t.trim() !== "") {
    const doc = parseYamlDoc(t);
    if (doc !== null) docs.push(doc);
  }
  return docs;
}

// ---------------------------------------------------------------------------
// helpers used across sections
// ---------------------------------------------------------------------------
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}
const canonJson = (v) => JSON.stringify(canonical(v));
const getIn = (obj, dottedPath) =>
  dottedPath.split(".").reduce((acc, k) => (acc === undefined || acc === null ? undefined : acc[k]), obj);
const s = (v) => (v === undefined || v === null ? String(v) : String(v));
function isQuantityOk(q) {
  return typeof q === "string" && /^\d+(\.\d+)?(m|Ki|Mi|Gi|Ti)?$/.test(q);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: opts.timeout || 120000,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    input: opts.input,
  });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

// ===========================================================================
// Load manifests once, shared by all sections
// ===========================================================================
const expectedFiles = [
  "00-namespace.yaml",
  "10-configmap.yaml",
  "20-secrets.yaml.example",
  "25-storage.yaml",
  "30-control-plane.yaml",
  "40-workers.yaml",
  "50-hpa.yaml",
  "README.md",
];

let FILES = null; // [{name, text, docs}]
function loadManifests() {
  if (FILES) return FILES;
  FILES = [];
  for (const name of fs.readdirSync(K8S_DIR).sort()) {
    if (!name.endsWith(".yaml") && !name.endsWith(".yaml.example")) continue;
    const text = fs.readFileSync(path.join(K8S_DIR, name), "utf8");
    FILES.push({ name, text, docs: parseYamlFile(text) });
  }
  return FILES;
}

// ===========================================================================
// Section 1 — parser unit tests
// ===========================================================================
function parserSelfTests() {
  section("1. [unit] YAML-subset parser self-tests");
  const cases = [
    ["simple map", "a: 1\nb: two\n", { a: 1, b: "two" }],
    ["quoted + escapes", 'a: "x\\"y"\nb: \'it\'\'s\'\n', { a: 'x"y', b: "it's" }],
    ["comment stripping", "a: value # trailing\n# whole line\nb: 'keep # inside'\n", { a: "value", b: "keep # inside" }],
    ["nested map", "outer:\n  inner: 7\n  deep:\n    x: y\n", { outer: { inner: 7, deep: { x: "y" } } }],
    ["seq of scalars", "list:\n  - a\n  - b\n", { list: ["a", "b"] }],
    ["seq of maps", "items:\n  - name: one\n    v: 1\n  - name: two\n    v: 2\n", { items: [{ name: "one", v: 1 }, { name: "two", v: 2 }] }],
    ["seq inline map start", "c:\n  command:\n    - sh\n    - -c\n    - node app.js\n", { c: { command: ["sh", "-c", "node app.js"] } }],
    ["empty nested block", "a:\nb: 2\n", { a: null, b: 2 }],
    ["flow seq", "a: [x, y, 3]\n", { a: ["x", "y", 3] }],
    ["flow map", "a: {k: v, n: 4}\n", { a: { k: "v", n: 4 } }],
    ["url colon value", "REDIS_URL: \"redis://redis:6379\"\nimage: cloner-platform:latest\n", { REDIS_URL: "redis://redis:6379", image: "cloner-platform:latest" }],
    ["key with dots/slashes", "app.kubernetes.io/name: cloner\ncloner.io/region: us-east-1\n", { "app.kubernetes.io/name": "cloner", "cloner.io/region": "us-east-1" }],
    ["quantity scalars", "storage: 20Gi\ncpu: \"1\"\nmem: 1536Mi\npct: 70\n", { storage: "20Gi", cpu: "1", mem: "1536Mi", pct: 70 }],
    ["seq at same indent as key", "values:\n- a\n- b\n", { values: ["a", "b"] }],
    ["seq nested block item", "spec:\n  template:\n    spec:\n      containers:\n        - name: api\n          ports:\n            - name: http\n              containerPort: 4180\n", { spec: { template: { spec: { containers: [{ name: "api", ports: [{ name: "http", containerPort: 4180 }] }] } } } }],
    ["empty flow seq", "a: []\n", { a: [] }],
    ["hash inside plain value", "image: foo#bar\n", { image: "foo#bar" }],
  ];
  for (const [name, input, expected] of cases) {
    try {
      const got = parseYamlDoc(input);
      ok(canonJson(got) === canonJson(expected), `parser: ${name}`, canonJson(got) === canonJson(expected) ? "" : `got ${JSON.stringify(got)}`);
    } catch (e) {
      fail(`parser: ${name}`, `threw ${e.message}`);
    }
  }
  // multi-doc
  try {
    const docs = parseYamlFile("kind: A\nmetadata:\n  name: one\n---\nkind: B\nmetadata:\n  name: two\n");
    ok(docs.length === 2 && docs[0].kind === "A" && docs[1].metadata.name === "two", "parser: multi-document split");
  } catch (e) {
    fail("parser: multi-document split", e.message);
  }
  // malformed input must throw, not silently mis-parse
  try {
    parseYamlDoc("a: 1\n   b: 2\n");
    fail("parser: rejects mid-scalar continuation", "no error thrown");
  } catch (e) {
    ok(e.name === "YamlParseError", "parser: rejects mid-scalar continuation", e.message);
  }
  try {
    parseYamlDoc('a: "unclosed\n');
    fail("parser: rejects unterminated quote", "no error thrown");
  } catch (e) {
    ok(e.name === "YamlParseError", "parser: rejects unterminated quote", e.message);
  }
}

// ===========================================================================
// Section 2 — structure
// ===========================================================================
function structuralChecks({ healthRoutesSrc, serverSrc }) {
  section("2. [structure] manifest structure (always runs)");
  const files = loadManifests();

  // 2.0 files exist and all parse
  for (const f of expectedFiles) {
    ok(fs.existsSync(path.join(K8S_DIR, f)), `file exists: k8s/${f}`);
  }
  const appliedFiles = files.filter((f) => f.name.endsWith(".yaml")); // .example excluded from apply
  ok(
    appliedFiles.length === expectedFiles.filter((f) => f.endsWith(".yaml")).length,
    "no stray/unexpected yaml files in k8s/",
    appliedFiles.map((f) => f.name).join(", ")
  );
  for (const f of files) {
    ok(f.docs.length >= 1, `parses: k8s/${f.name}`, `${f.docs.length} document(s)`);
    for (const d of f.docs) {
      ok(
        typeof d.apiVersion === "string" && d.apiVersion.length > 0,
        `${f.name}: document has apiVersion`,
        s(d.apiVersion)
      );
      ok(typeof d.kind === "string" && d.kind.length > 0, `${f.name}: document has kind`, s(d.kind));
    }
  }

  const byKind = {};
  const byName = {};
  for (const f of files) {
    for (const d of f.docs) {
      (byKind[d.kind] ||= []).push(d);
      if (d.metadata?.name) byName[d.metadata.name] = d;
    }
  }
  const deployments = byKind.Deployment || [];
  const deployment = (name) => deployments.find((d) => d.metadata.name === name);

  // 2.1 namespace
  const nsDoc = (byKind.Namespace || [])[0];
  ok(nsDoc && nsDoc.metadata.name === "cloner", "Namespace 'cloner' declared");

  // every namespaced doc lives in namespace cloner
  const namespacedKinds = ["ConfigMap", "Secret", "PersistentVolumeClaim", "Deployment", "Service", "Job", "HorizontalPodAutoscaler"];
  let nsOk = true;
  for (const f of files) {
    for (const d of f.docs) {
      if (namespacedKinds.includes(d.kind) && d.metadata?.namespace !== "cloner") {
        nsOk = false;
        fail(`namespace: ${f.name} ${d.kind} ${d.metadata?.name}`, `metadata.namespace=${s(d.metadata?.namespace)}`);
      }
    }
  }
  if (nsOk) pass("every namespaced document targets namespace cloner");

  // 2.2 ConfigMap — non-secret config surface
  const cm = byKind.ConfigMap?.find((d) => d.metadata.name === "cloner-config");
  ok(!!cm, "ConfigMap cloner-config present");
  const requiredCmKeys = [
    "NODE_ENV", "PORT", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER",
    "RETENTION_DAYS", "PURGE_CREDS_ON_DONE", "MAX_CONCURRENT",
    "CLONER_HEARTBEAT_MS", "CLONER_HEARTBEAT_TTL",
  ];
  for (const k of requiredCmKeys) {
    ok(cm && typeof cm.data?.[k] === "string" && cm.data[k] !== "", `configmap has ${k}`, s(cm?.data?.[k]));
  }
  ok(cm?.data?.NODE_ENV === "production", "configmap NODE_ENV=production (fail-loud boot validation)");
  ok(cm?.data?.PORT === "4180", "configmap PORT=4180 (matches Service targetPort + Dockerfile EXPOSE)");
  ok(/^\d+$/.test(s(cm?.data?.MAX_CONCURRENT)) && Number(cm.data.MAX_CONCURRENT) >= 1 && Number(cm.data.MAX_CONCURRENT) <= 32,
    "configmap MAX_CONCURRENT within schema bounds 1..32", s(cm?.data?.MAX_CONCURRENT));
  const secretInCm = (cm?.data ? Object.keys(cm.data) : []).filter((k) => SECRET_KEYS.includes(k));
  ok(secretInCm.length === 0, "configmap carries NO secret keys", secretInCm.join(", ") || `checked against SECRET_KEYS from src/config-schema.js (${SECRET_KEYS.join(", ")})`);

  // 2.3 Secret template — placeholders only, never applied, referenced by name
  const secretFile = files.find((f) => f.name === "20-secrets.yaml.example");
  ok(!!secretFile, "secret template k8s/20-secrets.yaml.example present");
  ok(secretFile && secretFile.name.endsWith(".yaml.example"), "secret template is NOT *.yaml (kubectl apply -f k8s/ cannot pick it up)");
  const secretDoc = secretFile?.docs.find((d) => d.kind === "Secret");
  ok(secretDoc?.metadata.name === "cloner-secrets", "secret template declares Secret cloner-secrets");
  const sd = secretDoc?.stringData || {};
  ok(typeof sd.PGPASSWORD === "string" && sd.PGPASSWORD.startsWith("REPLACE_"), "template PGPASSWORD is a REPLACE_ placeholder", s(sd.PGPASSWORD));
  ok(typeof sd.REDIS_URL === "string" && sd.REDIS_URL.startsWith("REPLACE_"), "template REDIS_URL is a REPLACE_ placeholder");
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CUSTOM_API_KEY"]) {
    ok(sd[k] === "", `template optional key ${k} is empty (disabled, not bogus)`, s(sd[k]));
  }
  ok(
    SECRET_KEYS.every((k) => k in sd),
    "secret template covers every SECRET_KEY from src/config-schema.js",
    SECRET_KEYS.join(", ")
  );

  // 2.4 PVCs
  const pvcs = byKind.PersistentVolumeClaim || [];
  const pvcNames = pvcs.map((p) => p.metadata.name);
  for (const name of ["cloner-artifacts", "cloner-platform-data"]) {
    const pvc = pvcs.find((p) => p.metadata.name === name);
    ok(!!pvc, `PVC ${name} present`);
    ok(
      pvc?.spec?.accessModes?.includes("ReadWriteMany"),
      `PVC ${name} accessModes include ReadWriteMany (HPA-scaled api + regional workers share the volume)`,
      JSON.stringify(pvc?.spec?.accessModes)
    );
    ok(isQuantityOk(s(pvc?.spec?.resources?.requests?.storage)), `PVC ${name} storage request is a valid quantity`, s(pvc?.spec?.resources?.requests?.storage));
  }

  // 2.5 workloads
  const api = deployment("cloner-api");
  ok(!!api, "Deployment cloner-api present");
  const workerDeps = deployments.filter((d) => d.metadata.labels?.["app.kubernetes.io/component"] === "worker");
  ok(workerDeps.length >= 2, "regional worker pools present (>=2 Deployments)", workerDeps.map((d) => d.metadata.name).join(", "));
  const migrator = byKind.Job?.find((j) => j.metadata.name === "cloner-migrator");
  ok(!!migrator, "one-shot migrator Job present");

  // shared workload invariants
  const workloadContainers = []; // {owner, container}
  function checkDeploymentCommon(dep, kindLabel) {
    const name = dep.metadata.name;
    ok(dep.metadata.namespace === "cloner", `${kindLabel} ${name}: namespace cloner`);
    ok(dep.spec?.selector?.matchLabels && Object.keys(dep.spec.selector.matchLabels).length > 0, `${name}: spec.selector.matchLabels present`);
    const tplLabels = dep.spec?.template?.metadata?.labels || {};
    const selOk = Object.entries(dep.spec?.selector?.matchLabels || {}).every(([k, v]) => tplLabels[k] === v);
    ok(selOk, `${name}: selector matches template labels`);
    const pod = dep.spec?.template?.spec || {};
    const sc = pod.securityContext || {};
    ok(sc.runAsNonRoot === true, `${name}: pod runs as non-root`);
    ok(sc.runAsUser === 1000, `${name}: runs as uid 1000 (image 'node' user)`);
    ok(sc.fsGroup === 1000, `${name}: fsGroup 1000 (PVC mounts group-writable)`);
    ok(sc.seccompProfile?.type === "RuntimeDefault", `${name}: seccompProfile RuntimeDefault`);
    const containers = pod.containers || [];
    ok(containers.length >= 1, `${name}: has containers`);
    for (const c of containers) {
      workloadContainers.push({ owner: name, container: c, pod, dep });
      ok(typeof c.image === "string" && c.image.length > 0, `${name}: container ${c.name} has image`, s(c.image));
      ok(typeof c.imagePullPolicy === "string" && c.imagePullPolicy.length > 0, `${name}: container ${c.name} has explicit imagePullPolicy`, s(c.imagePullPolicy));
      ok(Array.isArray(c.command) && c.command.length > 0, `${name}: container ${c.name} has explicit command`);
      const res = c.resources || {};
      const req = res.requests || {};
      const lim = res.limits || {};
      ok(isQuantityOk(s(req.cpu)) && isQuantityOk(s(req.memory)), `${name}: container ${c.name} resource REQUESTS cpu+memory`, JSON.stringify(req));
      ok(isQuantityOk(s(lim.cpu)) && isQuantityOk(s(lim.memory)), `${name}: container ${c.name} resource LIMITS cpu+memory`, JSON.stringify(lim));
      const envFromNames = (c.envFrom || []).map((e) => e.configMapRef?.name || e.secretRef?.name);
      ok(envFromNames.includes("cloner-config"), `${name}: envFrom references ConfigMap cloner-config`, envFromNames.join(", "));
      ok(envFromNames.includes("cloner-secrets"), `${name}: envFrom references Secret cloner-secrets (secrets-ref, no inline values)`, envFromNames.join(", "));
      // no secret key may carry a literal value
      for (const e of c.env || []) {
        if (SECRET_KEYS.includes(e.name)) {
          ok(e.value === undefined && e.valueFrom !== undefined, `${name}: secret env ${e.name} uses valueFrom, not a literal`);
        }
      }
      ok(c.securityContext?.allowPrivilegeEscalation === false, `${name}: container ${c.name} allowPrivilegeEscalation=false (restricted PSA)`);
      ok(Array.isArray(c.securityContext?.capabilities?.drop) && c.securityContext.capabilities.drop.includes("ALL"),
        `${name}: container ${c.name} capabilities drop ALL`);
    }
    return { pod, containers };
  }

  const apiInfo = api ? checkDeploymentCommon(api, "api deployment") : null;
  for (const dep of workerDeps) checkDeploymentCommon(dep, "worker deployment");

  // api-specific: probes against the REAL health routes, artifacts mounts, cwd
  if (api && apiInfo) {
    const c = apiInfo.containers[0];
    const cmdText = (c.command || []).join(" ");
    ok(cmdText.includes("src/config-schema.js") && cmdText.includes("api"), "api command validates the 'api' role via src/config-schema.js", cmdText);
    ok(cmdText.includes("bin/platform.js"), "api command boots bin/platform.js");
    const port = (c.ports || []).find((p) => p.containerPort === 4180);
    ok(!!port && port.name === "http", "api exposes containerPort 4180 named http");
    const probePathOk = (probe, expectedPath) =>
      probe?.httpGet?.path === expectedPath && (probe.httpGet.port === "http" || probe.httpGet.port === 4180);
    ok(probePathOk(c.livenessProbe, "/healthz"), "api livenessProbe → /healthz:4180");
    ok(probePathOk(c.readinessProbe, "/readyz"), "api readinessProbe → /readyz:4180 (db+queue+migrations gate traffic)");
    ok(probePathOk(c.startupProbe, "/healthz"), "api startupProbe → /healthz:4180");
    if (healthRoutesSrc) {
      const hasHealthz = healthRoutesSrc.includes('router.get("/healthz"');
      const hasReadyz = healthRoutesSrc.includes('router.get("/readyz"');
      ok(hasHealthz && hasReadyz, "probe paths exist in src/platform/health-routes.js (real route cross-check)");
      if (!hasHealthz || !hasReadyz) fail("probe path cross-check", "health-routes.js no longer defines /healthz and/or /readyz — update 30-control-plane.yaml");
    }
    for (const mount of ["/app/artifacts", "/app/platform-data"]) {
      ok(
        (c.volumeMounts || []).some((m) => m.mountPath === mount),
        `api mounts ${mount}`,
        JSON.stringify((c.volumeMounts || []).map((m) => m.mountPath))
      );
    }
    ok(c.workingDir === "/app", "api workingDir=/app (server.js serves artifacts from process.cwd()/artifacts)");
    if (serverSrc) {
      ok(serverSrc.includes('process.cwd(), "artifacts"'), "server.js still resolves artifacts from process.cwd()/artifacts — workingDir contract holds");
    }
    ok(api.spec?.strategy?.type === "RollingUpdate" && s(api.spec.strategy?.rollingUpdate?.maxUnavailable) === "0",
      "api rolling update keeps maxUnavailable=0 (no traffic gap)");
    ok(Number(api.spec?.replicas) >= 2, "api starts with >=2 replicas (HA control plane)", s(api.spec?.replicas));
  }

  // migrator job
  if (migrator) {
    const t = migrator.spec?.template?.spec || {};
    ok(t.restartPolicy === "Never", "migrator restartPolicy Never");
    ok(migrator.spec?.backoffLimit === 0, "migrator backoffLimit 0 (fail loudly, no retry-hiding)");
    const c = (t.containers || [])[0] || {};
    const cmd = Array.isArray(c.command) ? c.command.join(" ") : s(c.command);
    ok(cmd.includes("src/config-schema.js") && cmd.includes("migrator"), "migrator runs 'node src/config-schema.js migrator'", cmd);
    const envFromNames = (c.envFrom || []).map((e) => e.configMapRef?.name || e.secretRef?.name);
    ok(envFromNames.includes("cloner-config") && envFromNames.includes("cloner-secrets"), "migrator gets config+secrets via envFrom refs");
    ok(isQuantityOk(s(c.resources?.requests?.cpu)) && isQuantityOk(s(c.resources?.requests?.memory)), "migrator has resource requests");
    ok(isQuantityOk(s(c.resources?.limits?.cpu)) && isQuantityOk(s(c.resources?.limits?.memory)), "migrator has resource limits");
  }

  // 2.6 regional pools: identical structure except region identity
  const regions = workerDeps.map((d) => d.metadata.labels?.["cloner.io/region"]).filter(Boolean);
  ok(new Set(regions).size === workerDeps.length && regions.length >= 2,
    "each worker deployment carries a DISTINCT cloner.io/region label", regions.join(", "));
  const fingerprints = workerDeps.map((d) => {
    const pod = d.spec?.template?.spec || {};
    const c = (pod.containers || [])[0] || {};
    return {
      image: c.image,
      imagePullPolicy: c.imagePullPolicy,
      command: c.command,
      resources: c.resources,
      envFrom: c.envFrom,
      volumeMounts: c.volumeMounts,
      workingDir: c.workingDir,
      containerSecurityContext: c.securityContext,
      terminationGracePeriodSeconds: pod.terminationGracePeriodSeconds,
      securityContext: pod.securityContext,
      configMapRef: "cloner-config",
      secretRef: "cloner-secrets",
    };
  });
  const fpEqual = fingerprints.length >= 2 && fingerprints.every((fp) => canonJson(fp) === canonJson(fingerprints[0]));
  ok(fpEqual, "regional pools are structurally IDENTICAL (differ only in region identity)", `compared ${fingerprints.length} pools`);

  for (const dep of workerDeps) {
    const name = dep.metadata.name;
    const region = dep.metadata.labels?.["cloner.io/region"];
    const pod = dep.spec?.template?.spec || {};
    const c = (pod.containers || [])[0] || {};
    const cmdText = (c.command || []).join(" ");
    ok(cmdText.includes("src/config-schema.js") && cmdText.includes("worker"), `${name}: command validates the 'worker' role`, cmdText);
    ok(cmdText.includes("src/workers/clone-worker.js"), `${name}: command runs src/workers/clone-worker.js`);
    const envs = c.env || [];
    const wid = envs.find((e) => e.name === "CLONER_WORKER_ID");
    ok(wid?.valueFrom?.fieldRef?.fieldPath === "metadata.name",
      `${name}: CLONER_WORKER_ID = pod name (heartbeat keys cannot collide across pods)`);
    const wregion = envs.find((e) => e.name === "CLONER_WORKER_REGION");
    ok(wregion?.value === region, `${name}: CLONER_WORKER_REGION matches the region label`, s(wregion?.value));
    const noHttpProbes = [c.livenessProbe, c.readinessProbe, c.startupProbe].every((p) => !p?.httpGet);
    ok(noHttpProbes, `${name}: no httpGet probes (worker exposes no HTTP endpoint — heartbeat-based liveness, documented in 40-workers.yaml)`);
    const affinityValues = [];
    for (const term of pod.affinity?.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution || []) {
      for (const expr of term.preference?.matchExpressions || []) {
        if (expr.key === "cloner.io/worker-region") affinityValues.push(...expr.values);
      }
    }
    ok(affinityValues.includes(region), `${name}: node affinity prefers cloner.io/worker-region=${region}`, affinityValues.join(", "));
  }

  // 2.7 Service
  const svc = byKind.Service?.find((x) => x.metadata.name === "cloner-api");
  ok(!!svc, "Service cloner-api present");
  ok(svc?.spec?.selector?.["app.kubernetes.io/component"] === "api", "Service selects the api pods");
  const svcPort = (svc?.spec?.ports || [])[0];
  ok(svcPort?.port === 4180 && (svcPort?.targetPort === "http" || svcPort?.targetPort === 4180), "Service port 4180 → targetPort http");

  // 2.8 HPA cross-doc resolution
  const hpas = byKind.HorizontalPodAutoscaler || [];
  ok(hpas.length >= 3, "HPAs present for api + regional pools", hpas.map((h) => h.metadata.name).join(", "));
  for (const hpa of hpas) {
    const name = hpa.metadata.name;
    ok(hpa.apiVersion === "autoscaling/v2", `${name}: apiVersion autoscaling/v2`);
    const ref = hpa.spec?.scaleTargetRef || {};
    const target = deployment(ref.name);
    ok(ref.kind === "Deployment" && !!target, `${name}: scaleTargetRef ${ref.kind}/${ref.name} resolves to a manifest in this directory`);
    const min = hpa.spec?.minReplicas;
    const max = hpa.spec?.maxReplicas;
    ok(Number(min) >= 1 && Number(max) > Number(min), `${name}: minReplicas(${s(min)}) < maxReplicas(${s(max)})`);
    const metrics = hpa.spec?.metrics || [];
    ok(metrics.some((m) => m.type === "Resource" && m.resource?.name === "cpu" && m.resource?.target?.type === "Utilization"),
      `${name}: cpu Utilization metric present`);
    ok(metrics.some((m) => m.type === "Resource" && m.resource?.name === "memory" && m.resource?.target?.type === "Utilization"),
      `${name}: memory Utilization metric present`);
    ok(!!hpa.spec?.behavior?.scaleDown?.stabilizationWindowSeconds, `${name}: scaleDown stabilization configured`);
  }
  const hpaTargets = hpas.map((h) => h.spec?.scaleTargetRef?.name);
  ok(hpaTargets.includes("cloner-api"), "HPA autoscales cloner-api");
  for (const dep of workerDeps) {
    ok(hpaTargets.includes(dep.metadata.name), `HPA autoscales ${dep.metadata.name}`);
  }

  // 2.9 PVC references resolve
  const claims = new Set();
  for (const { container } of workloadContainers) {
    for (const v of (container.volumeMounts || []).map((m) => m.mountPath)) claims.add(v);
  }
  const claimNames = new Set();
  for (const f of files) {
    for (const d of f.docs) {
      for (const vol of d.spec?.template?.spec?.volumes || []) {
        if (vol.persistentVolumeClaim?.claimName) claimNames.add(vol.persistentVolumeClaim.claimName);
      }
    }
  }
  for (const cn of claimNames) {
    ok(pvcNames.includes(cn), `volume claimName ${cn} resolves to a declared PVC`);
  }
  ok(claimNames.has("cloner-artifacts") && claimNames.has("cloner-platform-data"), "workloads reference both platform PVCs");

  // 2.10 secret discipline: no inlined secret VALUES anywhere that gets applied
  const credShapes = [
    [/BEGIN [A-Z ]*PRIVATE KEY/, "private key block"],
    [/AKIA[0-9A-Z]{16}/, "aws access key id"],
    [/ghp_[A-Za-z0-9]{30,}/, "github personal token"],
    [/github_pat_[A-Za-z0-9_]{20,}/, "github fine-grained token"],
    [/sk-[A-Za-z0-9]{20,}/, "openai-style key"],
    [/xox[bap]-[A-Za-z0-9-]{10,}/, "slack token"],
    [/postgres:\/\/[^"'\s]*:[^"'\s@]+@/, "postgres url with embedded password"],
  ];
  let credHit = null;
  for (const f of appliedFiles) {
    for (const [re, label] of credShapes) {
      if (re.test(f.text)) credHit = `${f.name}: ${label}`;
    }
  }
  ok(!credHit, "no credential-shaped values in any applied manifest", credHit || "scanned " + appliedFiles.length + " files against " + credShapes.length + " patterns");
  const replaceHits = appliedFiles.filter((f) => f.text.includes("REPLACE_")).map((f) => f.name);
  ok(replaceHits.length === 0, "no unfilled placeholders leak into applied manifests", replaceHits.join(", ") || "only the .example template carries placeholders");
}

// ===========================================================================
// Section 3 — env surface through the REAL config-schema validator
// ===========================================================================
function envSchemaChecks() {
  section("3. [env-schema] manifest env surface vs src/config-schema.js (real validator)");
  const files = loadManifests();
  const cm = files.flatMap((f) => f.docs).find((d) => d.kind === "ConfigMap" && d.metadata.name === "cloner-config");
  const secretDoc = files.find((f) => f.name === "20-secrets.yaml.example")?.docs.find((d) => d.kind === "Secret");
  if (!cm || !secretDoc) {
    fail("env-schema prerequisites", "ConfigMap or Secret template missing — structure section should have failed already");
    return;
  }
  // Shape-valid stubs for secret keys: this section verifies KEY COVERAGE
  // (does the manifest reference every required variable?), not secret values.
  const secretStubs = {
    PGPASSWORD: "stub-pg-password",
    REDIS_URL: "redis://stub-redis:6379",
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    CUSTOM_API_KEY: "",
  };
  const env = { ...cm.data, ...secretStubs };

  for (const role of ["api", "worker", "migrator"]) {
    const v = validateEnv({ role, env, mode: "production" });
    ok(v.ok === true, `${role}: production env assembles from manifests + secrets with ZERO validation errors`,
      v.ok ? `${v.errors.length} errors, ${v.warnings.length} warnings` : v.errors.slice(0, 3).join(" | "));
    if (!v.ok) for (const e of v.errors) console.log(`      └ ${e}`);
  }

  // negative controls — prove the assembly check is not vacuous
  const noPg = { ...env };
  delete noPg.PGPASSWORD;
  const vApi = validateEnv({ role: "api", env: noPg, mode: "production" });
  ok(vApi.ok === false && vApi.errors.some((e) => e.includes("PGPASSWORD")),
    "control: dropping PGPASSWORD makes the api fail validation (validator engages)");

  const noRedis = { ...env };
  delete noRedis.REDIS_URL;
  const vWorker = validateEnv({ role: "worker", env: noRedis, mode: "production" });
  ok(vWorker.ok === false && vWorker.errors.some((e) => e.includes("REDIS_URL")),
    "control: dropping REDIS_URL makes the worker fail validation (validator engages)");

  // the real template placeholders must be non-empty for required secrets
  const sd = secretDoc.stringData || {};
  ok(typeof sd.PGPASSWORD === "string" && sd.PGPASSWORD.length > 0, "template PGPASSWORD placeholder non-empty (a lazy copy fails at DB auth, not silently)");
}

// ===========================================================================
// Section 4 — independent parser agreement (PyYAML)
// ===========================================================================
function pythonWithYaml() {
  for (const py of ["python", "python3"]) {
    const probe = run(py, ["-c", "import yaml; print(yaml.__version__)"], { timeout: 20000 });
    if (probe.status === 0) return { py, version: probe.stdout };
  }
  return null;
}

function pyyamlCrossCheck() {
  section("4. [pyyaml] independent parser agreement");
  const py = pythonWithYaml();
  if (!py) {
    skip("pyyaml agreement", "python with PyYAML not available on this machine — structure section already validated manifests with the in-repo parser");
    return;
  }
  const files = loadManifests();
  for (const f of files) {
    const r = run(py.py, [
      "-c",
      "import sys,json,yaml;json.dump(list(yaml.safe_load_all(open(sys.argv[1],encoding='utf-8'))),sys.stdout)",
      path.join(K8S_DIR, f.name),
    ], { timeout: 30000 });
    if (r.status !== 0) {
      fail(`pyyaml parses k8s/${f.name}`, r.stderr.split("\n").slice(-2).join(" | "));
      continue;
    }
    let theirs;
    try {
      theirs = JSON.parse(r.stdout).filter((d) => d !== null);
    } catch (e) {
      fail(`pyyaml output for k8s/${f.name}`, e.message);
      continue;
    }
    const agree = canonJson(theirs) === canonJson(f.docs);
    ok(agree, `in-repo parser ≡ PyYAML for k8s/${f.name}`,
      agree ? "" : `first divergence: ${firstDiff(f.docs, theirs)}`);
  }
}

function firstDiff(a, b) {
  const ja = JSON.stringify(canonical(a));
  const jb = JSON.stringify(canonical(b));
  for (let i = 0; i < Math.max(ja.length, jb.length); i++) {
    if (ja[i] !== jb[i]) {
      return `...${ja.slice(Math.max(0, i - 40), i + 40)}... vs ...${jb.slice(Math.max(0, i - 40), i + 40)}...`;
    }
  }
  return "no divergence (unexpected)";
}

// ===========================================================================
// Section 5 — live cluster (SKIP loudly unless kubectl + kubeconfig + cluster)
// ===========================================================================
async function liveClusterChecks() {
  section("5. [live-cluster] API-server validation (throwaway namespace)");
  const kubectlCheck = run("kubectl", ["version", "--client"], { timeout: 20000 });
  if (kubectlCheck.status !== 0) {
    skip("live-cluster checks", "kubectl not found on PATH — install kubectl to run live validation");
    return;
  }
  pass("kubectl present", kubectlCheck.stdout.split("\n")[0] || "");
  const kubeconfigPath = process.env.KUBECONFIG || path.join(os.homedir(), ".kube", "config");
  if (!process.env.KUBECONFIG && !fs.existsSync(kubeconfigPath)) {
    skip("live-cluster checks", `no KUBECONFIG and no ${kubeconfigPath} — per task spec live tests skip loudly`);
    return;
  }
  pass("kubeconfig present", process.env.KUBECONFIG || kubeconfigPath);
  const reach = run("kubectl", ["get", "nodes", "--request-timeout=8s", "-o", "name"], { timeout: 20000 });
  if (reach.status !== 0) {
    skip("live-cluster checks", `cluster unreachable: ${(reach.stderr || reach.stdout).split("\n").filter(Boolean).slice(-1)[0] || "no response"}`);
    return;
  }
  pass("cluster reachable", reach.stdout.split("\n").filter(Boolean).join(", "));

  const ns = `cloner-k8s-live-${Date.now()}`;
  const files = loadManifests();
  const appliedNames = [];
  let created = false;
  try {
    const mk = run("kubectl", ["create", "namespace", ns], { timeout: 30000 });
    if (mk.status !== 0) {
      fail("live: create throwaway namespace", mk.stderr || mk.stdout);
      return;
    }
    created = true;
    pass("live: throwaway namespace created", ns);

    // apply every real manifest (namespace token rewritten to the throwaway ns)
    for (const f of files.filter((x) => x.name.endsWith(".yaml") && x.name !== "00-namespace.yaml")) {
      const rewritten = f.text.replace(/^(\s*)namespace: cloner$/gm, `$1namespace: ${ns}`);
      if (rewritten === f.text) {
        fail(`live: apply k8s/${f.name}`, "namespace token not found for rewrite");
        continue;
      }
      const r = run("kubectl", ["apply", "-f", "-", `--request-timeout=60s`], { timeout: 90000, input: rewritten });
      if (r.status !== 0) {
        fail(`live: kubectl apply k8s/${f.name}`, (r.stderr || r.stdout).split("\n").filter(Boolean).slice(-2).join(" | "));
      } else {
        pass(`live: kubectl apply k8s/${f.name}`, r.stdout.split("\n").filter(Boolean).map((l) => l.replace(/\(.*\)/, "")).join(", "));
      }
    }
    // the secret template too — placeholders are fine in a throwaway namespace
    {
      const f = files.find((x) => x.name === "20-secrets.yaml.example");
      const rewritten = f.text.replace(/^(\s*)namespace: cloner$/gm, `$1namespace: ${ns}`);
      const r = run("kubectl", ["apply", "-f", "-", `--request-timeout=60s`], { timeout: 90000, input: rewritten });
      ok(r.status === 0, "live: kubectl apply secret template", r.status === 0 ? "secret/cloner-secrets created" : (r.stderr || r.stdout).split("\n").slice(-1)[0]);
    }

    // verify the created resource set
    const want = {
      deployments: ["cloner-api", "cloner-worker-us-east-1", "cloner-worker-eu-west-1"],
      services: ["cloner-api"],
      hpas: ["cloner-api", "cloner-worker-us-east-1", "cloner-worker-eu-west-1"],
      jobs: ["cloner-migrator"],
      configmaps: ["cloner-config"],
      secrets: ["cloner-secrets"],
    };
    for (const [plural, names] of Object.entries(want)) {
      const r = run("kubectl", ["get", plural, "-n", ns, "-o", "name"], { timeout: 30000 });
      const got = r.stdout.split("\n").filter(Boolean);
      for (const n of names) {
        ok(got.includes(`${plural.replace(/s$/, "")}/${n}`) || got.some((g) => g.endsWith(`/${n}`)),
          `live: ${plural}/${n} created`);
      }
    }
    const pvcs = run("kubectl", ["get", "pvc", "-n", ns, "-o", "name"], { timeout: 30000 });
    const pvcNames = pvcs.stdout.split("\n").filter(Boolean);
    ok(pvcNames.some((g) => g.endsWith("/cloner-artifacts")) && pvcNames.some((g) => g.endsWith("/cloner-platform-data")),
      "live: both PVCs created", pvcNames.join(", "));

    // the api-server accepted every object — that is the live check's contract.
    // (pods may CrashLoop here: no real postgres/redis behind the placeholders;
    // the migrator job is EXPECTED to fail in a throwaway namespace.)
    pass("live: API server accepted the full manifest set", `${ns}`);
  } finally {
    if (created) {
      const del = run("kubectl", ["delete", "namespace", ns, "--wait=false", "--ignore-not-found"], { timeout: 60000 });
      console.log(`      cleanup: kubectl delete namespace ${ns} → ${del.status === 0 ? "requested" : del.stderr || "unknown"}`);
    }
  }
}

// ===========================================================================
// main
// ===========================================================================

async function main() {
  console.log("Task 4.2.5 — Kubernetes PROFILE verification");
  console.log(`k8s dir: ${K8S_DIR}`);

  parserSelfTests();

  const healthRoutesSrc = fs.readFileSync(path.join(ROOT, "src", "platform", "health-routes.js"), "utf8");
  const serverSrc = fs.readFileSync(path.join(ROOT, "src", "platform", "server.js"), "utf8");
  structuralChecks({ healthRoutesSrc, serverSrc });

  envSchemaChecks();

  pyyamlCrossCheck();

  await liveClusterChecks();

  console.log("\n════════════════════════════════════════════");
  console.log(`RESULT  pass=${results.pass}  fail=${results.fail}  skip=${results.skip}`);
  if (results.fail > 0) {
    console.log("FAILED — see FAIL lines above");
    process.exitCode = 1;
  } else {
    console.log("ALL RUN CHECKS PASSED");
  }
}

main().catch((e) => {
  console.error("test harness crashed:", e);
  process.exit(1);
});
