#!/usr/bin/env node
// Google-only OAuth e2e (task 4.5.1 google-only-oauth).
//
// Owner directive under test: OAuth is GOOGLE-ONLY. GitHub OAuth is removed
// from every product path (legacy routes answer 410 Gone); email + password
// stays PRIMARY.
//
// Boots the platform (real auth/session flows) on an EPHEMERAL port against
// the compose PostgreSQL, mounts the google-only oauth router from
// src/platform/oauth-real.js on a test-local Express app (server.js is
// integrator-owned; same pattern as scripts/test-oauth-real.mjs), and runs
// the FULL human journey over live HTTP:
//
//   GET /api/auth/oauth/google/start → 302 to the Google authorize endpoint
//   → (we follow it) Google 302s back to /callback?code&state → product code
//   POSTs the code to the token endpoint → fetches userinfo → upserts/links
//   the user → issues a platform session → session validated at
//   GET /api/auth/me.
//
// The ONLY simulation is the remote IdP: a local node:http server standing in
// for Google (it enforces the same contract the real one does — correct
// client_id on authorize, single-use codes, redirect_uri match, PKCE S256
// verifier, client_secret at token exchange). Product code itself is
// exercised unmodified; the OAUTH_GOOGLE_*_URL env overrides simply point it
// at the local IdP stand-in (the same override mechanism exists in product
// for self-hosted OIDC deployments; defaults stay the real Google endpoints).
// No mocks exist in src/platform/oauth-real.js and none are stubbed here —
// every step is a real HTTP request.
//
// Prints PASS/FAIL lines, exits nonzero on any failure, closes everything.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // platform-data etc. are cwd-relative

// ---- capture stdout/stderr for the "no secret material in logs" check ----
const logLines = [];
const origLog = console.log, origErr = console.error;
console.log = (...a) => { const s = a.join(" "); logLines.push(s); process.stdout.write(s + "\n"); };
console.error = (...a) => { const s = a.join(" "); logLines.push(s); process.stderr.write(s + "\n"); };

// ---- isolated OAuth env: wipe anything inherited, then set test config ----
for (const k of Object.keys(process.env)) if (k.startsWith("OAUTH_")) delete process.env[k];
const GOOGLE_ID = "goog-e2e-client-" + Math.random().toString(36).slice(2);
const GOOGLE_SECRET = "goog-e2e-secret-" + crypto.randomBytes(16).toString("hex");

// ---- IdP stand-in config (identities the mock Google provider "has") ----
const GOOG_IDENTITIES = {
  default:   { sub: "g-77001", email: "oauth-e2e-goog@example.invalid",      email_verified: true,  name: "Goog Ler",  picture: "http://127.0.0.1:1/goog.png" },
  link:      { sub: "g-77002", email: "oauth-e2e-link@example.invalid",      email_verified: true,  name: "Link Er",   picture: "http://127.0.0.1:1/link.png" },
  unverified:{ sub: "g-77003", email: "oauth-e2e-unverified@example.invalid", email_verified: false, name: "Un Ver",    picture: "http://127.0.0.1:1/unv.png" },
  disabled:  { sub: "g-77004", email: "oauth-e2e-disabled@example.invalid",  email_verified: true,  name: "Dis Abl",   picture: "http://127.0.0.1:1/dis.png" },
  failure:   { sub: "g-77005", email: "oauth-e2e-failure@example.invalid",   email_verified: true,  name: "Fail Ur",   picture: "http://127.0.0.1:1/fail.png" },
  noemail:   { sub: "g-77006", email: null,                                  email_verified: false, name: "No Email",  picture: "http://127.0.0.1:1/noe.png" },
};

// Mutable mock behavior knobs (failure injection, next identity selection).
const mockState = {
  nextGoogleIdentity: GOOG_IDENTITIES.default,
  tokenError: null,        // e.g. "invalid_client" → token endpoint 400
  codes: new Map(),        // code → { state, redirectUri, challenge }
  tokens: new Map(),       // access_token → identity descriptor
  authorizeCalls: [], tokenCalls: [], userinfoCalls: [],
};

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256b64url = (s) => b64url(crypto.createHash("sha256").update(s).digest());

// filled in during bootstrap (see exerciseMigration043 below)
let migrationExercised = "";
let migrationError = null;

