# OAuth — Google-only (task 4.5.1)

Owner directive: **OAuth sign-in is GOOGLE-ONLY. Email + password remains the
PRIMARY login.** GitHub OAuth was removed from every product path; GitHub
itself stays in the product for **code publishing via personal access tokens**
(`src/platform/github-publish-real.js`) — that is unrelated to sign-in.

## Routes

| Route | Behavior |
|---|---|
| `GET /api/auth/oauth/providers` | `{ providers: [{ provider: "google", label: "Google", configured }] }` — google only |
| `GET /api/auth/oauth/google/start` | 302 → Google authorization endpoint (state + PKCE S256). `?redirect=1` (or an `Accept: text/html` request) selects browser-redirect response mode |
| `GET /api/auth/oauth/google/callback` | Token exchange at the real token endpoint → userinfo → user upsert/link → platform session. JSON response `{ ok, token, userId, email, expiresAt }`, or `302 /#token=…` in browser mode |
| `/api/auth/oauth/github`, `/github/start`, `/github/callback` | **410 Gone** — `{ error: "github_oauth_removed", doc: "/docs/oauth.md", migration: "043-oauth-google-only.sql" }` |
| anything else under `/api/auth/oauth/:provider` | 404 |

Sessions issued by the OAuth flow are ordinary `sessions` rows, so
`authRequired` and `GET /api/auth/me` work unchanged.

## Configuration (env only — never credentials in code)

```
OAUTH_GOOGLE_CLIENT_ID=…
OAUTH_GOOGLE_CLIENT_SECRET=…
OAUTH_REDIRECT_BASE=            # optional; derived from the request when unset
```

Google Cloud console → APIs & Services → Credentials → OAuth client ID (Web
application). Authorized redirect URI:
`<public base>/api/auth/oauth/google/callback`.

Both vars absent → `GET /google/start` answers `503` naming the env vars; the
rest of the platform is unaffected.

Endpoint defaults are the real production endpoints
(`accounts.google.com`, `oauth2.googleapis.com`,
`openidconnect.googleapis.com`). `OAUTH_GOOGLE_AUTH_URL` / `_TOKEN_URL` /
`_USERINFO_URL` override the host for self-hosted OIDC deployments of the same
wire protocol only. The integration suite
(`scripts/test-oauth-google-only.mjs`) uses exactly those overrides to point
product code at a local IdP stand-in; the stand-in exists only in the test
file — product code always speaks the real protocol.

## Login / linking rules

1. Linked identity (`oauth_accounts.provider = 'google'` +
   `provider_account_id`) → that user.
2. **Verified** Google e-mail matching an existing `users` row → link to that
   user (password login keeps working).
3. Otherwise → new user with `password_hash NULL` (OAuth-only account).

Unverified provider e-mails never link to an existing local account
(account-takeover guard). Disabled accounts cannot OAuth-login.

IdP access/refresh tokens are never persisted — `oauth_accounts` stores
identity columns only.

## GitHub OAuth removal

Migration `src/database/migrations/043-oauth-google-only.sql` (forward-only):
deletes `oauth_accounts` rows with `provider = 'github'` (local users are
preserved — they keep signing in with email + password), purges stale
`oauth_states` for github, and tightens the provider `CHECK` constraint to
`'google'`-only. The 410 response on the legacy routes points here.
