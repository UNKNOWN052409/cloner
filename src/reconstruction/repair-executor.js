// Repair executor (task 3.4.5): applies the planner's actions one at a time,
// re-runs the RELEVANT check after each, keeps improvements and reverts
// everything else — bounded rounds with a hard stop on a no-improvement round.
//
//   executeRepairs(projectDir, actions, {
//     maxRounds = 3,          // hard bound on repair rounds (verify.js MAX_ROUNDS parity)
//     checkFns,               // { fidelity: async (projectDir) → score, functional: … }
//                             // higher score = better; the RELEVANT check per action
//                             // kind comes from checkForKind (below)
//     verifyOne,              // optional override: async (projectDir, action|null) →
//                             // score — when given it replaces the checkFns dispatch
//                             // for baseline AND per-action measurement
//     checkForKind,           // kind → checkFns key (DEFAULT_KIND_CHECK)
//     minImprovement = 0,     // after − before must exceed this to keep a repair
//     historyPath, snapshotRoot,  // .repair/ locations inside projectDir by default
//   })
//
// Round = ONE action: snapshot → measure (relevant check) → apply → re-measure →
// keep if improved, else restore the snapshot byte-for-byte → append history.
// The loop hard-stops on the first non-improving round (if the top-priority
// repair does not move its metric, the remaining plan is not trusted against
// the same measurements) and never exceeds maxRounds.
//
// CSS repairs write clone-fixes.css-style scoped overrides — the Phase 3.2
// autoRemediate pattern (src/reconstruction/verify.js:459-472): append the rule to
// clone-fixes.css and inject `<link rel="stylesheet" href="clone-fixes.css">`
// before </head> once. Asset remaps and dead-attribute pruning edit index.html
// in place (verify.js:476-485 pattern); a11y fixes (fix descriptors from
// checkA11y, verify-a11y.js) set aria-label/alt on the action's payload file.
// The executor only ever mutates those files — snapshot/rollback covers exactly
// that surface (the history defaults plus every payload file the plan touches).
//
// Safety rules: an action with no measurable check is NEVER applied (recorded
// in `unverifiable`); any apply/measure error triggers the snapshot rollback;
// scores that are not finite numbers are an error, not a zero.
import fs from "node:fs";
import path from "node:path";
import { planRepairs } from "./repair-planner.js";
import { appendHistory, DEFAULT_SNAPSHOT_FILES, snapshotProject, restoreSnapshot } from "./repair-history.js";

// which injected check is RELEVANT for each repair kind
export const DEFAULT_KIND_CHECK = Object.freeze({
  "css-override": "fidelity",
  "token-fix": "fidelity",
  "geometry-fix": "fidelity",
  "asset-remap": "fidelity",
  "interaction-rewire": "functional",
  // a11y fixes score as −violation count (higher = fewer violations) — the
  // caller wires checkFns.a11y over checkA11y (verify-a11y.js)
  "a11y-name": "a11y",
  "a11y-alt": "a11y",
});

export const CLONE_FIXES_FILE = "clone-fixes.css";

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fmt = (n) => (Number.isFinite(n) ? String(+Number(n).toFixed(4)) : String(n));

function coerceScore(raw, what) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (raw && typeof raw === "object" && Number.isFinite(raw.score)) return Number(raw.score);
  throw new Error(`${what} returned a non-numeric score`);
}

// ---------------------------------------------------------------- CSS repairs

// ruleText(action) → `/* repair id */\nselector { prop: value !important; }`
// token-fix emits !important (autoRemediate precedent — body/:root-level and
// element color overrides must beat inline styles); css-override/geometry-fix
// follow the refineTypography plain-rule format (visual-fidelity-analyzer.js:524).
function ruleText(action) {
  const selector = String(action.payload.selector || action.target || "").trim();
  const important = action.payload.important === true || action.kind === "token-fix";
  const props = Object.entries(action.payload.props || {});
  if (!selector || !props.length) throw new Error(`action ${action.id} has no selector/props to apply`);
  const body = props.map(([p, v]) => `${p}: ${v}${important ? " !important" : ""}`).join("; ");
  return `/* repair ${action.id} (${action.kind}) */\n${selector} { ${body}; }\n`;
}