// ---- the remote-end simulator: a local http server wearing Google's hat ----
const idp = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://idp.local");
  const send = (status, obj, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(obj));
  };
  const readBody = () => new Promise((resolve) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(b))));
  });

  // ── Google persona ──
  if (url.pathname === "/gl/oauth2/v2/auth") {
    mockState.authorizeCalls.push(Object.fromEntries(url.searchParams));
    if (url.searchParams.get("client_id") !== GOOGLE_ID) return send(400, { error: "bad client_id" });
    if (!String(url.searchParams.get("redirect_uri") || "").includes("/api/auth/oauth/google/callback")) {
      return send(400, { error: "bad redirect_uri" });
    }
    if (!url.searchParams.get("state")) return send(400, { error: "missing state" });
    if (url.searchParams.get("code_challenge_method") !== "S256" || !url.searchParams.get("code_challenge")) {
      return send(400, { error: "pkce required" });
    }
    const code = "glcode-" + crypto.randomBytes(12).toString("hex");
    mockState.codes.set(code, { state: url.searchParams.get("state"), redirectUri: url.searchParams.get("redirect_uri"),
      challenge: url.searchParams.get("code_challenge") });
    res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${url.searchParams.get("state")}` });
    return res.end();
  }
  if (url.pathname === "/gl/token" && req.method === "POST") {
    const body = await readBody();
    mockState.tokenCalls.push({ body, accept: req.headers.accept });
    if (mockState.tokenError) return send(400, { error: mockState.tokenError, error_description: "the code is bad" });
    if (body.grant_type !== "authorization_code") return send(400, { error: "unsupported_grant_type" });
    // Wrong client credentials → exactly what the real Google token endpoint does.
    if (body.client_id !== GOOGLE_ID || body.client_secret !== GOOGLE_SECRET) {
      return send(401, { error: "invalid_client", error_description: "Unauthorized" });
    }
    const bound = mockState.codes.get(body.code);
    if (!bound || bound.redirectUri !== body.redirect_uri) {
      return send(400, { error: "bad_verification_code", error_description: "unknown or mismatched code" });
    }
    // Real Google rejects a wrong/missing PKCE verifier.
    if (!body.code_verifier || sha256b64url(body.code_verifier) !== bound.challenge) {
      return send(400, { error: "invalid_grant", error_description: "code_verifier does not match challenge" });
    }
    const token = "googat-" + crypto.randomBytes(20).toString("hex");
    mockState.tokens.set(token, mockState.nextGoogleIdentity);
    return send(200, { access_token: token, refresh_token: "rt-" + crypto.randomBytes(8).toString("hex"),
      id_token: "jwt-not-parsed-by-product", expires_in: 3599, token_type: "Bearer", scope: "openid email profile" });
  }
  if (url.pathname === "/gl/userinfo") {
    const t = (req.headers.authorization || "").replace("Bearer ", "");
    mockState.userinfoCalls.push({});
    const bound = mockState.tokens.get(t);
    if (!bound) return send(401, { error: "invalid_token" });
    return send(200, bound);
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- DB bootstrap: apply ONLY the migrations this suite needs (integrator
// runs the full ordered set in production) ----
const { query, closePool } = await import("../src/database/client.js");
async function applyMigrationFile(id) {
  const sql = fs.readFileSync(path.join(PROJECT, "src/database/migrations", id), "utf8");
  await query(sql);
  await query(`INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
}
async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const users = await query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'users'`);
  if (!users.rows.length) await applyMigrationFile("001-initial.sql");
  const audit = await query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_events'`);
  if (!audit.rows.length) await applyMigrationFile("015-audit-logs.sql");
  const oa = await query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'oauth_accounts'`);
  if (!oa.rows.length) await applyMigrationFile("040-oauth.sql");
}

try {
  await query("SELECT 1");
  await ensureSchema();
} catch (e) {
  console.log("SKIP  oauth-google-only suite — PostgreSQL unreachable (" + String(e?.message || e).split("\n")[0] + ")");
  console.log("SKIP  hint: docker compose up -d postgres, then re-run");
  process.exit(0);
}

// Run the 043 exercise HERE — before startPlatform — so the platform's own
// fire-and-forget migrate() at boot cannot race the re-apply (concurrent
// migration = deadlock + spurious CHECK violations, observed and fixed).
try {
  migrationExercised = await exerciseMigration043();
} catch (e) {
  migrationError = e.message;
}

// ---- boot: IdP stand-in + platform + test-local app with the oauth router ----
await new Promise((resolve) => idp.listen(0, "127.0.0.1", resolve));
const idpPort = idp.address().port;
const idpBase = `http://127.0.0.1:${idpPort}`;

process.env.OAUTH_GOOGLE_CLIENT_ID = GOOGLE_ID;
process.env.OAUTH_GOOGLE_CLIENT_SECRET = GOOGLE_SECRET;
// Point the REAL flow code at the local IdP stand-in (same overrides a
// self-hosted OIDC deployment would use; defaults stay production).
process.env.OAUTH_GOOGLE_AUTH_URL = `${idpBase}/gl/oauth2/v2/auth`;
process.env.OAUTH_GOOGLE_TOKEN_URL = `${idpBase}/gl/token`;
process.env.OAUTH_GOOGLE_USERINFO_URL = `${idpBase}/gl/userinfo`;

const oauth = await import("../src/platform/oauth-real.js");
const { PROVIDER_DEFAULTS, RETIRED_PROVIDERS, getProviderConfig } = oauth;
const { default: express } = await import("express");

const app = express();
app.use(express.json());
app.use("/api/auth/oauth", oauth.oauthRouter());
const testServer = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const testBase = `http://127.0.0.1:${testServer.address().port}`;
process.env.OAUTH_REDIRECT_BASE = testBase;

