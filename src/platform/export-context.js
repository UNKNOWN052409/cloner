// Context export (task 4.5.3): every one-click export ships a context.json —
// the machine-readable recovery record of the task at export time.
//
// Content contract (no secrets, no blobs — pointers only):
//   formatVersion   "1.0.0" — bumped only on breaking shape changes
//   exportedAt      ISO timestamp of the export
//   task            task meta (jobId, originalUrl, stage timestamps, coverage)
//   evidence        POINTERS: { path, sha256, bytes } per artifact file —
//                   never file contents; validated hash-for-hash on import
//   config          env NAMES the platform reads, values REDACTED ("[REDACTED]"
//                   when set, null when unset) — a name is configuration, a
//                   value is a secret and never leaves the process
//   partialState    per-pipeline-stage completion markers derived from disk
//   resumePlan      ordered steps that re-run the remaining stages to completion
//   integrity       contextSha256 over the canonical JSON of everything above
//
// The credential-shred guarantee (src/platform/exporter.js, spec §10/§11) is
// untouched: context.json never references private/ or any sensitive-named
// entry (isSensitiveName filter below) and never contains credential VALUES —
// only hashes and redacted markers.
//
// ── INTEGRATOR HOOK (src/platform/exporter.js is READ-ONLY) ─────────────────
// One line in exportV2Task, directly after the project copy (currently
// exporter.js:53, `copyDir(projectDir, path.join(staging, "project"));`) and
// BEFORE `verifyStagedTree(staging);` (currently exporter.js:54):
//
//     writeContextJson({ artifactsDir: v2Dir, projectDir, staging });
//
// It stages context.json at the ZIP root (context.json), where the recovery
// importer (src/platform/session-recovery.js) expects it. Staged writes never
// touch the integrity-manifest-checked tree, so this composes with the G5.4
// export check. Until the hook lands, callers (tests, scripts) invoke
// writeContextJson with `staging: v2Dir` BEFORE exportV2Task — copyDir then
// carries the same file into staging, byte-identical to the hooked flow (the
// module re-records the tree's integrity manifest in that mode).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isSensitiveName } from "./exporter.js";
import { normClock, writeLifecycle, readManifest, INTEGRITY_MANIFEST_NAME, writeIntegrityManifest } from "../storage/artifact-lifecycle.js";

export const FORMAT_VERSION = "1.0.0";
export const CONTEXT_FILE = "context.json";
export const REDACTED = "[REDACTED]";
export const CONTEXT_KIND = "cloner-context-export";

// env NAMES the platform reads (values are NEVER exported — see redactedConfigEnv).
// Curated from .env.example and the process.env readers across src/.
export const CONFIG_ENV_NAMES = [
  // platform server + retention
  "PORT", "NODE_ENV", "RETENTION_DAYS", "PURGE_CREDS_ON_DONE",
  // model providers (vision/edit/video)
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
  "CUSTOM_API_KEY", "CUSTOM_BASE_URL",
  // database
  "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PG_CONTAINER",
  "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB",
  // queue + workers
  "REDIS_URL", "CLONER_REDIS_URL", "MAX_CONCURRENT", "MAX_EXPLORATION_JOBS",
  // integrations (names only — the values are credentials)
  "GITHUB_API_URL", "GITHUB_PUBLISH_TOKEN",
  "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_SECURE",
  "STRIPE_API_BASE", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
  // security toggles + rate limits
  "CLONER_ALLOW_PRIVATE_TARGETS", "CLONER_HOOK_ALLOW_PRIVATE_TARGETS",
  "API_RATE_LIMIT_PER_MINUTE", "API_RATE_LIMIT_PER_HOUR",
];

// deterministic top-level artifacts that are transport/export plumbing, not evidence.
// integrity.json is excluded too: it pins context.json's bytes, while context.json's
// evidence cannot pin integrity.json's bytes without a hash cycle — the manifest is
// transport plumbing re-recorded whenever the tree legitimately changes.
const EXCLUDED_TOP = new Set(["private", "export-staging", "node_modules", ".lifecycle-staging"]);
const EXCLUDED_FILES = new Set(["export.zip", CONTEXT_FILE, INTEGRITY_MANIFEST_NAME]);

// ---------- hashing + canonical JSON ----------