// inject `<link rel="stylesheet" href="clone-fixes.css">` before </head> once
function ensureCloneFixesLink(projectDir) {
  const idxPath = path.join(projectDir, "index.html");
  let html = fs.readFileSync(idxPath, "utf8");
  if (html.includes(CLONE_FIXES_FILE)) return; // idempotent — link already present
  if (!/<\/head>/i.test(html)) throw new Error("index.html has no </head> to inject the fixes link into");
  html = html.replace(/<\/head>/i, `  <link rel="stylesheet" href="${CLONE_FIXES_FILE}">\n</head>`);
  fs.writeFileSync(idxPath, html);
}

function applyCssAction(projectDir, action) {
  fs.appendFileSync(path.join(projectDir, CLONE_FIXES_FILE), ruleText(action));
  ensureCloneFixesLink(projectDir);
}

// --------------------------------------------------- in-place HTML repairs

function applyAssetRemap(projectDir, action) {
  const file = path.join(projectDir, action.payload.file || "index.html");
  const html = fs.readFileSync(file, "utf8");
  const re = new RegExp(`(\\s(?:src|href))=(["'])${escapeRe(action.payload.from)}\\2`, "g");
  const n = (html.match(re) || []).length;
  if (!n) throw new Error(`remap source "${action.payload.from}" not found in ${action.payload.file}`);
  const out = html.replace(re, (_m, attr) => `${attr}="${action.payload.to}"`); // fn replacer: no $-injection
  fs.writeFileSync(file, out);
}

function applyInteractionRewire(projectDir, action) {
  const file = path.join(projectDir, action.payload.file || "index.html");
  const html = fs.readFileSync(file, "utf8");
  const attr = escapeRe(action.payload.attr || "data-cloner-trigger");
  const value = escapeRe(action.payload.value);
  if (action.payload.op === "set") {
    // rewire: point the attribute at a replacement value (e.g. a live record id)
    const re = new RegExp(`(\\s${attr})=(["'])${value}\\2`, "g");
    if (!(html.match(re) || []).length) {
      throw new Error(`attribute ${action.payload.attr}="${action.payload.value}" not found to rewire`);
    }
    fs.writeFileSync(file, html.replace(re, (_m, a) => `${a}="${action.payload.newValue}"`));
    return;
  }
  // strip (default): dead-attribute pruning — autoRemediate pattern, verify.js:481
  const re = new RegExp(`\\s${attr}=(["'])${value}\\1`, "g");
  if (!(html.match(re) || []).length) {
    throw new Error(`dead attribute ${action.payload.attr}="${action.payload.value}" not found to strip`);
  }
  fs.writeFileSync(file, html.replace(re, ""));
}

// ------------------------------------------------- a11y in-place HTML repairs
// Fix descriptors come from checkA11y (verify-a11y.js): a11y-name sets aria-label
// from the element's own visible text; a11y-alt sets alt from the recorded
// original, the image filename, or alt="" decorative. The locator (id / attr+index
// / tag+index) resolves the SAME opening tag the live scan saw — DOM order equals
// source order in the generated files. `[^>]*?>` cannot see a `>` inside an
// attribute value and runtime-injected elements shift tag indices — both leave
// the fix "not found" (throw → snapshot rollback), never a wrong-element edit.
const openingTagRe = (tag) => new RegExp(`<${tag}\\b[^>]*?>`, "gi");

// the (locator.index)-th opening tag of <tag> matching the locator's constraint
function findOpeningTag(html, locator) {
  let n = -1;
  for (const m of html.matchAll(openingTagRe(locator.tag))) {
    if (locator.strategy === "attr") {
      const re = new RegExp(`\\s${escapeRe(locator.attr)}=(["'])${escapeRe(locator.value)}\\1`, "i");
      if (!re.test(m[0])) continue;
    } else if (locator.strategy === "id") {
      const re = new RegExp(`\\sid=(["'])${escapeRe(locator.id)}\\1`, "i");
      if (!re.test(m[0])) continue;
    }
    if (++n === (locator.index || 0)) return m;
  }
  return null;
}

const escapeHtmlAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// shared a11y apply: locate the opening tag, refuse to clobber an existing
// attribute (never overwrite a real label), insert ` attr="value"` before the
// opening tag's closing `>` / `/>`
function applyA11yAttributeFix(projectDir, action, attr) {
  const payload = action.payload || {};
  const rel = payload.file || "index.html";
  const file = path.join(projectDir, rel);
  const html = fs.readFileSync(file, "utf8");
  const m = findOpeningTag(html, payload.locator || {});
  if (!m) throw new Error(`a11y fix target ${action.target || "(no target)"} not found in ${rel}`);
  if (new RegExp(`\\s${attr}\\s*=`, "i").test(m[0])) throw new Error(`target already has ${attr} — not overwriting an existing label`);
  const value = escapeHtmlAttr(String(payload.value ?? ""));
  const fixed = m[0].replace(/\s*\/?>$/, (tail) => ` ${attr}="${value}"${tail}`);
  fs.writeFileSync(file, html.slice(0, m.index) + fixed + html.slice(m.index + m[0].length));
}

// applyAction(projectDir, action) — mutates the project; throws on anything
// unexpected so the round's try/catch rolls the snapshot back.
export function applyAction(projectDir, action) {
  switch (action.kind) {
    case "css-override":
    case "token-fix":
    case "geometry-fix":
      return applyCssAction(projectDir, action);
    case "asset-remap":
      return applyAssetRemap(projectDir, action);
    case "interaction-rewire":
      return applyInteractionRewire(projectDir, action);
    case "a11y-name":
      return applyA11yAttributeFix(projectDir, action, "aria-label");
    case "a11y-alt":
      return applyA11yAttributeFix(projectDir, action, "alt");
    default:
      throw new Error(`unsupported repair kind "${action.kind}"`);
  }
}

// ------------------------------------------------------------- repair loop

