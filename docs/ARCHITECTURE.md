# Architecture — cloner platform (HEADLESS BACKEND + API)

> **Backend-only system (task G7.1).** The platform ships as a headless
> backend + API. The platform's own frontend (`platform-ui/` — index.html,
> app.js, style.css, admin.js, auth.js, ads.js, `src/`, `dist/`) was **removed
> entirely** on 2026-11-03. There are no static-file mounts and no `/ui`
> routes: the Express app serves `/api/*`, the `/ws` event stream, and the
> generated clones under `/preview/:id` — nothing else. Any non-API path
> falls through to the terminal 404.

## What is the platform

A service that clones websites: a caller submits a URL (with optional
credentials, instructions, and pipeline choice), the platform explores the
site with a real browser, reconstructs an editable project, verifies it, and
exposes the artifacts (preview + export ZIP).

## Topology

```
Caller (HTTP/WS client)
  │
  ├─ /healthz /readyz /metrics        probes + metrics (unauthenticated)
  ├─ /api/auth/*                      register / login / logout / me (sessions)
  ├─ /api/tasks /api/jobs/*           task + exploration-job lifecycle
  ├─ /api/export/:id[/download]       ZIP export
  ├─ /api/dashboard                   task-history + quota aggregate
  ├─ /api/config/*                    model-provider inventory / key rotation / probe
  ├─ /api/keys /api/orgs /api/admin   API keys, orgs, admin surface
  ├─ /api/quota/*                     quota usage + reconcile
  ├─ /ws                              authenticated task event stream
  └─ /preview/:id/**                  the GENERATED CLONE (still served — this is
                                      product output, not platform UI)
        │
  PostgreSQL (tasks, users, sessions, audit_events, quotas, …)
  Redis/BullMQ (clone queue)  ── worker processes run the engine (src/*.js)
```

## The engine vs. the shell

- **Engine (`src/*.js`):** exploration pipeline, reconstruction, verification,
  export. Framework-agnostic, no HTTP.
- **Shell (`src/platform/server.js` + routers):** the product API around the
  engine — auth, tenants/orgs, quotas, API keys, audit (hash-chained),
  artifact lifecycle, exports, health.

## Why headless (G7.1 decision)

- The platform is consumed programmatically (HTTP/WS clients) and by tests;
  the in-repo UI duplicated surfaces the API already provides and expanded the
  attack/maintenance surface.
- The **generated clones' frontend is NOT affected**: clones produced by tasks
  still render in any browser via `/preview/:id/**` (the element picker is
  still injected into preview HTML).
- Legacy local posture preserved: anonymous **loopback** callers keep their
  historical access to task reads/dashboards (`userId = null`); remote callers
  must authenticate.

## Consequences of the removal

| Removed | Replacement |
|---|---|
| `GET /` serving `platform-ui/index.html` | terminal 404 (no UI) |
| `GET /ui/**` static mount | terminal 404 |
| `platform-ui/` directory | deleted |
| Dashboard/model/admin screens | `/api/dashboard`, `/api/config/*`, `/api/admin/*` |

Suites that drove the removed screens (`scripts/test-ui-admin.mjs`,
`scripts/test-ui-dashboard.mjs`, the vite build configs) are retired by this
decision. The human-journey suite (`scripts/test-g55-hunt-human-journey.mjs`)
now exercises the same journey as the API a client performs, and still opens
the **generated clone** in headless Chromium with screenshots.

## Build & run

```
node bin/platform.js --port 4180        # API server (headless)
npm run test:platform                   # e2e suite
```

The Docker image copies `src/` + `bin/` only (no UI layer).