export function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function sha256File(file) {
  const h = crypto.createHash("sha256");
  const buf = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

// Recursive key-sorted serialization — the canonical form the integrity digest
// is computed over (JSON.stringify order would make the digest whitespace- and
// insertion-order dependent).
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

// ---------- config (env NAMES with REDACTED values) ----------

export function redactedConfigEnv(env = process.env) {
  const out = {};
  for (const name of CONFIG_ENV_NAMES) {
    out[name] = { set: Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined && env[name] !== "", value: env[name] ? REDACTED : null };
  }
  return out;
}

// ---------- evidence pointers ----------

// Every regular file under artifactsDir (and, when present, projectDir under a
// "project/" path prefix) becomes ONE pointer { path, sha256, bytes }. Never a
// file body. Skips: private/, export-staging/, node_modules/,
// .lifecycle-staging/, export.zip, context.json itself, and any
// isSensitiveName entry at any depth (defense in depth — the staged-tree
// verifier in exporter.js remains the enforcement point for the ZIP).
export function collectEvidence({ artifactsDir, projectDir = null } = {}) {
  const pointers = [];
  const walk = (dir, relPrefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relPrefix ? relPrefix + "/" + e.name : e.name;
      if (EXCLUDED_TOP.has(e.name) || EXCLUDED_FILES.has(e.name) || isSensitiveName(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, rel);
      else if (e.isFile()) {
        const st = fs.statSync(abs);
        pointers.push({ path: rel.replace(/\\/g, "/"), sha256: sha256File(abs), bytes: st.size });
      }
    }
  };
  walk(artifactsDir, "");
  if (projectDir && fs.existsSync(projectDir)) walk(projectDir, "project");
  pointers.sort((a, b) => a.path.localeCompare(b.path));
  return pointers;
}

// ---------- partial-state markers ----------

const V2_PROJECT_SUFFIX = "-project";

// Derive how far the pipeline got from what is actually on disk (never from a
// stored claim): exploration = manifest.json readable + terminal status;
// reconstruction = <artifactsDir>-project/index.html; verification =
// _reference/verification.json written by verifyTask (verify.js:675).
export function derivePartialState({ artifactsDir, projectDir = null } = {}) {
  projectDir = projectDir || artifactsDir + V2_PROJECT_SUFFIX;
  const manifest = readManifest(artifactsDir);
  const explorationCompleted = !!manifest && ["completed", "completed-with-errors"].includes(manifest.status);

  const reconIndex = path.join(projectDir, "index.html");
  const reconstructionCompleted = fs.existsSync(reconIndex) && fs.statSync(reconIndex).isFile();

  const verifFile = path.join(artifactsDir, "_reference", "verification.json");
  let verificationCompleted = false, verificationPassed = false;
  try {
    const v = JSON.parse(fs.readFileSync(verifFile, "utf8"));
    verificationCompleted = typeof v?.passed === "boolean" || Array.isArray(v?.stages);
    verificationPassed = v?.passed === true;
  } catch { /* not verified yet */ }

  const stages = { exploration: { completed: explorationCompleted, status: manifest?.status || "missing" }, reconstruction: { completed: reconstructionCompleted }, verification: { completed: verificationCompleted, passed: verificationPassed } };
  const nextStage = !explorationCompleted ? "exploration" : !reconstructionCompleted ? "reconstruction" : !verificationCompleted ? "verification" : "none";
  return { ...stages, nextStage };
}

// ---------- resume plan ----------

export function buildResumePlan(partialState, { originalUrl = null } = {}) {
  const steps = [];
  if (!partialState.exploration.completed) {
    steps.push({
      stage: "exploration",
      action: "re-run runExplorationJob from the recorded URL — session credentials were shredded at export, so the resumed run explores WITHOUT cookies/storage",
      runnable: /^https?:\/\//i.test(String(originalUrl || "")),
      reason: "partialState.exploration.completed = false (manifest.json missing or non-terminal status)",
    });
  }
  if (!partialState.reconstruction.completed) {
    steps.push({
      stage: "reconstruction",
      action: "re-run reconstructFromArtifacts(artifactsDir, { outDir: artifactsDir + '-project' })",
      runnable: true,
      reason: "partialState.reconstruction.completed = false (no project/index.html at export)",
    });
  }
  if (!partialState.verification.completed) {
    steps.push({
      stage: "verification",
      action: "re-run verifyTask(artifactsDir) (three-stage verification + bounded repair loop)",
      runnable: true,
      reason: "partialState.verification.completed = false (no _reference/verification.json at export)",
    });
  }
  if (!steps.length) {
    steps.push({ stage: "none", action: "no-op — exploration, reconstruction and verification were all complete at export", runnable: false, reason: "pipeline already complete" });
  }
  return {
    steps,
    credentialsNote: "session credentials (cookies/storage) were shredded at export time and are NOT recoverable from this package — resumed exploration runs unauthenticated; reconstruction and verification re-run purely from the exported evidence",
  };
}

// ---------- context build ----------

export function buildContext({ artifactsDir, projectDir = null, clock = null } = {}) {
  projectDir = projectDir || artifactsDir + V2_PROJECT_SUFFIX;
  const manifest = readManifest(artifactsDir) || {};
  const partialState = derivePartialState({ artifactsDir, projectDir });
  const context = {
    formatVersion: FORMAT_VERSION,
    kind: CONTEXT_KIND,
    exportedAt: new Date(normClock(clock)).toISOString(),
    task: {
      jobId: manifest.jobId || path.basename(artifactsDir).replace(/-project$/, ""),
      originalUrl: manifest.originalUrl || null,
      explorationStatus: manifest.status || null,
      startedAt: manifest.startedAt || null,
      finishedAt: manifest.finishedAt || null,
      schemaVersion: manifest.schemaVersion || null,
      coverage: manifest.coverage || null,
      counts: {
        pages: Array.isArray(manifest.pages) ? manifest.pages.length : null,
        routes: Number.isFinite(manifest.discoveredRoutes) ? manifest.discoveredRoutes : null,
        states: Number.isFinite(manifest.discoveredStates) ? manifest.discoveredStates : null,
        interactions: Number.isFinite(manifest.discoveredInteractions) ? manifest.discoveredInteractions : null,
      },
      auth: manifest.auth || null,
    },
    evidence: {
      algorithm: "sha256",
      note: "pointers only (relative path + sha256 + bytes) — file contents are never embedded; 'project/' prefixed paths resolve inside the exported project/ tree",
      pointers: collectEvidence({ artifactsDir, projectDir }),
    },
    config: {
      note: "environment NAMES only; every value is redacted — real values never leave the exporting process",
      env: redactedConfigEnv(),
    },
    partialState,
    resumePlan: buildResumePlan(partialState, { originalUrl: manifest.originalUrl || null }),
  };
  context.integrity = {
    algorithm: "sha256-canonical-json",
    contextSha256: sha256Buffer(Buffer.from(canonicalJson(context), "utf8")),
  };
  return context;
}

// The exporter hook target: build context.json and stage it at the ZIP root.
// With the hook (see header) `staging` is the exporter's staging dir; until the
// hook lands, callers pass `staging: artifactsDir` before exportV2Task so
// copyDir carries the identical file into the ZIP.
//
// When the file lands INSIDE the artifact tree (staging omitted or equal to
// artifactsDir) and that tree is integrity-manifest-managed (G5.4 —
// exportV2Task refuses exports whose tree no longer matches integrity.json,
// including EXTRA files), the manifest is re-recorded after the write — the
// sanctioned repair the exporter's refusal message prescribes. The re-record
// happens AFTER context.json exists so it pins the final bytes; evidence
// pointers exclude integrity.json (no hash cycle) and context.json itself.
export function writeContextJson({ artifactsDir, projectDir = null, staging = null, clock = null } = {}) {
  const context = buildContext({ artifactsDir, projectDir, clock });
  const dir = staging || artifactsDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, CONTEXT_FILE);
  fs.writeFileSync(file, JSON.stringify(context, null, 2));
  if (dir === artifactsDir && fs.existsSync(path.join(artifactsDir, INTEGRITY_MANIFEST_NAME))) {
    writeIntegrityManifest(artifactsDir); // tree changed (context.json added) → re-pin
  }
  return { context, file };
}

