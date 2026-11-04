// Real OAuth — GOOGLE-ONLY (task 4.5.1 google-only-oauth, owner directive).
//
// ── Owner directive ─────────────────────────────────────────────────────────
// OAuth sign-in is GOOGLE-ONLY. GitHub OAuth is removed from every product
// path: the legacy /api/auth/oauth/github/* routes answer 410 Gone (see the
// `githubGone` handlers below), the provider catalog below has no github
// entry, and migration 043-oauth-google-only.sql unlinks any github-oauth
// account rows created by the earlier partial build. GitHub itself stays in
// the product for CODE PUBLISHING via personal access tokens only
// (src/platform/github-publish-real.js). Email + password remains the
// PRIMARY login (src/auth/auth-service.js).
//
// ── What this module is ─────────────────────────────────────────────────────
// Product code that drives the REAL Google IdP:
//   start    → 302 redirect to the Google authorization endpoint
//              (state + PKCE S256)
//   callback → token exchange at the Google token endpoint → userinfo fetch
//              → user upsert/link → platform session (users + sessions rows)
//
// Endpoint configuration comes from env. Defaults are the REAL production
// endpoints (accounts.google.com / oauth2.googleapis.com /
// openidconnect.googleapis.com). The OAUTH_GOOGLE_*_URL overrides exist for
// legitimate deployments against a different host of the SAME OIDC protocol
// (self-hosted/gov-cloud instances). There is no mock/fake anywhere in this
// file: in tests the REMOTE side is simulated by a local HTTP server standing
// in for Google, and the overrides simply point the client at it.
//
// No credentials are ever hard-coded or logged: the client id/secret are read
// from OAUTH_GOOGLE_CLIENT_ID / OAUTH_GOOGLE_CLIENT_SECRET and IdP tokens are
// used transiently in memory only (never persisted — oauth_accounts stores
// identity columns exclusively, see migrations/040-oauth.sql and
// migrations/043-oauth-google-only.sql).
//
// ── Contract for the integrator (src/platform/server.js is integrator-owned)
// Mount with:   app.use("/api/auth/oauth", oauthRouter);
// The router is self-contained (no authRequired — start/callback ARE the
// login). Sessions it creates are ordinary `sessions` rows, so the existing
// authRequired middleware and GET /api/auth/me work unchanged. Doc pointer
// for the removed GitHub routes: docs/oauth.md.

import crypto from "node:crypto";
import { Router } from "express";
import { query, withTransaction } from "../database/client.js";
import { recordAuditEventSafe } from "./audit-service.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — matches auth-service
const STATE_TTL_MS_DEFAULT = 10 * 60 * 1000;    // 10 min single-use CSRF window
const HTTP_TIMEOUT_MS = 15_000;
const OAUTH_DOC_PATH = "/docs/oauth.md";

// base64url without padding (RFC 7636 §4.2)
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256b64url = (s) => b64url(crypto.createHash("sha256").update(s).digest());
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

// ── Provider catalog (google-only) ──────────────────────────────────────────
// Real endpoints by default; OAUTH_GOOGLE_*_URL overrides the host for
// self-hosted OIDC deployments of the same wire protocol. The github entry
// from the earlier dual-provider build is gone: requesting it returns 410.
export const PROVIDER_DEFAULTS = {
  google: {
    key: "google",
    label: "Google",
    clientIdEnv: "OAUTH_GOOGLE_CLIENT_ID",
    clientSecretEnv: "OAUTH_GOOGLE_CLIENT_SECRET",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    authUrlEnv: "OAUTH_GOOGLE_AUTH_URL",
    tokenUrl: "https://oauth2.googleapis.com/token",
    tokenUrlEnv: "OAUTH_GOOGLE_TOKEN_URL",
    userUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    userUrlEnv: "OAUTH_GOOGLE_USERINFO_URL",
    scope: "openid email profile",
    pkce: true, // Google requires/strongly recommends PKCE (S256)
    tokenAccept: "application/x-www-form-urlencoded",
    // Deterministic fallback for the (rare) Google account that exposes no
    // e-mail: identity-keyed synthetic local address.
    syntheticEmail: (identity) => `${identity.id}+${identity.username || "user"}@noreply.oauth.google.local`,
  },
};

// Providers retired by the Google-only directive → HTTP 410 (with doc pointer)
// instead of a silent 404. Anything unlinked is handled by
// migrations/043-oauth-google-only.sql (forward-only).
export const RETIRED_PROVIDERS = { github: "043-oauth-google-only.sql" };

