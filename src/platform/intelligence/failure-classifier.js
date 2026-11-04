// Failure classifier + bounded automated remediation (Phase 5.0 —
// autonomous-operations area, task G3.3).
//
// Two halves, both deterministic:
//
// 1. classifyFailure() — maps a failure (error message, or a reconstruction
//    defect kind from 3.4.3's classifier vocabulary) onto a KNOWN failure
//    class. The infrastructure classes mirror the real failure surfaces this
//    platform already has: Playwright browser loss, Redis/queue loss,
//    regional network failures (net::ERR_*), regional storage failures,
//    PostgreSQL failures and target auth rejections. The reconstruction
//    classes are the repair-planner defect vocabulary (typography, color,
//    geometry, missing-asset, dead-interaction, missing-component).
//
// 2. Repair-history patterns → bounded remediation proposals. The REAL
//    repair loop (src/reconstruction/repair-history.js + repair-executor.js)
//    appends one JSONL line per repair round to <projectDir>/.repair/history.jsonl:
//      { ts, round, action: { id, kind, target }, before, after, kept, reason }
//    loadRepairPatterns() aggregates those lines per repair kind: how often
//    each kind was KEPT (measured improvement) vs REVERTED (no improvement /
//    failed), as a Laplace-smoothed success rate. proposeRemediation() then
//    applies the autonomy law — bounded automated remediation for KNOWN
//    failure classes via repair-history patterns:
//      • known remediable class + strong pattern evidence ⇒ an automated,
//        bounded plan (maxAttempts, verify-after-each, rollback on
//        no-improvement — executor contracts, not promises).
//      • known remediable class with weak/no evidence ⇒ NOT automated
//        (requiresApproval: true, fail-safe: autonomy needs evidence).
//      • infrastructure classes ⇒ never auto-remediated (operator action).
//    Bounds are hard: maxAttempts = min(class.maxAttempts, config cap).
import { REPAIR_KINDS } from "../../reconstruction/repair-planner.js";

const DEFAULTS = Object.freeze({
  minPatternSuccessRate: 0.6, // a repair kind automates only above this kept-rate
  minPatternSamples: 3,       // ...and only with at least this many history rounds
  maxRemediationAttempts: 5,  // hard global cap on automated attempts
});

