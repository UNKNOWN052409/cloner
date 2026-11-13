# Security Audit — job `exp-mw60jhf5pwjh` (AUTHED)

- **Date:** 2026-11-07
- **Auditor:** security-auditor (workflow subagent)
- **Scope:** `artifacts/exp-mw60jhf5pwjh/` — credential-leak containment checks 1–4
  per the audit ask. Headless-only; no external navigation; no destructive
  interactions; secret values never printed (handled via pattern files).
- **Overall verdict: 4/4 PASS** (with 2 residual observations, non-blocking, see
  Findings 4b and R3).

---

## Method

Every finding below cites the exact command executed in this session and its
observed output. Secret values (`.env` `TV_PASS`, `STITCH_API_KEY`, session
cookie values, JWTs) were never printed to output: they were written to
temporary pattern files under `/tmp/sec-audit-mw60jhf5pwjh/` and consumed only
by `grep -F -f <pattern-file>`. Pattern files and the zip extraction were
deleted at the end (verified by `ls`).

Environment note: Git Bash `/tmp` is invisible to Windows Python; scans that
needed Python used `cygpath -w` to bridge paths.

---

## Check 1 — TV_PASS value appears NOWHERE under the job dir — **PASS**

Command (a), repo-root scan including the export.zip binary:

```
$ grep -rlF -f /tmp/sec-audit-mw60jhf5pwjh/pat.txt "artifacts/exp-mw60jhf5pwjh"
grep_exit=1 (1 = no matches)
```

`pat.txt` held the TV_PASS value extracted with
`sed -n 's/^TV_PASS=//p' .env | tr -d '\r'` (13 bytes = 12-char value + newline;
value withheld). `.env` itself was confirmed to define it:

```
$ grep -nE '^[A-Za-z_]+=' .env | sed -E 's/=.*/=<redacted>/'
3:TV_USER=<redacted>
4:TV_PASS=<redacted>
5:STITCH_API_KEY=<redacted>
6:STITCH_PROJECT_ID=<redacted>
$ grep -c '^TV_PASS=' .env
1
```

Command (b), cross-check over the *extracted* zip (catches any value stored
compressed, which a binary grep could miss):

```
$ unzip -q artifacts/exp-mw60jhf5pwjh/export.zip -d /tmp/.../zipx
$ grep -rlF -f pat.txt /tmp/.../zipx
grep_exit=1 (1 = no matches)
```

Result: zero matches in all 172 job-dir files and all 244 zip entries.

**Bonus (same method, different secret):** `STITCH_API_KEY` (53-char value)
also scanned clean:

```
$ grep -rlF -f pat2.txt "artifacts/exp-mw60jhf5pwjh"
grep_exit=1
$ grep -rlF -f pat2.txt /tmp/.../zipx
grep_exit=1
```

---

## Check 2 — auth files exist in job dir, NOT inside export.zip — **PASS**

Files exist:

```
$ ls -la "artifacts/exp-mw60jhf5pwjh/auth/"
-rw-r--r-- 1 Unkno 197609  1969 Nov  7 11:49 session-storage.json
-rw-r--r-- 1 Unkno 197609 13624 Nov  7 11:49 session.json
```