const override = (name, fallback) => (process.env[name]?.trim() || fallback);

export function getProviderConfig(provider) {
  const def = PROVIDER_DEFAULTS[provider];
  if (!def) return null;
  const clientId = process.env[def.clientIdEnv]?.trim() || "";
  const clientSecret = process.env[def.clientSecretEnv]?.trim() || "";
  return {
    ...def,
    clientId,
    clientSecret,
    authUrl: override(def.authUrlEnv, def.authUrl),
    tokenUrl: override(def.tokenUrlEnv, def.tokenUrl),
    userUrl: override(def.userUrlEnv, def.userUrl),
    configured: Boolean(clientId && clientSecret),
  };
}

// ── Identity normalization (Google userinfo / OIDC standard claims) ─────────
// Returns { id, username, email, emailVerified, displayName, avatarUrl }
async function fetchGoogleIdentity(cfg, accessToken) {
  const info = await getJson(cfg.userUrl, { authorization: `Bearer ${accessToken}` });
  if (!info || info.sub == null) throw new Error("Google userinfo request failed");
  const email = typeof info.email === "string" && info.email.includes("@") ? info.email.toLowerCase() : null;
  return {
    id: String(info.sub),
    username: info.email ? String(info.email).split("@")[0] : null,
    email,
    emailVerified: info.email_verified === true,
    displayName: info.name ? String(info.name) : null,
    avatarUrl: info.picture ? String(info.picture) : null,
  };
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`IdP request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── Token exchange (REAL Google token endpoint) ─────────────────────────────
async function exchangeCodeForTokens(cfg, { code, redirectUri, codeVerifier }) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri,
  });
  if (cfg.pkce && codeVerifier) form.set("code_verifier", codeVerifier);
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      accept: cfg.tokenAccept,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch {
    // Some legacy IdPs answer x-www-form-urlencoded
    json = Object.fromEntries(new URLSearchParams(text));
  }
  if (!res.ok || json.error || !json.access_token) {
    const why = json.error_description || json.error || `HTTP ${res.status}`;
    throw new Error(`token exchange failed: ${why}`);
  }
  return json;
}

// ── User upsert / link (single transaction, race-safe via UNIQUE constraints)
// Link precedence:
//   1. existing oauth_accounts(provider, provider_account_id) → that user
//   2. verified e-mail matches an existing users row → link to that user
//   3. create a fresh user (password_hash NULL — OAuth-only account)
// Unverified provider e-mails NEVER link to an existing local account
// (account-takeover guard): they only ever create/link the provider-keyed
// identity, with a deterministic synthetic local e-mail.
export async function upsertOAuthUser(provider, identity) {
  return withTransaction(async (client) => {
    // 1. already linked?
    const linked = await client.query(
      `SELECT u.id, u.email, u.role, u.status
         FROM oauth_accounts oa JOIN users u ON u.id = oa.user_id
        WHERE oa.provider = $1 AND oa.provider_account_id = $2`,
      [provider, identity.id]
    );
    if (linked.rows.length) return linked.rows[0];

    // 2./3. resolve the local user this identity belongs to
    let target = null;
    if (identity.email && identity.emailVerified) {
      const byEmail = await client.query(
        "SELECT id, email, role, status FROM users WHERE email = $1",
        [identity.email]
      );
      target = byEmail.rows[0] || null;
    }
    if (!target) {
      const localEmail = (identity.email && identity.emailVerified)
        ? identity.email
        : PROVIDER_DEFAULTS[provider].syntheticEmail(identity);
      // ON CONFLICT DO UPDATE makes the insert return the row either way —
      // concurrent first logins converge on the same users row.
      const created = await client.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, NULL)
         ON CONFLICT (email) DO UPDATE SET updated_at = now()
         RETURNING id, email, role, status`,
        [localEmail]
      );
      target = created.rows[0];
    }

    // Claim/refresh the identity link atomically; the RETURNING user_id is
    // authoritative (wins over any racing email match).
    const claim = await client.query(
      `INSERT INTO oauth_accounts
         (user_id, provider, provider_account_id, provider_username, provider_email, provider_avatar_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, provider_account_id) DO UPDATE SET
         provider_username = EXCLUDED.provider_username,
         provider_email = EXCLUDED.provider_email,
         provider_avatar_url = EXCLUDED.provider_avatar_url,
         updated_at = now()
       RETURNING user_id`,
      [target.id, provider, identity.id, identity.username, identity.email, identity.avatarUrl]
    );
    const userId = claim.rows[0].user_id;
    const final = await client.query("SELECT id, email, role, status FROM users WHERE id = $1", [userId]);
    return final.rows[0];
  });
}

