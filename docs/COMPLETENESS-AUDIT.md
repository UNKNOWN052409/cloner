# Completeness Audit — engine reference (task 4.5.6)

The systematic finder for half-finished work. Owner complaint that motivated it:
*"bahut sa kaam adha chod diya"* — lots of work left half-done. This engine turns
that complaint into a repeatable, exit-code-driven check.

- Engine: `scripts/audit-completeness.mjs`
- Sensitivity proof: `scripts/test-audit-completeness.mjs`
- Report: `output/completeness-report.md` (+ `.json` for tooling)

## Run

```bash
node scripts/audit-completeness.mjs                 # scan repo root, write report
node scripts/audit-completeness.mjs --root DIR --out PATH.md --json PATH.json
```

**Exit code: `1` iff critical findings exist, else `0`.** Warnings and infos never
fail the run — criticals mean "shipped surface is provably unfinished".

Zero npm dependencies; Node built-ins only. ~2 s over the full repo (~277 files).

## What it hunts

| # | Category | Pattern | Severity |
|---|----------|---------|----------|
| 1 | `todo-marker` | `TODO` / `FIXME` inside comments | critical (product) / warning (tooling) / info (test) |
| 2 | `marker` | `XXX` / `HACK` inside comments | warning (product) / info (tooling, test) |
| 3 | `not-implemented` | `not implemented`, `unimplemented`, `NotImplementedError` | critical |
| 4 | `stub-return` | `return null/undefined/{}/[]/0/""` annotated stub/fake/placeholder/dummy/TODO/FIXME on the same or previous line | critical (product) / warning (tooling) |
| 5 | `empty-function` | named `function f() {}` or `const f = () => {}` with an empty body | warning |
| 6 | `mock-in-product` | import/require of a mock-looking module specifier, or `mock*`/`MOCK_*`/`jest.mock`/`vi.mock` identifiers, in a **non-test** file | critical (product) / warning (tooling) |
| 7 | `dead-501` | a `501` response whose line carries not-implemented/stub/TODO language | critical (product) / warning (tooling) |
| 8 | `http-501` | any bare `501` status use — verify it is an intentional capability gate | warning |
| 9 | `unwired-export` | exported symbol referenced nowhere outside its own file | warning |
| 10 | `test-code-in-product` | test/spec file shipped inside `src/` | warning |
| 11 | `placeholder-copy` | user-facing "coming soon" / "under construction" / "lorem ipsum" | warning |

### Severity tiers

- **Product** — `src/`, `bin/`, `platform-ui/`, `dashboard/`, and any root-level
  code file: strict tier.
- **Tooling** — `scripts/`, `docs/`: criticals drop to warnings, warnings to infos.
- **Test** — files under `test/`, `tests/`, `__tests__`, `__mocks__`, `__fixtures__`
  dirs, or named `test-*`, `spec-*`, `*.test.*`, `*.spec.*`, `*-test.*`: everything
  is informational. A test's SMTP simulator answering `"502 command not implemented"`
  is remote-side simulation data, not unfinished product work.

### The no-mocks rule, encoded

Mocks are legal **only** under test files, where they stand in for the REMOTE
third-party side (local HTTP/SMTP simulators per the mandate). In product paths a
mock import or mock identifier is a **critical** finding. The detector strips
comments and string contents before identifier matching, so documentation like
"there is no mock anywhere in this file" cannot fire — while a real
`import ... from "./mock-gateway.js"` always does.

## How it avoids false positives

1. **Position-preserving masking** — comment bodies and string-literal contents
   are replaced with spaces (newlines and offsets kept), so findings carry correct
   `file:line` while prose cannot trigger code-level checks. Template `${…}`
   expressions stay code. Known limitation: regex literals are not modeled; the
   worst case is over-masking (a missed finding), never a false one.
2. **Markers only in comments** — `const label = "TODO items: 3"` (a task-list
   feature) does not fire; `// TODO: wire the gateway` does.
3. **Specifier-aware mock check** — the import check reads the raw specifier
   string; the identifier check reads masked code.
4. **`*-spec.js` is not a test** — `style-spec.js` is a specification document;
   only `foo.spec.js`, `foo.test.js`, `foo-test.js`, `test-foo.js`, `spec-foo.js`
   count as test files.
5. **`noop` idiom** — `const noop = () => {}` default callbacks are conventional,
   not stubs.
6. **Scanner self-exemption** — the engine's own file contains every trigger
   pattern as regex data; lexical self-detection there is skipped by design
   (structural checks still apply).
7. **Unwired = truly unwired** — a symbol is flagged only when its identifier
   appears in NO other scanned file (raw or masked text), so same-file-only
   helpers, dynamic `import()` consumers, and test consumers all count as wiring.
   Re-exports (`export { x } from './y'`) are pass-throughs, not hooks.

Known false-positive surface that stays deliberately visible: bare `http-501`
capability gates (e.g. `region-registry.js` answering `501 no_registry` when a
node has no registry attached) — the warning exists to force that verification,
and comment-only function bodies (e.g. an interface `close()` documented as
owned elsewhere).

## Sensitivity proof

`scripts/test-audit-completeness.mjs` seeds every violation class into
`fixtures/completeness-audit/` and asserts **all of them are caught**, with the
right category, severity, and file, plus the negative cases:

- `fixtures/completeness-audit/critical/` — mock import in a product file, TODO,
  HACK, `throw "not implemented"`, stub return, dead 501, bare 501, two unwired
  exports, an empty function, and a test file misplaced in `src/` → scanner exits 1.
- `fixtures/completeness-audit/warnings-only/` — XXX/HACK, unwired export, bare
  501, "coming soon" copy, empty function, tooling-tier TODO/XXX → findings exist
  but the scanner **exits 0** (exit code tracks criticals only).
- `fixtures/completeness-audit/clean/` — a real module whose comments/strings
  deliberately walk near every detector ("no mocks", "TODO list" in a string,
  200/503 statuses, wired exports) → **zero findings**, exit 0.
- Mock usage inside `test/` fixture files produces no findings (legality).

The test then runs the engine on the REAL repo, verifies the report files exist
and that markdown counts match the JSON, and asserts the process exit code
equals `criticals > 0`.

## Baseline (2026-11-02, real repo scan)

- 280 files scanned, 0 critical / 195 warning / 3 info → exit 0.
- The scan is deterministic: two consecutive runs produced byte-identical
  finding sets (verified in the test cycle). Note for future runs: sibling
  agents editing the repo concurrently change the file set between runs; only
  same-run comparisons are meaningful.
- Notable true positives (warnings): the `platform-ui/src/api/*.ts` dashboard
  API layer is exported but imported by nothing (191 unwired-export findings
  total, spot-verified against `grep` importers — e.g. `getAuthToken`,
  `normalizeTaskRow` have zero external word-boundary hits, while the wired
  `queryAuditEvents` has 24 and is correctly absent from findings);
  `src/platform/exhaustive-test.js` is test code inside the product tree; two
  intentional `501` capability gates in `src/distributed/region-registry.js`.
- The `not-implemented` infos are SMTP remote-side simulators inside test
  files — correct per the no-mocks mandate, not product gaps.

Fix the warnings by wiring or deleting; re-run the engine; the report and exit
code are the receipt.