// executeRepairs(projectDir, actions, opts) →
//   { baseline, final, overall: { baseline, final }, improved, rounds,
//     applied, reverted, pending, unverifiable, stopped, historyPath, snapshotRoot }
// stopped ∈ "exhausted" (plan fully processed) | "max-rounds" | "no-improvement"
export async function executeRepairs(projectDir, actions, opts = {}) {
  const maxRounds = Number.isInteger(opts.maxRounds) && opts.maxRounds > 0 ? opts.maxRounds : 3;
  const checkFns = opts.checkFns && typeof opts.checkFns === "object" ? opts.checkFns : {};
  const checkForKind = opts.checkForKind || DEFAULT_KIND_CHECK;
  const verifyOne = typeof opts.verifyOne === "function" ? opts.verifyOne : null;
  const minImprovement = Number.isFinite(opts.minImprovement) ? Number(opts.minImprovement) : 0;
  const historyPath = opts.historyPath || path.join(projectDir, ".repair", "history.jsonl");
  const snapshotRoot = opts.snapshotRoot || path.join(projectDir, ".repair", "snapshots");

  const queue = (Array.isArray(actions) ? actions : []).filter((a) => a && typeof a === "object");
  // actions without any measurable check are never applied — record, don't guess
  const measurable = [];
  const unverifiable = [];
  for (const a of queue) {
    const key = checkForKind[a.kind];
    if (verifyOne || (key && typeof checkFns[key] === "function")) measurable.push(a);
    else unverifiable.push(a);
  }

  const usedKeys = verifyOne
    ? ["verifyOne"]
    : [...new Set(measurable.map((a) => checkForKind[a.kind]))];

  // snapshot surface = the executor's mutation surface: the history defaults
  // (index.html, styles/, clone-fixes.css) plus every payload file the plan's
  // actions touch — a fix against a non-index page must roll back too
  const snapshotFiles = [...new Set([
    ...DEFAULT_SNAPSHOT_FILES,
    ...measurable.map((a) => a.payload && a.payload.file).filter(Boolean),
  ])];

  async function scoreWith(key, action) {
    if (verifyOne) return coerceScore(await verifyOne(projectDir, action ?? null), "verifyOne");
    const fn = checkFns[key];
    if (typeof fn !== "function") throw new Error(`no check function for "${key}"`);
    return coerceScore(await fn(projectDir, action ?? null), `checkFns.${key}`);
  }

  // baseline: current score per relevant check (null action = no repair applied)
  const baseline = {};
  const final = {};
  let baselineFailed = null;
  for (const key of usedKeys) {
    try {
      baseline[key] = await scoreWith(key, null);
    } catch (e) {
      baselineFailed = e.message;
      break;
    }
  }
  if (baselineFailed) {
    return {
      baseline, final, overall: { baseline: NaN, final: NaN }, improved: false,
      rounds: [], applied: [], reverted: [], pending: measurable, unverifiable,
      stopped: "unmeasurable", reason: `baseline measurement failed: ${baselineFailed}`,
      historyPath, snapshotRoot,
    };
  }

  const rounds = [];
  let stopped = null;

  for (let round = 1; round <= maxRounds && measurable.length; round++) {
    const action = measurable[0];
    const label = `${action.id || action.kind}:${action.kind}:${action.target}`;
    const snap = snapshotProject(projectDir, path.join(snapshotRoot, `round-${String(round).padStart(3, "0")}`), { files: snapshotFiles });
    let before = null;
    let after = null;
    let kept = false;
    let reason;
    try {
      const key = verifyOne ? "verifyOne" : checkForKind[action.kind];
      before = await scoreWith(key, action);
      applyAction(projectDir, action); // ONE action per round
      after = await scoreWith(key, action);
      kept = after - before > minImprovement;
      reason = kept
        ? `${key} improved ${fmt(before)} → ${fmt(after)} — kept`
        : `${key} did not improve: ${fmt(before)} → ${fmt(after)} — reverted`;
    } catch (e) {
      reason = `repair failed: ${String(e.message).slice(0, 140)} — reverted`;
      kept = false;
    }
    if (!kept) restoreSnapshot(projectDir, snap.dir); // byte-identical rollback
    measurable.shift();
    const entry = {
      round,
      action: { id: action.id || null, kind: action.kind, target: action.target },
      before,
      after,
      kept,
      reason,
    };
    appendHistory(historyPath, entry);
    rounds.push({ ...entry, snapshot: path.join(snapshotRoot, `round-${String(round).padStart(3, "0")}`) });
    if (!kept) {
      stopped = "no-improvement"; // hard stop: don't keep repairing a dead plan
      break;
    }
  }

  stopped = stopped || (measurable.length ? "max-rounds" : "exhausted");
  for (const key of usedKeys) {
    try {
      final[key] = await scoreWith(key, null);
    } catch {
      final[key] = NaN;
    }
  }
  const sum = (o) => Object.values(o).reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);

  return {
    baseline,
    final,
    overall: { baseline: sum(baseline), final: sum(final) },
    improved: sum(final) > sum(baseline),
    rounds,
    applied: rounds.filter((r) => r.kept),
    reverted: rounds.filter((r) => !r.kept),
    pending: measurable,
    unverifiable,
    stopped,
    historyPath,
    snapshotRoot,
  };
}

// runRepairLoop(report, projectDir, opts) — the ONE-CALL integration hook for
// the verification loop. src/reconstruction/verify.js is READ-ONLY for task 3.4.5;
// the integration agent wires this into verifyTask (verify.js:510-511): when
// autoRemediate produced no fixes, instead of breaking immediately —
//   const repair = await runRepairLoop(report, v2Clone || outDirPath, {
//     defects: classifyDefects(<fidelity report from a stage-3 render>),
//     checkFns: { fidelity, functional }, assetMap,
//   });
//   if (!repair.improved) break;  // else re-enter the verify loop
// Defect sources: opts.defects (3.4.3 classifyDefects output) plus the dead
// trigger ids the visual stage already measured (report hex.extra) as
// interaction defects.
export async function runRepairLoop(report, projectDir, opts = {}) {
  const defects = [...(Array.isArray(opts.defects) ? opts.defects : [])];
  const visual = (report?.stages || []).find((s) => s.stage === "visual");
  const extra = visual?.hex?.extra || [];
  if (extra.length) {
    defects.push({ kind: "interaction", severity: 0.5, confidence: 0.9, refs: [], deadAttrs: extra });
  }
  const plan = planRepairs(defects, { assetMap: opts.assetMap, confidenceThreshold: opts.confidenceThreshold });
  const result = await executeRepairs(projectDir, plan.actions, opts);
  return { ...result, plan };
}
