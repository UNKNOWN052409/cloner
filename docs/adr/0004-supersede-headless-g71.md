# ADR-0004: Supersede headless G7.1 — the platform ships a product UI again

- Status: Accepted (supersedes G7.1, "backend-only, UI removed", `docs/ARCHITECTURE.md:47-65`)
- Date: 2026-11-07
- Deciders: the owner's realignment directive — the 8-page product workflow is
  the confirmed product direction (the realignment spec labels it
  DECISION-CONFIRMED-BY-OWNER-DIRECTIVE, `docs/realignment/IMPLEMENTATION-SPEC.md:81-120`);
  implemented in this repository by the platform static mount in
  `src/platform/server.js`

## Context

Decision G7.1 removed the platform's own UI: `platform-ui/` was deleted (it
existed only in commit `cdffb15` — 3 files, 817 lines — and is absent at HEAD),
`src/platform/server.js` shipped headless ("There are NO static mounts: '/' and
every non-API path fall through to the terminal 404", the comment block that
used to sit at server.js:271-276), and clients were expected to integrate
through `/api/*` and `/ws` only.

The realignment audits found the rationale for that removal obsolete and
nothing blocking a product frontend:

- Every backend surface the deleted UI consumed is still mounted (tasks, jobs,
  artifacts, export, chat, WS); the WS fan-out is owner-scoped and working; the
  element-picker contract (`src/picker.js`) is intact.
- `platform-ui` was removed because a 397-line vanilla file could not carry
  eight product pages — a statement about that file's size, not about whether
  a frontend is wanted.
- The owner's realignment directive explicitly directs the 8-page product
  workflow served by the platform.

## Decision

G7.1 is superseded. The platform server serves the 8-page product UI as plain
static files from `<repo>/platform-ui/` through one sanctioned mount:

```js
app.use("/", express.static(path.join(__dirname, "..", "..", "platform-ui")));
```

placed AFTER every `/api`, `/preview` and `/progress` route in
`startPlatform()` (just before the terminal error handler), so the API keeps
absolute precedence by mount order: express walks the stack in order, an API
route always answers first, and `express.static` only ever sees what no route
claimed. `/ws` is an http-server upgrade handled by `WebSocketServer`, never
express middleware, so the mount cannot touch it. Unmatched paths still fall
through to Express's terminal 404 — the headless fallthrough behavior is
preserved for everything the UI does not own.

The mount sits at the root (`/`), which replaces the realignment spec's earlier
sketch of a prefixed mount (`app.use("/app", express.static(<dist>))` + history
fallback): with API precedence guaranteed by mount order there is no need for a
path prefix, and the product pages own the root like any product site does.

Posture: the static UI itself is PUBLIC, like a login page — deliberately not
wrapped in `localOrAuthed`. The UI is inert HTML/JS until its own code calls
the API, and every data surface behind `/api/*` keeps its existing guard chain
(`credentialed`, `localOrAuthed`, loopback legacy posture). Guarding the shell
would only hide the login screen from the people it is for.

## Consequences

- The API-first contract stays. The UI is a consumer of the same `/api` + `/ws`
  surfaces every external client uses — NOT a second pipeline, and it adds no
  engine code. The shell remains an adapter; `src/` stays HTTP-free.
- One server, no reverse proxy, no CORS changes (same-origin `/api`, `/ws`, and
  the session cookie).
- Building the 8 pages themselves (restoring/rewriting `platform-ui/` from the
  `cdffb15` skeleton per the realignment spec) is the separate frontend task —
  this ADR covers the serving decision and the mount only. Until the real UI
  lands, `/` serves 404 (or a placeholder) and nothing else changes.
- The legacy `dashboard/` trio (port 4173, CLI operator console) is untouched
  and remains out of the 8-page product.
- The "headless backend" comment block in `server.js` is replaced; future
  architecture reviews should treat "the platform is headless" as superseded
  rather than re-propose it (this ADR exists so G7.1 is not re-litigated in the
  other direction either — if the UI direction reverses, supersede THIS ADR).
