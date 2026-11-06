# CONTEXT.md — domain glossary (cloner)

Created 2026-11-05 during the architecture review (improve-codebase-architecture).
Domain terms come from docs/ARCHITECTURE.md and the engine's own vocabulary. ADRs in
`docs/adr/` record decisions these terms lean on — do not re-litigate them there.

## Terms

- **Clone task** — one user request to clone a website (URL + optional credentials +
  instructions + scope). Persisted in PostgreSQL via `src/database/task-repository.js`.
- **Engine** — the framework-agnostic cloning machinery under `src/` (exploration,
  reconstruction, verification, export execution). No HTTP. Kept separate from the shell.
- **Shell** — the headless API around the engine: `src/platform/server.js` + routers,
  auth, tenants, quotas, billing, audit. Adapters only; owns no engine logic.
- **Exploration** — a real browser investigates a site (scroll, click, open menus/tabs/
  dialogs) and writes evidence to disk. See `src/pipeline/exploration-pipeline.js`.
- **Artifact** — one recorded evidence file under `artifacts/<jobId>/` (DOM captures,
  screenshots, asset manifests, interaction records). The contract between exploration
  and everything downstream.
- **Understanding record** — the canonical, machine-readable understanding of a site
  (routes, pages, components, interactions, assets, tokens, coverage). Produced by
  analyzers, consumed by generators and verification. The one interface over it is
  `src/reconstruction/artifact-loader.js` (deepening: ADR-0003 queued).
- **Blueprint** — the fidelity contract written before reconstruction starts:
  instruction scope (include/exclude), detected stack → output-framework decision,
  per-page regions with observed/inferred evidence statuses, the interaction model,
  acceptance evidence and unresolved ambiguities. Written by
  `src/reconstruction/blueprint.js` to `artifacts/<jobId>/blueprint.json` (ADR-0003).
- **Reconstruction** — artifacts + user instructions → an editable, runnable frontend
  project under `artifacts/<jobId>-project/`. See `src/reconstruction/reconstruction-pipeline.js`.
- **Verification** — original vs clone: functional replay, completeness, visual diff,
  bounded autonomous repair rounds. Engine-owned (ADR-0002).
- **Export** — the finished project → downloadable ZIP / GitHub publish. Engine-owned
  execution (ADR-0002), HTTP delivery stays in the shell.
- **Clone pipeline** — the single module that sequences exploration → reconstruction →
  verification → export for one clone task: `src/queues/pipeline-job.js` (ADR-0001).
- **Queue adapter** — the seam that runs the clone pipeline in two modes: in-process
  bounded queue (`src/queues/clone-queue.js`, default, no Redis) and the BullMQ worker
  (`src/workers/clone-worker.js`, with `REDIS_URL`). Both call the same pipeline module.
- **Worker plane** — regional/distributed execution services under `src/distributed/`
  (region registry, worker plane, leases, failover, schedulers). Retained as-is.

## Decisions

- ADR-0001: one clone pipeline module; the 5-stage orchestrator is deleted.
- ADR-0002: verification and export execution belong to the engine, not the shell.
- ADR-0003: blueprint precedes reconstruction — scope and the fidelity contract
  come from evidence + instructions, never guessed.
