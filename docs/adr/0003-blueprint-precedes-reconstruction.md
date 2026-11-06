# ADR-0003: Blueprint precedes reconstruction

- Status: Accepted (implemented 2026-11-05)
- Date: 2026-11-05
- Deciders: realignment spec P0 ("connect blueprint generation to reconstruction")
  + architecture review candidate 3; methodology ported from two external skill
  repositories (evaluated and credited in the module header)

## Context

Audits E and F found:

- `blueprint.json` — a required record of the canonical Understanding Record —
  had **no writer** anywhere in the engine; `grep -rni blueprint src/` returned 0.
- Reconstruction jumped straight from capture to deterministic generation: no
  structured plan, no approval surface, no scope contract.
- User instructions were **silently dropped**: `server.js:444` passes
  `instructions` to `queueExploration`, but `exploration-runner.js`'s signature
  omitted the field, so the payload never carried it; `verify.js` faked an
  `"task instructions carried"` ok-check instead.

## Decision

1. New engine module `src/reconstruction/blueprint.js` — deterministic and
   local-first (zero AI dependency). `buildBlueprint(artifactsDir, { instructions,
   frameworkPreference })` reads only recorded artifacts (manifest.json,
   pages/*/dom.json, graph/*.json) and writes `blueprint.json` containing:
   the parsed instruction **scope** (include / exclude / notes), the **detected
   stack** and the output-framework decision honoring the user's preference,
   per-page **regions and components with observed/inferred evidence statuses**,
   the **interaction model** (click / scroll / state-driven) identified before
   building, asset + design-token strategy, **acceptance evidence** for
   verification, and **unresolved ambiguities** recorded instead of guessed.
2. Instruction plumbing fixed end to end: `exploration-runner.js` carries
   `instructions` in the payload → `pipeline-job.js` destructures and forwards →
   `reconstructFromArtifacts` accepts `instructions` / `frameworkPreference`.
3. `reconstruction-pipeline.js` builds the blueprint right after artifact load,
   before any generation. Non-fatal by design: a blueprint failure logs a
   limitation and reconstruction proceeds with pre-blueprint behavior.

Methodology credits (techniques, not code): evidence ledger with
observed/inferred/substituted statuses, the fidelity contract as a build gate,
and the ambiguity resolution order — github.com/atharvsinh-codez/skills
(design-to-code references); interaction-model-before-building, scope defaults
over silent full-scope cloning, technical stack analysis —
github.com/nelakay/ai-website-cloner-claudeskill.

## Consequences

- `blueprint.json` exists in every new artifact tree — the canonical-record
  slot audit E flagged as missing is filled.
- Instructions survive the whole journey; scope decisions are auditable in the
  artifact tree, not implicit.
- Framework preferences are recorded honestly: the engine still emits static
  HTML/CSS/runtime, and a preference beyond that is flagged as an ambiguity,
  never silently ignored (the fake instruction check in verify.js remains to
  be replaced by a real blueprint-backed check — spec P1).
- Reconstruction report carries `report.blueprint` (scope, framework, model,
  ambiguity count) so the pipeline summary shows the contract that was honored.
- Tests: `npm run test:blueprint` (fixture-driven contract test).