const started = await import("../src/platform/server.js").then((m) => m.startPlatform({ port: 0 }));
const platformBase = `http://127.0.0.1:${started.server.address().port}`;
console.log(`[test] idp-standin on :${idpPort}, oauth app on :${testServer.address().port}, platform on :${platformBase}`);

const api = async (base, method, p, { body, headers } = {}) => {
  const res = await fetch(`${base}${p}`, {
    method, redirect: "manual",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers, text, location: res.headers.get("location") };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const createdUserIds = [];

// ── Migration 043 exercise (forward-only github unlink) — deterministic ──
// Un-record 043, drop the google-only CHECK it adds (that CHECK only exists
// because a previous run applied it), seed a legacy github-oauth link row,
// then re-apply the migration file and assert the unlink for real: link row
// deleted, local user row preserved, CHECK restored. Idempotent on any DB
// state, so every run exercises the actual migration body.
async function exerciseMigration043() {
  await query(`DELETE FROM _migrations WHERE id = '043-oauth-google-only.sql'`);
  await query(`ALTER TABLE oauth_accounts DROP CONSTRAINT IF EXISTS oauth_accounts_provider_google_only`);
  const legacy = await query(
    `INSERT INTO users (email, password_hash) VALUES ('oauth-e2e-gh-link-legacy@example.invalid', NULL)
     ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING id`);
  await query(
    `INSERT INTO oauth_accounts (user_id, provider, provider_account_id, provider_username, provider_email)
     VALUES ($1, 'github', 'gh-legacy-1', 'legacy-gh', 'legacy-gh@example.invalid')
     ON CONFLICT (provider, provider_account_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [legacy.rows[0].id]);
  await applyMigrationFile("043-oauth-google-only.sql");
  return "applied-fresh this run (seeded github link was unlinked, user preserved)";
}

// Full journey helper: start → follow authorize → follow callback.
async function driveFlow({ identityKey = "default", startQuery = "" } = {}) {
  if (identityKey) mockState.nextGoogleIdentity = GOOG_IDENTITIES[identityKey];
  const start = await api(testBase, "GET", `/api/auth/oauth/google/start${startQuery ? `?${startQuery}` : ""}`);
  if (start.status !== 302 || !start.location) return { start, authorize: null, callback: null };
  const authorize = await api(start.location, "GET", ""); // hits the IdP authorize endpoint
  if (authorize.status !== 302 || !authorize.location) return { start, authorize, callback: null };
  const callbackUrl = authorize.location;
  const callback = await api(callbackUrl, "GET", "");
  return { start, authorize, callback, callbackUrl, state: new URL(start.location).searchParams.get("state") };
}

try {
  // ══ 0. migration 043 exercise outcome (the exercise itself ran during
  // bootstrap, before the platform booted) ══
  check("migration 043 exercise ran clean", migrationError === null,
    migrationError || migrationExercised);

  // ══ 1. real-endpoint posture: product defaults ARE the real Google IdP,
  // and the GitHub provider is GONE from the catalog ══
  const gg = PROVIDER_DEFAULTS.google; // static catalog, not env-derived
  check("google defaults are the REAL google endpoints",
    gg.authUrl === "https://accounts.google.com/o/oauth2/v2/auth" &&
    gg.tokenUrl === "https://oauth2.googleapis.com/token" &&
    gg.userUrl === "https://openidconnect.googleapis.com/v1/userinfo",
    `${gg.authUrl} | ${gg.tokenUrl}`);
  check("provider catalog has NO github entry (google-only)",
    !PROVIDER_DEFAULTS.github && Object.keys(PROVIDER_DEFAULTS).length === 1 &&
    RETIRED_PROVIDERS.github === "043-oauth-google-only.sql",
    `catalog=${Object.keys(PROVIDER_DEFAULTS).join(",")} retired=${Object.keys(RETIRED_PROVIDERS).join(",")}`);
  check("product config resolves ONLY google (github → null config)",
    getProviderConfig("google") !== null && getProviderConfig("github") === null);

  // ══ 1. providers endpoint: google only ══
  const provs = await api(testBase, "GET", "/api/auth/oauth/providers");
  check("/providers lists ONLY google, configured:true",
    provs.status === 200 && Array.isArray(provs.json?.providers) && provs.json.providers.length === 1 &&
    provs.json.providers[0].provider === "google" && provs.json.providers[0].configured === true &&
    provs.json.providers[0].label === "Google",
    JSON.stringify(provs.json?.providers));

  // ══ 2. retired GitHub OAuth routes → 410 Gone with a doc pointer ══
  const ghStart = await api(testBase, "GET", "/api/auth/oauth/github/start");
  check("GET /github/start → 410 Gone (not 404)",
    ghStart.status === 410 && ghStart.json?.error === "github_oauth_removed",
    `status=${ghStart.status} err=${ghStart.json?.error}`);
  check("410 body carries a doc pointer + migration pointer",
    typeof ghStart.json?.doc === "string" && ghStart.json.doc.includes("oauth") &&
    ghStart.json?.migration === "043-oauth-google-only.sql",
    `doc=${ghStart.json?.doc} migration=${ghStart.json?.migration}`);
  const ghCb = await api(testBase, "GET", "/api/auth/oauth/github/callback?code=x&state=y");
  const ghBase = await api(testBase, "GET", "/api/auth/oauth/github");
  const ghPost = await api(testBase, "POST", "/api/auth/oauth/github/start");
  check("all legacy github routes (callback/base/POST) → 410",
    ghCb.status === 410 && ghBase.status === 410 && ghPost.status === 410,
    `callback=${ghCb.status} base=${ghBase.status} post=${ghPost.status}`);
  const unknownProv = await api(testBase, "GET", "/api/auth/oauth/notaprovider/start");
  check("unknown provider → 404", unknownProv.status === 404, `status=${unknownProv.status}`);

  // ══ 3. unconfigured provider → 503 naming the env vars (clean error) ══
  delete process.env.OAUTH_GOOGLE_CLIENT_ID; delete process.env.OAUTH_GOOGLE_CLIENT_SECRET;
  const unconf = await api(testBase, "GET", "/api/auth/oauth/google/start");
  check("unconfigured google → 503 with actionable env names",
    unconf.status === 503 && unconf.json?.error?.includes("OAUTH_GOOGLE_CLIENT_ID") &&
    unconf.json?.error?.includes("OAUTH_GOOGLE_CLIENT_SECRET"), `status=${unconf.status}`);
  process.env.OAUTH_GOOGLE_CLIENT_ID = GOOGLE_ID;
  process.env.OAUTH_GOOGLE_CLIENT_SECRET = GOOGLE_SECRET;

  // ══ 4. full journey: redirect → callback → token → userinfo → upsert → session ══
  // Raw sequence so the server-side state row can be checked BETWEEN /start
  // and the callback — the callback consumes (deletes) it.
  const f1start = await api(testBase, "GET", "/api/auth/oauth/google/start");
  check("GET /google/start 302s to the authorize endpoint", f1start.status === 302 &&
    f1start.location?.startsWith(`${idpBase}/gl/oauth2/v2/auth`), f1start.location?.slice(0, 90));
  if (!f1start.location) throw new Error("cannot continue: /google/start did not redirect");
  const startParams = new URL(f1start.location).searchParams;
  check("authorize request carries client_id + redirect_uri + response_type=code + openid scope",
    startParams.get("client_id") === GOOGLE_ID &&
    startParams.get("redirect_uri") === `${testBase}/api/auth/oauth/google/callback` &&
    startParams.get("response_type") === "code" &&
    (startParams.get("scope") || "").includes("openid") &&
    (startParams.get("scope") || "").includes("email") &&
    (startParams.get("scope") || "").includes("profile"),
    `scope=${startParams.get("scope")}`);
  check("authorize request carries S256 PKCE code_challenge (43 chars)",
    startParams.get("code_challenge_method") === "S256" &&
    (startParams.get("code_challenge") || "").length === 43,
    `challenge=${(startParams.get("code_challenge") || "").length}c`);
  check("authorize request carries access_type=online + prompt=select_account",
    startParams.get("access_type") === "online" && startParams.get("prompt") === "select_account");
  check("state is 64-hex random", /^[0-9a-f]{64}$/.test(startParams.get("state") || ""));
  // state row is still LIVE here — the callback has not consumed it yet
  const stateRow0 = await query(
    "SELECT provider, redirect_uri, code_verifier, expires_at > now() AS live FROM oauth_states WHERE state = $1",
    [startParams.get("state")]);
  check("state persisted server-side (provider=google) with redirect_uri + verifier + live TTL",
    stateRow0.rows.length === 1 && stateRow0.rows[0].provider === "google" &&
    stateRow0.rows[0].redirect_uri === `${testBase}/api/auth/oauth/google/callback` &&
    typeof stateRow0.rows[0].code_verifier === "string" && stateRow0.rows[0].code_verifier.length >= 43 &&
    stateRow0.rows[0].live === true,
    `rows=${stateRow0.rows.length} live=${stateRow0.rows[0]?.live}`);

  const f1authorize = await api(f1start.location, "GET", ""); // hits the IdP authorize endpoint
  check("Google authorize redirects back to our callback with code+state",
    f1authorize.status === 302 && f1authorize.location?.startsWith(`${testBase}/api/auth/oauth/google/callback?code=`) &&
    f1authorize.location.includes(`state=${startParams.get("state")}`));
  const cb1 = await api(f1authorize.location, "GET", "");
  const f1callbackUrl = f1authorize.location;
  const f1state = startParams.get("state");
  check("token exchange hit the IdP with real client credentials + code_verifier",
    mockState.tokenCalls.length >= 1 &&
    mockState.tokenCalls.at(-1).body.client_id === GOOGLE_ID &&
    mockState.tokenCalls.at(-1).body.client_secret === GOOGLE_SECRET &&
    mockState.tokenCalls.at(-1).body.grant_type === "authorization_code" &&
    mockState.tokenCalls.at(-1).body.redirect_uri === `${testBase}/api/auth/oauth/google/callback` &&
    typeof mockState.tokenCalls.at(-1).body.code_verifier === "string" &&
    mockState.tokenCalls.at(-1).body.code_verifier.length >= 43);
  check("profile fetched from the userinfo endpoint with the Bearer access token",
    mockState.userinfoCalls.length === 1);
  check("callback → 200 {ok, token, userId, email} (verified email from userinfo)",
    cb1.status === 200 && cb1.json?.ok === true && typeof cb1.json?.token === "string" &&
    cb1.json?.email === "oauth-e2e-goog@example.invalid" && cb1.json?.provider === "google",
    `status=${cb1.status} email=${cb1.json?.email} err=${cb1.json?.error}`);
  const gUser1 = cb1.json;
  if (gUser1?.userId) createdUserIds.push(gUser1.userId);

  const me1 = await api(platformBase, "GET", "/api/auth/me", { headers: { authorization: `Bearer ${gUser1?.token}` } });
  check("issued session validates on the REAL /api/auth/me route",
    me1.status === 200 && me1.json?.userId === gUser1.userId && me1.json?.email === gUser1.email, `status=${me1.status}`);
  const userRow1 = await query("SELECT email, password_hash, role, status FROM users WHERE id = $1", [gUser1.userId]);
  check("oauth-only user row created with NULL password_hash and active status",
    userRow1.rows[0]?.email === "oauth-e2e-goog@example.invalid" && userRow1.rows[0]?.password_hash === null &&
    userRow1.rows[0]?.status === "active");
  const oaRow1 = await query(
    "SELECT provider, provider_account_id, provider_username, provider_email, provider_avatar_url FROM oauth_accounts WHERE user_id = $1",
    [gUser1.userId]);
  check("oauth_accounts row stores identity only (google, sub, email, avatar)",
    oaRow1.rows[0]?.provider === "google" && oaRow1.rows[0]?.provider_account_id === "g-77001" &&
    oaRow1.rows[0]?.provider_username === "oauth-e2e-goog" && oaRow1.rows[0]?.provider_avatar_url === "http://127.0.0.1:1/goog.png");
  const oauthCols = await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'oauth_accounts'`);
  const colNames = oauthCols.rows.map((r) => r.column_name).join(",");
  check("oauth_accounts has NO token columns (no IdP tokens persisted)",
    !colNames.includes("token") && !colNames.includes("secret"), `cols=${colNames}`);
  // PKCE proof: the mock enforces verifier↔challenge equality, so reaching 200 IS the proof.
  check("PKCE verifier satisfied the S256 challenge (mock enforced; wrong verifier → 400)", cb1.status === 200);

  // ══ 5. second login, same identity → SAME user, no duplicates ══
  const f2 = await driveFlow({ identityKey: "default" });
  check("repeat Google login succeeds", f2.callback.status === 200 && f2.callback.json?.ok === true, `status=${f2.callback.status}`);
  const dupUsers = await query("SELECT count(*)::int AS n FROM users WHERE email = 'oauth-e2e-goog@example.invalid'");
  const dupOa = await query("SELECT count(*)::int AS n FROM oauth_accounts WHERE provider = 'google' AND provider_account_id = 'g-77001'");
  check("second login maps to the SAME user (no duplicate rows)",
    f2.callback.json?.userId === gUser1.userId && dupUsers.rows[0].n === 1 && dupOa.rows[0].n === 1,
    `users=${dupUsers.rows[0].n} accounts=${dupOa.rows[0].n}`);
  if (f2.callback.json?.userId) createdUserIds.push(f2.callback.json.userId);

  // ══ 6. link-by-verified-email into an existing PASSWORD account (email+password stays primary) ══
  const linkEmail = "oauth-e2e-link@example.invalid";
  const linkPw = "pw-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const reg = await api(platformBase, "POST", "/api/auth/register", { body: { email: linkEmail, password: linkPw } });
  const regLogin = await api(platformBase, "POST", "/api/auth/login", { body: { email: linkEmail, password: linkPw } });
  if (reg.json?.userId) createdUserIds.push(reg.json.userId);
  check("pre-existing password account registered + logged in (primary path baseline)",
    reg.status === 200 && !!regLogin.json?.token, `register=${reg.status}`);
  const f3 = await driveFlow({ identityKey: "link" });
  check("Google login with a verified e-mail LINKS to the existing password user",
    f3.callback.status === 200 && f3.callback.json?.userId === reg.json.userId,
    `status=${f3.callback.status} got=${f3.callback.json?.userId} want=${reg.json.userId}`);
  if (f3.callback.json?.userId && f3.callback.json.userId !== reg.json.userId) createdUserIds.push(f3.callback.json.userId);
  const pwStill = await api(platformBase, "POST", "/api/auth/login", { body: { email: linkEmail, password: linkPw } });
  check("password login still works for the linked account (email+password primary preserved)", pwStill.status === 200, `status=${pwStill.status}`);
  const linkOa = await query(
    "SELECT count(*)::int AS n FROM oauth_accounts WHERE provider = 'google' AND provider_account_id = 'g-77002' AND user_id = $1",
    [reg.json.userId]);
  check("oauth_accounts row points at the pre-existing user id", linkOa.rows[0]?.n === 1);

  // ══ 7. WRONG client credentials → clean failure, NO user/session created ══
  const wrongSecret = "goog-WRONG-" + crypto.randomBytes(8).toString("hex");
  process.env.OAUTH_GOOGLE_CLIENT_SECRET = wrongSecret;
  const f4 = await driveFlow({ identityKey: "failure" });
  process.env.OAUTH_GOOGLE_CLIENT_SECRET = GOOGLE_SECRET;
  const lastTokenCall = mockState.tokenCalls.at(-1);
  check("wrong client secret was actually sent to the token endpoint",
    f4.start.status === 302 && lastTokenCall?.body.client_secret === wrongSecret,
    `sent=${lastTokenCall?.body.client_secret === wrongSecret}`);
  check("wrong-creds callback → 502 clean error surfacing the IdP's invalid_client (no crash)",
    f4.callback.status === 502 &&
    ((f4.callback.json?.error || "").includes("invalid_client") || (f4.callback.json?.error || "").includes("Unauthorized")),
    `status=${f4.callback.status} err=${f4.callback.json?.error}`);
  const afterUsers = await query("SELECT count(*)::int AS n FROM users WHERE email = 'oauth-e2e-failure@example.invalid'");
  const afterOa = await query("SELECT count(*)::int AS n FROM oauth_accounts WHERE provider_account_id = 'g-77005'");
  check("failed exchange created NO user and NO oauth_accounts row",
    afterUsers.rows[0].n === 0 && afterOa.rows[0].n === 0,
    `users=${afterUsers.rows[0].n} accounts=${afterOa.rows[0].n}`);
  // IdP-side token error (e.g. rejected code) → same clean 502 path
  mockState.tokenError = "invalid_grant";
  const f4b = await driveFlow({ identityKey: "failure" });
  mockState.tokenError = null;
  check("IdP token error → 502 with the IdP's error surfaced",
    f4b.callback.status === 502 && ((f4b.callback.json?.error || "").includes("invalid_grant") || (f4b.callback.json?.error || "").includes("the code is bad")),
    `status=${f4b.callback.status} err=${f4b.callback.json?.error}`);

  // ══ 8. unverified e-mail NEVER links to an existing password account ══
  const unvEmail = "oauth-e2e-unverified@example.invalid";
  const unvPw = "pw-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const regU = await api(platformBase, "POST", "/api/auth/register", { body: { email: unvEmail, password: unvPw } });
  if (regU.json?.userId) createdUserIds.push(regU.json.userId);
  check("unverified-target account registered (baseline)", regU.status === 200);
  const f5 = await driveFlow({ identityKey: "unverified" });
  check("unverified e-mail login still completes (identity-keyed account)",
    f5.callback.status === 200 && f5.callback.json?.ok === true, `status=${f5.callback.status} err=${f5.callback.json?.error}`);
  check("unverified e-mail did NOT take over the password account",
    f5.callback.json?.userId !== regU.json.userId &&
    !String(f5.callback.json?.email).includes("unverified@example.invalid"),
    `oauthEmail=${f5.callback.json?.email}`);
  if (f5.callback.json?.userId) createdUserIds.push(f5.callback.json.userId);
  const unvOa = await query(
    "SELECT count(*)::int AS n FROM oauth_accounts WHERE provider_account_id = 'g-77003' AND user_id = $1",
    [regU.json.userId]);
  check("password account has no oauth link after unverified attempt", unvOa.rows[0]?.n === 0);

  // ══ 9. disabled user cannot OAuth-login ══
  const disEmail = "oauth-e2e-disabled@example.invalid";
  const regD = await api(platformBase, "POST", "/api/auth/register", { body: { email: disEmail, password: "pw-" + Math.random().toString(36).slice(2) } });
  await query("UPDATE users SET status = 'disabled' WHERE id = $1", [regD.json.userId]);
  if (regD.json?.userId) createdUserIds.push(regD.json.userId);
  const f6 = await driveFlow({ identityKey: "disabled" });
  check("disabled account → 403 account_disabled", f6.callback.status === 403 && (f6.callback.json?.error || "").includes("disabled"), `status=${f6.callback.status}`);
  const disSessions = await query("SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.id = $1", [regD.json.userId]);
  check("no session created for disabled account", disSessions.rows[0]?.n === 0, `sessions=${disSessions.rows[0]?.n}`);

  // ══ 10. state security: single-use, tamper, expiry, missing params ══
  const replay = await api(testBase, "GET", `/api/auth/oauth/google/callback?code=${new URL(f1callbackUrl).searchParams.get("code")}&state=${f1state}`);
  check("replayed callback (same code+state) → 400 invalid_state", replay.status === 400 && replay.json?.error?.includes("state"), `status=${replay.status}`);
  const stateRow1 = await query("SELECT 1 FROM oauth_states WHERE state = $1", [f1state]);
  check("consumed state row deleted (single-use)", stateRow1.rows.length === 0);
  const tampered = await api(testBase, "GET", `/api/auth/oauth/google/callback?code=x&state=${crypto.randomBytes(32).toString("hex")}`);
  check("tampered/unknown state → 400", tampered.status === 400 && tampered.json?.error?.includes("state"));
  const missing = await api(testBase, "GET", `/api/auth/oauth/google/callback`);
  check("missing code/state → 400", missing.status === 400);
  // expiry: start a flow, force the stored state into the past
  const f7 = await driveFlow({ identityKey: "default" });
  await query("UPDATE oauth_states SET expires_at = now() - interval '1 second' WHERE state = $1", [f7.state]);
  const cbCode = f7.authorize ? new URL(f7.authorize.location).searchParams.get("code") : null;
  const expired = await api(testBase, "GET", `/api/auth/oauth/google/callback?code=${cbCode}&state=${f7.state}`);
  check("expired state rejected even with a valid code", expired.status === 400 && expired.json?.error?.includes("state"), `status=${expired.status}`);
  // provider-sent error (user denied at consent screen)
  const denied = await api(testBase, "GET", `/api/auth/oauth/google/callback?error=access_denied&error_description=User+cancelled&state=${crypto.randomBytes(32).toString("hex")}`);
  check("provider error (access_denied) → 400 naming the provider error", denied.status === 400 && denied.json?.error?.includes("access_denied"), `status=${denied.status}`);

  // ══ 11. browser-mode flow: preference rides the state row (the IdP echoes
  // only redirect_uri, so /start?redirect=1 must survive the round trip) ══
  const s11 = await api(testBase, "GET", "/api/auth/oauth/google/start?redirect=1");
  const s11State = new URL(s11.location).searchParams.get("state");
  const s11Row = await query("SELECT browser_redirect FROM oauth_states WHERE state = $1", [s11State]);
  check("/start?redirect=1 persists browser_redirect=true on the state row",
    s11.status === 302 && s11Row.rows[0]?.browser_redirect === true, `status=${s11.status}`);
  const f8 = await driveFlow({ identityKey: "default", startQuery: "redirect=1" });
  const loc = f8.callback.headers?.get("location") || "";
  check("browser-mode callback (no query flag on callback URL) → 302 with #token fragment",
    f8.callback.status === 302 && loc.startsWith(testBase + "/") && loc.includes("#token=") && loc.includes("provider=google"),
    `status=${f8.callback.status} loc=${loc.slice(0, 80)}…`);
  const fragToken = new URLSearchParams(loc.split("#")[1] || "")?.get("token");
  const meFrag = await api(platformBase, "GET", "/api/auth/me", { headers: { authorization: `Bearer ${fragToken}` } });
  check("fragment token is a working platform session", meFrag.status === 200 && meFrag.json?.userId === gUser1.userId, `status=${meFrag.status}`);
  await query("DELETE FROM oauth_states WHERE state = $1", [s11State]); // probe state discarded

  // ══ 12. identity exposing NO e-mail → deterministic synthetic local account ══
  const f9 = await driveFlow({ identityKey: "noemail" });
  check("no-email Google identity still logs in", f9.callback.status === 200 && f9.callback.json?.ok === true, `status=${f9.callback.status} err=${f9.callback.json?.error}`);
  check("synthetic local e-mail is identity-keyed and deterministic",
    f9.callback.json?.email === "g-77006+user@noreply.oauth.google.local", `email=${f9.callback.json?.email}`);
  if (f9.callback.json?.userId) createdUserIds.push(f9.callback.json.userId);
  const f9again = await driveFlow({ identityKey: "noemail" });
  check("no-email identity re-login maps to the SAME user",
    f9again.callback.status === 200 && f9again.callback.json?.userId === f9.callback.json?.userId, `status=${f9again.callback.status}`);

  // ══ 13. migration 043: github links unlinked, google-only enforced ══
  const migRecorded = await query("SELECT 1 FROM _migrations WHERE id = '043-oauth-google-only.sql'");
  check("migration 043-oauth-google-only.sql is recorded as applied", migRecorded.rows.length === 1);
  const ghRows = await query("SELECT count(*)::int AS n FROM oauth_accounts WHERE provider = 'github'");
  check("ZERO github-oauth account rows remain (unlink migration ran)", ghRows.rows[0].n === 0, `githubRows=${ghRows.rows[0].n}`);
  check("migration exercise mode", migrationExercised !== "", migrationExercised);
  if (migrationExercised.startsWith("applied-fresh")) {
    // the seeded legacy user must have SURVIVED the unlink (users preserved)
    const legacy = await query("SELECT count(*)::int AS n FROM users WHERE email = $1", ["oauth-e2e-gh-link-legacy@example.invalid"]);
    check("unlink preserved the local user row (only the github LINK was removed)", legacy.rows[0].n === 1, `legacyUser=${legacy.rows[0].n}`);
    const ghCols = await query(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = 'oauth_accounts'::regclass AND conname = 'oauth_accounts_provider_google_only'`);
    check("google-only CHECK constraint exists after migration", ghCols.rows[0].n === 1);
  }
  // the google-only CHECK actually refuses github rows (constraint live test)
  let checkViolated = false;
  try {
    await query(
      `INSERT INTO oauth_accounts (user_id, provider, provider_account_id) VALUES ($1, 'github', 'nope-1')`,
      [gUser1.userId]);
    // if we got here the constraint is missing — clean the row back up
    await query(`DELETE FROM oauth_accounts WHERE provider = 'github'`);
  } catch (e) { checkViolated = String(e.code) === "23514"; }
  check("INSERT provider='github' is rejected by the google-only CHECK (23514)", checkViolated);

  // ══ 14. audit trail: oauth logins land in the real hash-chained audit log ══
  await sleep(200); // recordAuditEventSafe is fire-and-forget
  const auditRows = await query(
    `SELECT action, outcome, metadata FROM audit_events
      WHERE metadata->>'provider' = 'google' AND ts > now() - interval '5 minutes'
      ORDER BY ts DESC LIMIT 30`);
  const okEvents = auditRows.rows.filter((r) => r.action === "auth.login.success" && r.outcome === "success");
  const failEvents = auditRows.rows.filter((r) => r.action === "auth.login.failure" && r.outcome === "failure");
  check("auth.login.success events recorded for google logins", okEvents.length >= 4, `n=${okEvents.length}`);
  check("auth.login.failure events recorded for failed flows (wrong creds, token error, disabled, bad state)",
    failEvents.length >= 4, `n=${failEvents.length}`);
  const chain = await query(
    `SELECT count(*)::int AS n FROM audit_events WHERE (payload_hash IS NULL OR prev_hash IS NULL) AND ts > now() - interval '5 minutes'`);
  check("oauth audit rows are hash-chained (no null hashes)", chain.rows[0]?.n === 0);

  // ══ 15. secret hygiene: nothing sensitive in storage or logs ══
  const allUsers = await query("SELECT * FROM users WHERE email LIKE 'oauth-e2e-%' OR email LIKE '%+user@noreply.oauth.google.local%'");
  const allOa = await query("SELECT * FROM oauth_accounts WHERE provider_account_id IN ('g-77001','g-77002','g-77003','g-77004','g-77005','g-77006')");
  const serialized = JSON.stringify({ u: allUsers.rows, o: allOa.rows });
  check("client secrets never persisted in DB", ![GOOGLE_SECRET, wrongSecret].some((s) => serialized.includes(s)));
  const dbHasTokens = [...mockState.tokens.keys()].some((t) => serialized.includes(t));
  check("IdP access tokens absent from oauth/users rows", dbHasTokens === false);
  const logBlob = logLines.join("\n");
  check("client secrets never printed to stdout/stderr", ![GOOGLE_SECRET, wrongSecret].some((s) => logBlob.includes(s)));
  check("IdP access tokens never printed to stdout/stderr",
    [...mockState.tokens.keys()].every((t) => !logBlob.includes(t)));
  check("session tokens never printed to stdout/stderr",
    [gUser1?.token, f2.callback.json?.token, f3.callback.json?.token, f5.callback.json?.token, fragToken]
      .filter(Boolean).every((t) => !logBlob.includes(t)));
  // state store: no live unconsumed states left behind from OUR flows
  const strayStates = await query(
    `SELECT count(*)::int AS n FROM oauth_states
      WHERE redirect_uri LIKE $1 AND expires_at > now()`,
    [testBase + "%"]);
  check("no unconsumed live states left behind from completed flows",
    strayStates.rows[0]?.n === 0, `left=${strayStates.rows[0]?.n}`);

} catch (e) {
  results.push(false);
  console.error("[test] FATAL:", e?.stack || e);
} finally {
  // ---- cleanup (best effort): test users cascade oauth_accounts/sessions ----
  try {
    if (createdUserIds.length) {
      await query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds]);
    }
    await query("DELETE FROM oauth_states WHERE redirect_uri LIKE $1", [testBase + "%"]);
    await query("DELETE FROM users WHERE email IN ('oauth-e2e-goog@example.invalid','oauth-e2e-failure@example.invalid') OR email LIKE '%+user@noreply.oauth.google.local%' OR email = 'oauth-e2e-gh-link-legacy@example.invalid'");
  } catch (e) { console.error("[cleanup]", e.message); }
  try { started.server.close(); } catch {}
  try { testServer.close(); } catch {}
  try { idp.close(); } catch {}
  try { await closePool(); } catch {}
}

const passed = results.filter(Boolean).length;
const total = results.length;
console.log(`\n${passed === total ? "SUITE PASS" : "SUITE FAIL"}  oauth-google-only: ${passed}/${total} checks passed`);
origLog(`${passed === total ? "SUITE PASS" : "SUITE FAIL"}  oauth-google-only: ${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
