# Phase 1 — Browser Intelligence Engine

Exploration pipeline: URL + auth + policy → autonomous exploration → machine-readable artifact tree (spec §15).

## Modules
| Module | Responsibility |
|---|---|
| src/observability/logger.js | Structured NDJSON logging (job/session/worker/page/state/correlation ids) |
| src/exploration/exploration-policy.js | Risk-aware interaction policy + bounded budgets (configurable) |
| src/exploration/route-discovery.js | Static links, nav menus, SPA pushState/hash recorder |
| src/exploration/state-discovery.js | State graph: fingerprinted nodes, dedup, transition edges |
| src/intelligence/dom-extractor.js | Per-element semantic + geometry + computed-style extraction (bounded sample), repeated components, fixed/sticky |
| src/network/network-recorder.js | Request/response metadata ring buffer |
| src/assets/asset-manifest.js | Hash dedup, type classification, download-vs-reconstruct classifier, responsive captures |
| src/storage/artifact-store.js | Versioned artifact tree writer + redact() |
| src/pipeline/exploration-pipeline.js | Orchestrates: auth detect → routes → per-page capture → DOM intel → states → graph → assets → manifest |

## Artifact contract (§15)

```
artifacts/<jobId>/
  manifest.json          # schemaVersion 1.0.0, coverage, errors, warnings, metrics
  pages/page-NNN/        # dom.json, styles.json, geometry.json, network.json, screenshot-viewport.png, responsive.json
  graph/                 # routes.json, states.json, transitions.json
  assets/manifest.json   # hash-deduped, classified (downloaded / downloaded-extractable / downloaded-inert / manual-review)
  reports/               # exploration-summary.json, coverage-report.json, failures.json
  logs/job.log           # NDJSON structured log
```

No credentials, cookies or authorization headers are stored in artifacts (redact() runs on every network entry and the manifest).

## Run

- Platform: POST /api/jobs/explore {url, cookies?, username?, password?, policy?} → poll GET /api/jobs/<jobId>
- CLI test: node scripts/test-exploration.mjs