// ---------- the known-class registry (ordered; first match wins) ------------
//
// signatures are matched case-insensitively against the sanitized error
// message. defectKinds map reconstruction defect kinds onto the class.
// remediationKinds are validated against the REAL repair vocabulary below.
const REGISTRY = [
  {
    id: "visual_typography_drift",
    domain: "reconstruction",
    label: "typography drift between original and clone",
    defectKinds: ["typography"],
    remediable: true,
    remediationKinds: ["css-override"],
    maxAttempts: 3,
    signatures: [],
  },
  {
    id: "visual_color_drift",
    domain: "reconstruction",
    label: "color token drift between original and clone",
    defectKinds: ["color"],
    remediable: true,
    remediationKinds: ["token-fix"],
    maxAttempts: 3,
    signatures: [],
  },
  {
    id: "visual_geometry_drift",
    domain: "reconstruction",
    label: "element geometry drift between original and clone",
    defectKinds: ["geometry"],
    remediable: true,
    remediationKinds: ["geometry-fix"],
    maxAttempts: 3,
    signatures: [],
  },
  {
    id: "missing_asset",
    domain: "reconstruction",
    label: "asset reference broken or missing in the clone",
    defectKinds: ["missing-asset"],
    remediable: true,
    remediationKinds: ["asset-remap"],
    maxAttempts: 3,
    signatures: [],
  },
  {
    id: "dead_interaction",
    domain: "reconstruction",
    label: "dead interaction trigger in the clone",
    defectKinds: ["dead-interaction", "dead-attr", "dead-trigger", "interaction"],
    remediable: true,
    remediationKinds: ["interaction-rewire"],
    maxAttempts: 3,
    signatures: [],
  },
  {
    id: "missing_component",
    domain: "reconstruction",
    label: "component missing from the clone (needs structural regeneration)",
    defectKinds: ["missing-component"],
    remediable: false, // no bounded minimal action (repair-planner skip rule)
    remediationKinds: [],
    maxAttempts: 0,
    signatures: [],
    operatorAction: "regenerate the affected component (structural repair is out of automated scope)",
  },
  {
    id: "worker_process_failure",
    domain: "infrastructure",
    label: "browser/worker process lost",
    defectKinds: [],
    remediable: false,
    remediationKinds: [],
    maxAttempts: 0,
    signatures: [
      /target page, context or browser has been closed/i, // Playwright browser loss
      /browser (has )?crashed/i,
      /worker (process )?(died|exited|crashed|lost)/i,
      /playwright.*(closed|crashed|timeout)/i,
    ],
    operatorAction: "restart the worker; check worker memory pressure and browser recycling thresholds",
  },
  {
    id: "regional_network_failure",
    domain: "infrastructure",
    label: "network failure reaching the target or a region",
    defectKinds: [],
    remediable: false,
    remediationKinds: [],
    maxAttempts: 0,
    signatures: [
      /net::ERR_[A-Z_]+/,                                   // Chromium navigation errors (TIMEOUT, CONNECTION_*, NAME_NOT_RESOLVED…)
      /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)\b/,
      /navigation (timeout|failed)/i,
      /(getaddrinfo|dns) (failure|error)/i,
    ],
    operatorAction: "check regional network reachability and target availability; consider regional failover",
  },
  {
    id: "queue_service_failure",
    domain: "infrastructure",
    label: "queue/Redis service failure",
    defectKinds: [],
    remediable: false,
    remediationKinds: [],
    maxAttempts: 0,
    signatures: [
      /redis/i,
      /\bqueue\b.*(unavailable|down|connection|refused)/i,
      /bullmq/i,
    ],
    operatorAction: "verify the queue service (Redis) and the queue adapter configuration",
  },
  {
    id: "regional_storage_failure",
    domain: "infrastructure",
    label: "artifact/storage write failure",
    defectKinds: [],
    remediable: false,
    remediationKinds: [],
    maxAttempts: 0,
    signatures: [
      /\bENOSPC\b/,
      /artifact.*(write|store).*(fail|error|denied)/i,
      /\bEROFS\b/,
    ],
    operatorAction: "check artifact storage capacity and permissions for the region",
  },
  {
    id: "database_failure",
    domain: "infrastructure",
    label: "database connectivity/consistency failure",
    defectKinds: [],
    remediable: false,
    remediationKinds: [],
    maxAttempts: 0,
    signatures: [
      /connection terminated/i,
      /postgres(ql)?.*(unreachable|refused|down|error)/i,
      /\bECONNREFUSED\b.*5432/,
      /database.*(unreachable|error|locked)/i,
    ],
    operatorAction: "verify PostgreSQL health (compose instance or managed instance) before retrying",
  },
  {
    id: "target_auth_failure",
    domain: "infrastructure",
    label: "target site rejected access (auth/robots)",
    defectKinds: [],
    remediable: false,
    remediationKinds: [],
    maxAttempts: 0,
    signatures: [
      /\b401 unauthorized\b/i,
      /\b403 forbidden\b/i,
      /login (required|failed)/i,
      /cookies? (expired|invalid)/i,
    ],
    operatorAction: "refresh target credentials/cookies for the job owner",
  },
  {
    id: "execution_timeout",
    domain: "infrastructure",
    label: "execution exceeded its time budget",
    defectKinds: [],
    remediable: false,
    remediationKinds: [],
    maxAttempts: 0,
    signatures: [
      /\btimeout\b.*\b(exceeded|expired|of \d+ ?ms)\b/i,
      /\btimed out\b/i,
    ],
    operatorAction: "raise the stage budget for this job class or split the job",
  },
];

export const FAILURE_CLASSES = Object.freeze(REGISTRY.map((c) => Object.freeze({ ...c })));
export const CLASS_IDS = Object.freeze(REGISTRY.map((c) => c.id));

// vocabulary guard: fail fast at load if a remediation kind drifts from the
// real repair-planner vocabulary (REPAIR_KINDS from src/reconstruction/).
for (const cls of REGISTRY) {
  for (const kind of cls.remediationKinds) {
    if (!REPAIR_KINDS.includes(kind)) {
      throw new Error(`[failure-classifier] remediation kind "${kind}" of class ${cls.id} is not in the repair-planner vocabulary`);
    }
  }
}

function sanitizeMessage(msg) {
  return String(msg ?? "").replace(/[\r\n]+/g, " ").slice(0, 500);
}

