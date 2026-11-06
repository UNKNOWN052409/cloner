# ADR-0001: One clone pipeline module

- Status: Accepted (implementation queued — held until the realignment audit workflow settles)
- Date: 2026-11-05
- Deciders: owner directive ("no duplicate orchestration pipelines") + architecture review candidate 1

## Context

Two modules sequence the same clone lifecycle:

- `src/orchestration/pipeline-orchestrator.js` — `executePipeline()`, 5 stages
  (exploration → artifact_validation → reconstruction → verification → export),
  DB stage transitions via `task-repository.js`. **Zero callers** — verified by
  grep over `src/` and `bin/` on 2026-11-05; `src/workers/clone-worker.js`
  references it only in a comment.
- `src/queues/pipeline-job.js` — `runPipelineJob()`, 3 stages
  (exploration → reconstruction → verification), the definition actually executed
  by both queue modes (`src/queues/clone-queue.js` in-process and
  `src/workers/clone-worker.js` BullMQ), and the writer of the live
  `task_stages` rows.

Export is sequenced outside any lifecycle — the shell's export route calls
`src/platform/exporter.js` directly. So "where does a clone task actually run?"
spans three files and the lifecycle silently drops export.

## Decision

1. Fold the dead orchestrator's valuable parts into `src/queues/pipeline-job.js`:
   the export stage and the richer `task_stages` transitions
   (canonical names: exploration / artifact_validation / reconstruction /
   verification / export).
2. Delete `src/orchestration/pipeline-orchestrator.js`. Nothing imports it; the
   deletion test passes (complexity concentrates in the surviving module instead
   of just moving).
3. `runPipelineJob(payload, { jobId, report })` remains the one interface.
   The two queue modes stay as adapters at the seam — in-process
   (`clone-queue.js`) and BullMQ (`clone-worker.js`). The public API surface
   (`queueExploration` in `src/platform/exploration-runner.js`) is unchanged.

## Consequences

- One place runs the lifecycle; stage rows and job state cannot disagree.
- Export joins the job lifecycle (a completed clone task always ends with an
  export artifact), while the shell's `/api/export/:id` download route remains
  the delivery surface.
- `pipeline-job.js` will still import `verifyTask` / export execution from
  `src/platform/` until ADR-0002 phase B relocates them into the engine.
- Tests that must stay green: `npm run test:integration`,
  `npm run test:runtime-robustness`, `npm run test:exploration`,
  `npm run test:reconstruction`. New assertion: after `runPipelineJob`
  completes, the export stage row exists and an export artifact is present.