(`auth-sessions/` holds byte-equivalent copies: 13624 + 1969 bytes, same
timestamps — expected, it is the engine's session archive dir.)

Zip listing — the ask names `tar -tf ... | grep -i session`, which was run:

```
$ tar -tf artifacts/exp-mw60jhf5pwjh/export.zip | grep -i session
grep_exit_code=1 (1 = no matches = EXPECTED/PASS)
$ tar -tf artifacts/exp-mw60jhf5pwjh/export.zip | wc -l
0
```

⚠️ Important caveat caught by cross-checking: GNU tar in Git Bash **cannot read
zip files** (0 total entries = tar failed, not "empty zip"). A naive reading of
the ask's command would be a false PASS. Verified with real zip readers:

```
$ unzip -l artifacts/exp-mw60jhf5pwjh/export.zip | tail -3
 26567412                     244 files
$ python -c "import zipfile; z=zipfile.ZipFile(r'artifacts/exp-mw60jhf5pwjh/export.zip'); names=z.namelist(); sess=[n for n in names if 'session' in n.lower()]; print(len(names), sess if sess else 'NONE')"
244 entries / session-named entries: NONE
```

Result: 244 zip entries, **zero** containing "session" (case-insensitive).
`auth/session.json` + `auth/session-storage.json` exist in the job dir and are
absent from the export. PASS holds — but on the cross-checked evidence, not on
the tar output alone.

---

## Check 3 — no credential-shaped strings in job.log / exported project — **PASS**

```
$ grep -nEi 'Bearer|api_key[=:]|apikey[=:]' "artifacts/exp-mw60jhf5pwjh/logs/job.log"
grep_exit=1 (no matches)

$ grep -rnEi 'Bearer|api_key[=:]|apikey[=:]' /tmp/.../zipx | grep -v '\.png'
grep_exit=1 (no matches)

$ grep -rnEi 'x-goog-api-key|sk-[a-zA-Z0-9]{10}|token[=:]' /tmp/.../zipx 2>/dev/null | grep -v '\.png' > tokscan.txt
grep_exit=1; wc -l tokscan.txt → 0 → NO MATCHES
```

Result: no `Bearer`, `api_key=`/`apikey:`, `x-goog-api-key`, `sk-…` keys, or
`token=` assignments in `logs/job.log` (18,971 bytes) or any of the 244
extracted export files. PASS.

---

## Check 4 — authed clone pages contain no session tokens — **PASS**

Method: all 56 string values ≥8 chars from `auth/session.json` +
`auth/session-storage.json` (including every nested value inside
`api_authenticator_state`) were extracted to a pattern list and scanned across
the 39 clone HTML pages (`states/page-001/*.html`), the page captures
(`pages/*/dom.json|network.json|understanding.json`), the extracted export
(243 files), and `job.log`. Output was masked (first 4 chars + length).

```
CLONE PAGES(states/page-001/*.html): 39 files, value-hits=0, jwt-shaped=0
job.log: 1 files, value-hits=0, jwt-shaped=0
EXPORTED PROJECT: 243 files scanned, files-with-hits=5, value-hits=10, jwt-shaped=0
```

Generic JWT regex `eyJ…\.…\.…` across all surfaces: **0 matches**.

Critical auth cookies verified absent from all non-auth surfaces (0 hits):
`_twsid`, `kLh2jeKJ67G`, and 9× `__cf_bm` values. The JWT session token
(`SS:api_authenticator_state.token`, 299 chars) and `checkToken` (407 chars)
appear **only** in the two auth stores, nowhere else.

The 10 exported-project "value hits" are benign, verified by masked context:

| Value (masked) | Provenance | Where | Context |
|---|---|---|---|
| `TDFY…` (14) | `api_authenticator_state.username` | `project/page-001-state-02.html`, `pages/page-001-state-02/dom.json` | `Username</p>…<p class="cx-592 mt-1">[USERNAME]</p>` — the target app itself displays the logged-in username in the page UI; the clone reproduces it |
| `demo…` (21) | `apiHosts.demo` | `network.json`, `websocket.json`, `runtime/streams.js` | `…apiHosts…demo.tradovateapi.com` — public API hostname |
| `live…` (21) | `apiHosts.live` | `network.json` | `live.tradovateapi.com` — public API hostname |
| `user…` (32) | `apiHosts.userContext` | `network.json` | `user-context-api.ninjatrader.com` — public hostname |
| `md-d…` (24) | `apiHosts.mdDemo` | `websocket.json`, `streams.js` | `wss://md-demo.tradovateapi.com/…` — public hostname |
| `risk…` (37) | `apiHosts.riskMonitorDemo` | `websocket.json`, `streams.js` | `wss://risk-monitor-api-demo.ninjatrader.com/` — public hostname |

None of these is a credential: hostnames are public API endpoints; the username
is account identity (P1, see Findings).

**Verdict: PASS** — no session tokens, JWTs, or cookie values are embedded in
the authed clone pages or the export.

---

## Residual observations (non-blocking, from this scan)

1. **Account username leaked into export (P1).** The 14-char username
   (`TDFY…`, masked) from `api_authenticator_state.username` is rendered as
   page text in `project/page-001-state-02.html` and captured in
   `pages/page-001-state-02/dom.json` because the target app displays the
   logged-in user in its account UI. The clone faithfully reproduced it. Not a
   token, but it identifies the account — see R1.

2. **Git Bash `tar` silently fails on zip.** `tar -tf` returns exit 0 with
   empty output for a zip it cannot read, which turns "no matches" into a
   misleadingly authoritative result. Any CI gate using this pattern must
   cross-check with `unzip -l` / `python zipfile` (Check 2).

3. **Auth session files are live-account material at rest.** They correctly
   stay out of `export.zip`, but they sit under `artifacts/` (see R3).

---

## Recommendations

1. **Redact `username` from page captures and exported HTML** (P1): the
   exporter/capture pipeline should mask any occurrence of
   `api_authenticator_state.username` in DOM text the way it already excludes
   cookies/tokens. Suggested gate: extend the security audit to include a
   username-pattern check against `pages/**` and `export.zip`.
2. **Make the export.zip session check real:** replace
   `tar -tf | grep -i session` with `python -c "import zipfile,sys; …"` or
   `unzip -l` in the audit script; GNU tar cannot parse zip and returns an
   empty list on failure (verified above).
3. **TTL + permissions for `auth/` stores:** session.json contains long-lived
   JWT material (exp `2026…`, 24-char expiration string observed). Consider
   deleting auth stores on job completion, setting `chmod 600`-equivalents on
   Windows (ACL restrict to the running user), and adding a retention sweep.
4. **Add `Bearer`/JWT scanning as a pre-publish gate:** the checks above were
   run manually; codify them (TV_PASS, STITCH_API_KEY, JWT regex
   `eyJ…`, cookie names, username) into the platform's publish/verify
   pipeline so any future job fails closed instead of relying on ad-hoc
   audits.

---

## Files produced

- `docs/realignment/SECURITY-exp-mw60jhf5pwjh.md` (this report)

No code was modified; no git operations; no npm installs; no external network
access; nothing was clicked or submitted on any page. Temporary pattern files
under `/tmp/sec-audit-mw60jhf5pwjh/` were deleted after use (verified by `ls`).