// ---------- import-side validation ----------

export class ContextValidationError extends Error {
  constructor(message, { status = 400, detail = null } = {}) {
    super(message);
    this.name = "ContextValidationError";
    this.status = status;
    this.detail = detail;
  }
}

// Structural validation — fail-closed, with every problem collected (not just
// the first) so an operator sees the full picture.
export function validateContextStructure(context) {
  const problems = [];
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new ContextValidationError("context.json is not a JSON object");
  if (context.kind !== CONTEXT_KIND) problems.push(`kind must be "${CONTEXT_KIND}"`);
  if (context.formatVersion !== FORMAT_VERSION) problems.push(`unsupported formatVersion ${JSON.stringify(context.formatVersion)} (expected "${FORMAT_VERSION}")`);
  if (typeof context.exportedAt !== "string" || Number.isNaN(Date.parse(context.exportedAt))) problems.push("exportedAt missing or not an ISO timestamp");
  if (!context.task || typeof context.task !== "object") problems.push("task meta missing");
  else if (typeof context.task.jobId !== "string" || !context.task.jobId) problems.push("task.jobId missing");
  if (!context.evidence || typeof context.evidence !== "object" || context.evidence.algorithm !== "sha256" || !Array.isArray(context.evidence.pointers)) problems.push("evidence.pointers missing or malformed");
  else {
    context.evidence.pointers.forEach((p, i) => {
      if (!p || typeof p.path !== "string" || !p.path) problems.push(`evidence[${i}].path missing`);
      else if (p.path.includes("\\") || p.path.includes("..") || path.isAbsolute(p.path)) problems.push(`evidence[${i}].path not a safe relative path: ${JSON.stringify(p.path.slice(0, 80))}`);
      else if (!/^[0-9a-f]{64}$/.test(String(p.sha256))) problems.push(`evidence[${i}].sha256 not a sha256 hex digest`);
      else if (!Number.isInteger(p.bytes) || p.bytes < 0) problems.push(`evidence[${i}].bytes missing/not an integer`);
    });
  }
  if (!context.config || typeof context.config !== "object" || !context.config.env || typeof context.config.env !== "object") problems.push("config.env missing");
  else {
    for (const [name, entry] of Object.entries(context.config.env)) {
      if (!entry || typeof entry !== "object" || typeof entry.set !== "boolean") { problems.push(`config.env.${name} malformed`); continue; }
      if (entry.value !== null && entry.value !== REDACTED) problems.push(`config.env.${name} carries a non-redacted value — refusing the package`);
    }
  }
  if (!context.partialState || typeof context.partialState !== "object") problems.push("partialState missing");
  if (!context.resumePlan || !Array.isArray(context.resumePlan.steps)) problems.push("resumePlan.steps missing");
  if (problems.length) throw new ContextValidationError(`context.json failed structural validation: ${problems.slice(0, 8).join("; ")}${problems.length > 8 ? ` (+${problems.length - 8} more)` : ""}`, { detail: problems });
  return true;
}

