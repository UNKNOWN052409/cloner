# Cloner Platform API

The platform is a **headless backend** (its own UI was removed by design, G7.1).
All integration happens through `/api/*`, the WebSocket at `/ws`, and the
generated clones served under `/preview/:id`.

- Base URL: `http://<host>:4180` (port via `PORT`, default 4180)
- Auth: session tokens (Authorization: Bearer) — see [Authentication](#authentication)
- Versioned public surface: `/api/v1/*` (see [Public API v1](#public-api-v1))

## Authentication

Register, then login to obtain a session token. Every authenticated route
accepts `Authorization: Bearer <token>` (header-only — query tokens are
refused by design).

### Register

```bash
curl -s -X POST http://127.0.0.1:4180/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.test","password":"correct-horse-battery"}'
```

Response: `{"ok":true,"userId":"…","email":"dev@example.test"}`

### Login

```bash
curl -s -X POST http://127.0.0.1:4180/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.test","password":"correct-horse-battery"}'
```

Response: `{"ok":true,"token":"…","userId":"…","email":"…","expiresAt":"…"}`

### Who am I

```bash
curl -s http://127.0.0.1:4180/api/auth/me -H "Authorization: Bearer $TOKEN"
```

## Tasks

### Create a clone task (pipeline v2)

```bash
curl -s -X POST http://127.0.0.1:4180/api/tasks \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"url":"https://example.com","pipeline":"v2"}'
```

Response: `{"id":"…","status":"queued","pipeline":"v2"}`

### List tasks

```bash
curl -s http://127.0.0.1:4180/api/tasks -H "Authorization: Bearer $TOKEN"
```

### Task detail

```bash
curl -s http://127.0.0.1:4180/api/tasks/<taskId> -H "Authorization: Bearer $TOKEN"
```

### Delete a task

```bash
curl -s -X DELETE http://127.0.0.1:4180/api/tasks/<taskId> -H "Authorization: Bearer $TOKEN"
```

## Dashboard

```bash
curl -s http://127.0.0.1:4180/api/dashboard -H "Authorization: Bearer $TOKEN"
```

## Quotas (fair use, not billing)

```bash
curl -s http://127.0.0.1:4180/api/quota/usage -H "Authorization: Bearer $TOKEN"
```

## Credits (free platform)

Credits are granted FREE and unlimited. Claim more any time — the endpoint
never denies and never asks for payment.

```bash
curl -s -X POST http://127.0.0.1:4180/api/billing/checkout \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"credits":100}'
```

## Onboarding

```bash
curl -s http://127.0.0.1:4180/api/onboarding -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://127.0.0.1:4180/api/onboarding/steps/profile \
  -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"payload":{"fullName":"Dev"},"skip":false}'
curl -s -X POST http://127.0.0.1:4180/api/onboarding/complete -H "Authorization: Bearer $TOKEN"
```

## Templates

```bash
curl -s http://127.0.0.1:4180/api/templates
curl -s http://127.0.0.1:4180/api/templates?category=dashboard
```

## Versions

```bash
curl -s http://127.0.0.1:4180/api/versions/tasks/<taskId> -H "Authorization: Bearer $TOKEN"
```

## Activity

```bash
curl -s http://127.0.0.1:4180/api/activity -H "Authorization: Bearer $TOKEN"
curl -s http://127.0.0.1:4180/api/activity/unread -H "Authorization: Bearer $TOKEN"
```

## Plans

```bash
curl -s http://127.0.0.1:4180/api/plans/effective -H "Authorization: Bearer $TOKEN"
```

## Live-provider examples (SKIP marker)

The following examples require LIVE external services configured via env and
are skipped by the docs test (`test-docs-examples.mjs` treats the
`skip-live:` marker as "do not execute"):

```bash
# skip-live: requires GITHUB_PUBLISH_TOKEN — publishes a project to GitHub
curl -s -X POST http://127.0.0.1:4180/api/github/publish \
  -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"owner":"you","repo":"my-clone","dir":"artifacts/<jobId>-project"}'
```

## Error codes

| Code | Meaning |
| ---- | ------- |
| `UNAUTHENTICATED` | 401 — no/invalid session token |
| `NOT_FOUND` | 404 — resource missing or not owned by the caller |
| `VERSION_NOT_SUPPORTED` | 406 — requested API version not served (v1 only) |
| `QUOTA_EXCEEDED` | 402 — fair-use QUOTA denial (reason names the limit) |
| `GITHUB_TOKEN_MISSING` | 503 — GITHUB_PUBLISH_TOKEN env not set |
| `BILLING_PROVIDER_NOT_CONFIGURED` | 503 — no billing provider registered (free platform default) |