// classifyFailure({ message?, error?, kind?, defectKind? }) → {
//   classId, domain, label, remediable, matchedBy, signature, confidence,
//   fallback }
// Deterministic first-match: defect-kind vocabulary first (exact), then the
// registry's signature list in order. No match ⇒ classId "unclassified",
// fallback true, confidence 0.
export function classifyFailure({ message = null, error = null, kind = null, defectKind = null } = {}) {
  const rawMessage = message ?? (error && typeof error === "object" ? error.message : error) ?? "";
  const msg = sanitizeMessage(rawMessage);
  const defect = String(defectKind || kind || "").toLowerCase();

  if (defect) {
    for (const cls of REGISTRY) {
      if (cls.defectKinds.includes(defect)) {
        return {
          classId: cls.id, domain: cls.domain, label: cls.label,
          remediable: cls.remediable, matchedBy: "defect-kind", signature: defect,
          confidence: 1, fallback: false,
        };
      }
    }
  }
  if (msg) {
    for (const cls of REGISTRY) {
      for (const sig of cls.signatures) {
        if (sig.test(msg)) {
          return {
            classId: cls.id, domain: cls.domain, label: cls.label,
            remediable: cls.remediable, matchedBy: "signature", signature: String(sig),
            confidence: 0.9, fallback: false,
          };
        }
      }
    }
  }
  return { classId: "unclassified", domain: "unknown", label: "no known failure class matched", remediable: false, matchedBy: null, signature: null, confidence: 0, fallback: true };
}

// ---------- repair-history pattern learning ---------------------------------

// parse one repair-history JSONL line (repair-executor entry shape); returns
// null for lines that are not repair-round records.
export function parseRepairHistoryLine(line) {
  if (!line || typeof line !== "string" || !line.trim()) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const kind = entry?.action?.kind;
  if (typeof kind !== "string" || !kind) return null;
  const kept = entry.kept === true;
  return {
    kind,
    target: entry?.action?.target ?? null,
    kept,
    before: Number.isFinite(Number(entry.before)) ? Number(entry.before) : null,
    after: Number.isFinite(Number(entry.after)) ? Number(entry.after) : null,
    ts: typeof entry.ts === "string" ? entry.ts : null,
  };
}

// aggregate parsed entries per repair kind → { kind, kept, reverted, total,
// successRate, improvementSum, lastSeenAt }. Laplace smoothing (kept + 1) /
// (total + 2) so an unproven kind never reaches 1.0.
export function aggregateRepairPatterns(entries) {
  const byKind = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.kind !== "string") continue;
    const k = byKind.get(e.kind) || { kind: e.kind, kept: 0, reverted: 0, total: 0, improvementSum: 0, lastSeenAt: null };
    k.total += 1;
    if (e.kept) {
      k.kept += 1;
      if (Number.isFinite(e.before) && Number.isFinite(e.after)) k.improvementSum += e.after - e.before;
    } else {
      k.reverted += 1;
    }
    if (e.ts && (!k.lastSeenAt || e.ts > k.lastSeenAt)) k.lastSeenAt = e.ts;
    byKind.set(e.kind, k);
  }
  const out = [...byKind.values()].map((k) => ({
    kind: k.kind,
    kept: k.kept,
    reverted: k.reverted,
    total: k.total,
    successRate: Math.round(((k.kept + 1) / (k.total + 2)) * 1e4) / 1e4,
    improvementSum: Math.round(k.improvementSum * 1e4) / 1e4,
    lastSeenAt: k.lastSeenAt,
    inRepairVocabulary: REPAIR_KINDS.includes(k.kind),
  }));
  out.sort((a, b) => a.kind.localeCompare(b.kind));
  return out;
}