// ── Session creation (same shape as auth-service.loginUser) ────────────────
export async function createSessionForUser(user) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [user.id, hashToken(token), expires]);
  return { token, userId: user.id, email: user.email, role: user.role, expiresAt: expires.toISOString() };
}

// ── State store (single-use CSRF + PKCE verifier, server-side) ──────────────
// browser_redirect is persisted at /start because the IdP echoes only the
// redirect_uri — the callback's response-mode preference must survive the
// round trip instead of depending on query flags the IdP will drop.
async function persistState({ state, provider, codeVerifier, redirectUri, browserRedirect }) {
  const ttlMs = Number(process.env.OAUTH_STATE_TTL_MS) > 0 ? Number(process.env.OAUTH_STATE_TTL_MS) : STATE_TTL_MS_DEFAULT;
  await query(
    `INSERT INTO oauth_states (state, provider, code_verifier, redirect_uri, browser_redirect, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [state, provider, codeVerifier, redirectUri, Boolean(browserRedirect), new Date(Date.now() + ttlMs)]
  );
}

// Atomic single-use claim: the DELETE returns the row exactly once; expiry is
// enforced in the same statement so a replayed/expired state can never pass.
async function consumeState(state, provider) {
  const res = await query(
    `DELETE FROM oauth_states WHERE state = $1 AND provider = $2 AND expires_at > now()
     RETURNING code_verifier, redirect_uri, browser_redirect`,
    [state, provider]
  );
  return res.rows[0] || null;
}

// ── Router ──────────────────────────────────────────────────────────────────
function baseUrlFromReq(req) {
  if (process.env.OAUTH_REDIRECT_BASE?.trim()) return process.env.OAUTH_REDIRECT_BASE.trim().replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"]?.split(",")[0]?.trim() || req.protocol || "http";
  const host = req.headers["x-forwarded-host"]?.split(",")[0]?.trim() || req.get("host");
  return `${proto}://${host}`;
}

function wantsBrowserRedirect(req) {
  return req.query.redirect === "1" || String(req.headers.accept || "").includes("text/html");
}

export function oauthRouter() {
  const router = Router();

  // Which providers are configured (UI renders buttons for these).
  // Google-only: no github entry exists anymore, by directive.
  router.get("/providers", (_req, res) => {
    const providers = Object.keys(PROVIDER_DEFAULTS).map((p) => {
      const cfg = getProviderConfig(p);
      return { provider: p, label: cfg.label, configured: cfg.configured };
    });
    res.json({ providers });
  });

  // ── Retired providers (GitHub OAuth): 410 Gone with a doc pointer ─────────
  // The earlier dual-provider build mounted /github/start and /github/callback
  // here; they were removed by the Google-only directive. Clients get an
  // explicit 410 (not a 404) so integrations can distinguish "removed" from
  // "never existed", and the body points at docs/oauth.md.
  const githubGone = (_req, res) => {
    res.status(410).json({
      error: "github_oauth_removed",
      message: "GitHub OAuth sign-in was removed — OAuth is Google-only. " +
        "Sign in with Google or email + password. GitHub remains supported for " +
        "code publishing via personal access tokens only.",
      doc: OAUTH_DOC_PATH,
      migration: RETIRED_PROVIDERS.github,
      provider: "github",
    });
  };
  router.all("/github", githubGone);
  router.all("/github/start", githubGone);
  router.all("/github/callback", githubGone);
  router.all("/github/*", githubGone);

  // Step 1 — redirect the user to the REAL Google authorization endpoint.
  router.get("/google/start", async (req, res) => {
    const cfg = getProviderConfig("google");
    if (!cfg.configured) {
      return res.status(503).json({
        error: `${cfg.label} OAuth is not configured — set ${cfg.clientIdEnv} and ${cfg.clientSecretEnv}`,
        provider: "google",
      });
    }
    const baseUrl = baseUrlFromReq(req);
    const redirectUri = `${baseUrl}/api/auth/oauth/google/callback`;
    const state = crypto.randomBytes(32).toString("hex");
    const codeVerifier = cfg.pkce ? b64url(crypto.randomBytes(64)) : null;

    try {
      await persistState({ state, provider: "google", codeVerifier, redirectUri, browserRedirect: wantsBrowserRedirect(req) });
    } catch (e) {
      console.error("[oauth] state persist failed:", e.message);
      return res.status(500).json({ error: "oauth state persistence failed" });
    }

    const auth = new URL(cfg.authUrl);
    auth.searchParams.set("client_id", cfg.clientId);
    auth.searchParams.set("redirect_uri", redirectUri);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", cfg.scope);
    auth.searchParams.set("state", state);
    if (cfg.pkce) {
      auth.searchParams.set("code_challenge", sha256b64url(codeVerifier));
      auth.searchParams.set("code_challenge_method", "S256");
    }
    auth.searchParams.set("access_type", "online");
    auth.searchParams.set("prompt", "select_account");
    res.redirect(302, auth.toString());
  });

  // Step 2 — Google redirects here with ?code&state (or ?error). Consume the
  // state, exchange the code at the REAL token endpoint, fetch the REAL
  // profile, upsert the user, issue a platform session.
  router.get("/google/callback", async (req, res) => {
    const provider = "google";
    const cfg = getProviderConfig(provider);
    if (!cfg.configured) {
      return res.status(503).json({
        error: `${cfg.label} OAuth is not configured — set ${cfg.clientIdEnv} and ${cfg.clientSecretEnv}`,
        provider,
      });
    }
    const baseUrl = baseUrlFromReq(req);
    let stateRow = null;
    // Evaluated lazily: the browser-redirect preference lives in the state row
    // (persisted at /start), so it is only known once the state is consumed.
    const htmlMode = () => stateRow?.browser_redirect === true || wantsBrowserRedirect(req);
    const fail = (status, code, message) => {
      recordAuditEventSafe({
        action: "auth.login.failure",
        outcome: "failure",
        actorType: "anonymous",
        targetType: "session",
        metadata: { provider, reason: code, message: String(message).slice(0, 200) },
        ip: req.ip,
      });
      if (htmlMode()) {
        return res.redirect(302, `${baseUrl}/?oauth=error&reason=${encodeURIComponent(code)}`);
      }
      return res.status(status).json({ error: message, provider });
    };

    if (req.query.error) {
      return fail(400, "provider_denied", `provider returned error: ${req.query.error}`);
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !state) return fail(400, "missing_params", "missing code or state on oauth callback");

    try {
      stateRow = await consumeState(state, provider);
    } catch (e) {
      console.error("[oauth] state consume failed:", e.message);
      return fail(500, "state_error", "oauth state validation failed");
    }
    if (!stateRow) return fail(400, "invalid_state", "invalid, expired, or already-used oauth state");

    try {
      const tokens = await exchangeCodeForTokens(cfg, {
        code,
        redirectUri: stateRow.redirect_uri,
        codeVerifier: stateRow.code_verifier,
      });
      const identity = await fetchGoogleIdentity(cfg, tokens.access_token);
      const user = await upsertOAuthUser(provider, identity);
      if (user.status !== "active") {
        return fail(403, "account_disabled", "account disabled");
      }
      const session = await createSessionForUser(user);
      // NOTE: no sessionId field — audit_events.session_id is a UUID column
      // (015-audit-logs.sql) and the opaque session token is not a UUID;
      // passing one would make the insert fail (recordAuditEventSafe would
      // swallow it and the login event would never land).
      recordAuditEventSafe({
        action: "auth.login.success",
        actorId: user.id,
        actorEmail: user.email,
        actorType: "user",
        targetType: "session",
        targetId: user.id,
        metadata: { provider, providerAccountId: identity.id, oauthOnly: true },
        ip: req.ip,
      });
      if (htmlMode()) {
        // First-party SPA handoff via URL fragment (never sent to a server).
        const frag = new URLSearchParams({ token: session.token, provider, email: user.email });
        return res.redirect(302, `${baseUrl}/#${frag.toString()}`);
      }
      return res.json({
        ok: true,
        provider,
        token: session.token,
        userId: session.userId,
        email: session.email,
        expiresAt: session.expiresAt,
      });
    } catch (e) {
      console.error(`[oauth] ${provider} callback failed:`, e.message);
      return fail(502, "upstream_error", e.message.slice(0, 200));
    }
  });

  return router;
}
