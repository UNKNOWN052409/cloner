# ADR-0002: The engine owns verification and export execution

- Status: Accepted (phase A implementation queued; phase B follows the realignment spec)
- Date: 2026-11-05
- Deciders: architecture review candidate 2 + docs/ARCHITECTURE.md's own
  "engine vs shell" rule, which the current file layout violates

## Context

`docs/ARCHITECTURE.md` declares the split: engine = exploration, reconstruction,
verification, export, no HTTP; shell = API, auth, tenants, billing. The layout
breaks its own rule:

- The deep verification module (702 lines: functional replay → completeness →
  visual diff → bounded repair rounds) lives at `src/platform/verify.js`.
- Importers verified 2026-11-05: `src/queues/pipeline-job.js:17` (an engine-side
  module reaching up into the shell for its own verification stage) and
  `src/platform/server.js:20` (shell adapter), plus four scripts. Five further
  engine modules (`repair-executor`, `repair-planner`, `component-pattern-detector`,
  `intelligence/visual-optimizer`, `skill-integration/section-gate`) reference it
  only in comments/provenance strings — documentation coupling, not imports;
  their pointers were updated in the same pass. (An earlier draft of this ADR
  miscounted those comments as imports; corrected for the record.)
- The seam leaks the other way too: `reconstruction-pipeline.js:19` →
  `platform/vision-client.js`; `vision-assist.js:20` → `platform/model-router.js`;
  `storage/artifact-lifecycle.js:31` → `platform/exporter.js`;
  `storage/artifact-replication.js:57` → `platform/ws-auth.js`.

Result: no one-way seam; verification's interface is not a test surface (its
consumers are spread across both sides); the shell accumulates engine logic.

## Decision

**Phase A (queued now):**
1. Move `src/platform/verify.js` → `src/reconstruction/verify.js`.
2. Update every import site to the engine path. No re-export shim — a
   pass-through wrapper fails the deletion test (complexity would move, not
   concentrate).
3. `src/platform/server.js` imports the engine module like any other adapter.

**Phase B (after the realignment spec lands, same direction):**
- Model-provider access (`vision-client.js`, `model-router.js`) behind an
  engine-owned adapter interface.
- Export execution (`exporter.js`) relocates into the engine; the shell keeps
  only the HTTP delivery routes.
- `isLoopback` / `isSensitiveName` move to a shared kernel or engine home so
  `storage/*` stops importing the shell.

Two adapters already justify the model-provider seam: HTTP providers in prod,
in-memory fakes in tests.

## Consequences

- The seam points one way: shell → engine, never engine → shell.
- Verification's interface (`verify(artifactsDir, evidence) → report`) becomes
  the test surface for the whole QA loop; the repair loop gains locality.
- Phase A touches 1 file move (git mv, history preserved) + 2 src import sites +
  4 script imports + comment/provenance pointers; tests that must stay green:
  `npm run test:visual-fidelity` (exercises `test-visual-fidelity.mjs` +
  `test-autonomous-repair.mjs`), `npm run test:integration`,
  `npm run test:reconstruction`.
- Phase B is scope-gated: only after the realignment spec's P0 work confirms
  the new orchestration shape, so the adapter is designed once, not twice.