// loadRepairPatterns({ root?, listDir?, readFile?, maxProjects?, maxEntries? })
// — scans <root>/<project>/.repair/history.jsonl (the REAL repair-history
// layout under the artifacts tree). Default root: <cwd>/artifacts with real
// fs. The listDir(root) → [projectName] and readFile(path) → string seams let
// tests drive the exact scan/parse logic offline without touching the
// filesystem contract; the defaults are the real filesystem.
export async function loadRepairPatterns({ root = null, listDir = null, readFile = null, maxProjects = 500, maxEntries = 10_000 } = {}) {
  const fsMod = await import("node:fs");
  const pathMod = await import("node:path");
  const readAt = async (p) => (readFile ? await readFile(p) : fsMod.readFileSync(p, "utf8"));
  const listAt = async (dir) => (listDir ? await listDir(dir) : fsMod.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
  const rootDir = root || pathMod.join(process.cwd(), "artifacts");

  let projects = [];
  try {
    projects = await listAt(rootDir);
  } catch (e) {
    return { patterns: [], projectsScanned: 0, parseErrors: 0, reason: `history root unavailable: ${String(e?.message || e).slice(0, 120)}` };
  }

  const entries = [];
  let parseErrors = 0;
  let projectsScanned = 0;
  for (const project of projects.sort().slice(0, maxProjects)) {
    const historyPath = pathMod.join(rootDir, project, ".repair", "history.jsonl");
    let text;
    try {
      text = await readAt(historyPath);
    } catch {
      continue; // no repair history for this project — normal
    }
    projectsScanned += 1;
    for (const line of String(text).split("\n")) {
      if (entries.length >= maxEntries) break;
      const parsed = parseRepairHistoryLine(line);
      if (!parsed) {
        if (line.trim()) parseErrors += 1;
        continue;
      }
      entries.push(parsed);
    }
    if (entries.length >= maxEntries) break;
  }
  return { patterns: aggregateRepairPatterns(entries), projectsScanned, parseErrors };
}

// ---------- bounded remediation proposals -----------------------------------

// proposeRemediation(failure | classifyResult, opts?) → {
//   classId, permitted, requiresApproval, reason, plan?, evidence?,
//   operatorAction?
// }
// opts: { classify? (pre-computed classification), patterns? (aggregateRepairPatterns
// output), minPatternSuccessRate?, minPatternSamples?, maxRemediationAttempts? }
export function proposeRemediation(failure, opts = {}) {
  // merge without letting explicitly-undefined opts shadow the defaults
  // (e.g. a router forwarding minPatternSuccessRate: undefined)
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const cls = failure && typeof failure === "object" && failure.classId && failure.classId !== "unclassified"
    ? REGISTRY.find((c) => c.id === failure.classId)
    : null;
  const classification = cls ? null : classifyFailure(failure || {});
  const def = cls || REGISTRY.find((c) => c.id === classification?.classId) || null;
  if (!def) {
    return {
      classId: "unclassified",
      permitted: false,
      requiresApproval: false,
      reason: "failure does not match any known class — no bounded remediation can be proposed",
      operatorAction: "route to a human operator with the raw error attached",
    };
  }
  if (!def.remediable) {
    return {
      classId: def.id,
      permitted: false,
      requiresApproval: false,
      reason: `class ${def.id} has no bounded automated remediation (domain: ${def.domain})`,
      operatorAction: def.operatorAction || "route to a human operator",
    };
  }

  const patterns = Array.isArray(opts.patterns) ? opts.patterns : [];
  const qualifying = def.remediationKinds
    .map((kind) => patterns.find((p) => p.kind === kind) || null)
    .filter(Boolean)
    .filter((p) => p.total >= cfg.minPatternSamples && p.successRate >= cfg.minPatternSuccessRate)
    .sort((a, b) => b.successRate - a.successRate || a.kind.localeCompare(b.kind));

  if (!qualifying.length) {
    const evidence = def.remediationKinds
      .map((kind) => patterns.find((p) => p.kind === kind))
      .filter(Boolean);
    const noEvidence = evidence.length === 0;
    return {
      classId: def.id,
      permitted: false,
      requiresApproval: true, // autonomy needs evidence — fail-safe to approval
      reason: noEvidence
        ? `no repair-history evidence yet for class ${def.id} (needs >= ${cfg.minPatternSamples} rounds for one of: ${def.remediationKinds.join(", ")})`
        : `repair-history success rate below ${cfg.minPatternSuccessRate} for class ${def.id} — not automated`,
      evidence,
      operatorAction: `review and run the ${def.remediationKinds.join(" / ")} repair manually once evidence accumulates`,
    };
  }

  return {
    classId: def.id,
    permitted: true,
    requiresApproval: false,
    reason: `bounded automated remediation: pattern evidence for ${qualifying.map((p) => p.kind).join(", ")} (successRate ${qualifying.map((p) => p.successRate).join(", ")})`,
    plan: {
      actions: qualifying.map((p) => p.kind),
      maxAttempts: Math.min(def.maxAttempts || cfg.maxRemediationAttempts, cfg.maxRemediationAttempts),
      verifyAfterEachAction: true,   // executor contract: measure → keep-if-improved
      rollbackOnNoImprovement: true, // executor contract: byte-identical snapshot restore
    },
    evidence: qualifying,
  };
}