// Integrity: recompute the canonical digest over everything except the
// integrity block and compare. Catches ANY modification of the exported
// context (fields, hashes, stage markers) — the tampered-package rejection.
export function verifyContextIntegrity(context) {
  const claimed = context?.integrity?.contextSha256;
  if (!/^[0-9a-f]{64}$/.test(String(claimed))) return { ok: false, reason: "integrity.contextSha256 missing or malformed" };
  const body = { ...context, integrity: undefined };
  const recomputed = sha256Buffer(Buffer.from(canonicalJson(body), "utf8"));
  if (recomputed !== claimed) return { ok: false, reason: "context integrity mismatch (context.json was modified after export)", recomputed, claimed };
  return { ok: true, recomputed };
}

// Hash-for-hash validation of every evidence pointer against the extracted
// package tree. resolvePath(pointer) → absolute path of the referenced file.
// Fail-closed: ALL mismatches are collected first, then one error — a partially
// valid package never materializes.
export function validateEvidenceHashes(context, resolvePath) {
  const pointers = context?.evidence?.pointers || [];
  const missing = [], mismatched = [], validated = [];
  for (const p of pointers) {
    const abs = resolvePath(p.path);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { missing.push(p.path); continue; }
    const st = fs.statSync(abs);
    if (st.size !== p.bytes) { mismatched.push(`${p.path} (bytes ${st.size} ≠ ${p.bytes})`); continue; }
    if (sha256File(abs) !== p.sha256) { mismatched.push(`${p.path} (sha256 mismatch)`); continue; }
    validated.push(p.path);
  }
  if (missing.length || mismatched.length) {
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5})` : ""}`);
    if (mismatched.length) parts.push(`tampered/changed: ${mismatched.slice(0, 5).join(", ")}${mismatched.length > 5 ? ` (+${mismatched.length - 5})` : ""}`);
    throw new ContextValidationError(`context evidence validation failed — ${pointers.length} pointer(s), ${validated.length} ok. ${parts.join(" — ")}`, { status: 400, detail: { missing, mismatched, validated: validated.length, total: pointers.length } });
  }
  return { validated: validated.length, total: pointers.length };
}
