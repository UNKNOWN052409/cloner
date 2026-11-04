// Notification delivery (task 4.2.16): email + webhook, per-user preferences,
// per-event templates, rate-limited sends, append-only delivery log.
//
// Surface:
//   EVENTS / listEvents()                     — event catalog + templates
//   getPreferences(userId)                    — resolved prefs (account email joined)
//   updatePreferences(userId, patch)          — validated write (webhook URL is
//                                               SSRF-checked via src/security/url-guard.js)
//   emitEvent({ userId, event, payload, ... })— the single product entry point:
//                                               prefs → dedupe → rate limit →
//                                               template render → send per channel →
//                                               log deliveries
//   sendTestNotification(userId, event?)      — sample payload through the same path
//   listDeliveries(userId, { limit })         — user-visible delivery history
//   notificationRouter()                      — INTEGRATOR MOUNT LINE:
//                                                 app.use("/api/notifications", notificationRouter());
//                                               with `import { notificationRouter } from "./notification-delivery.js";`
//   setEmailTransport(fn) / resetEmailTransport()
//                                             — injectable transport seam for TESTS
//                                               ONLY (same posture as quota-service's
//                                               injectable meter). Product default is
//                                               the real SMTP client below, configured
//                                               from env; no mock anywhere in a product
//                                               code path.
//
// Email transport: a dependency-free RFC 5321 SMTP client (node:net/node:tls):
// EHLO → optional STARTTLS → AUTH PLAIN/LOGIN → MAIL FROM → RCPT TO → DATA
// (multipart/alternative, quoted-printable, dot-stuffing) → QUIT. Config is
// env-only (SMTP_* — see .env.example); absent config means the email channel
// is cleanly skipped with reason "email_not_configured", never a mock send.
//
// Webhook transport: real HTTPS POST (global fetch) of a JSON envelope, signed
// with the user's per-user webhook secret:
//   X-Cloner-Signature: sha256=HMAC_SHA256(secret, rawBody)
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import { Router } from "express";
import { query } from "../database/client.js";
import { checkLimit } from "./rate-limiter.js";
import { validatePublicUrl } from "../security/url-guard.js";
import { WebhookSignatureError } from "../integrations/external-api.js";
import { authRequired } from "../auth/auth-middleware.js";

// ---------- errors ----------

class BadRequestError extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}

// ---------- env-derived configuration (read per call so tests can vary env) ----------

export function emailConfig() {
  return {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || (process.env.SMTP_SECURE === "1" ? 465 : 587)),
    secure: process.env.SMTP_SECURE === "1",
    starttls: process.env.SMTP_STARTTLS !== "0",      // default: upgrade when advertised
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || "",
    fromName: process.env.SMTP_FROM_NAME || "Cloner",
    ehloName: process.env.SMTP_EHLO_NAME || (os.hostname().split(".")[0] || "cloner"),
    timeoutMs: Number(process.env.SMTP_TIMEOUT_MS || 15000),
    tlsRejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "0",
  };
}

export function rateLimits() {
  return {
    perMinute: Number(process.env.NOTIF_MAX_PER_MINUTE || 10),
    perHour: Number(process.env.NOTIF_MAX_PER_HOUR || 50),
  };
}

// Injectable transport seam (TESTS ONLY — set from test files; never set by
// product code). When unset, the real SMTP client is used against env config.
let injectedEmailTransport = null;
export function setEmailTransport(fn) { injectedEmailTransport = fn; }
export function resetEmailTransport() { injectedEmailTransport = null; }

// Email channel is usable when a test transport is injected, or env has a host
// + from address. Without either, email outcomes are "skipped: email_not_configured".
function emailChannelReady(cfg = emailConfig()) {
  return !!injectedEmailTransport || (!!cfg.host && !!cfg.from);
}

// ---------- header / address hygiene (RFC 5322 header injection) ----------

// Strip CR/LF and other control chars — a payload value interpolated into a
// header must never be able to start a new header line (Bcc smuggling etc.).
function sanitizeHeader(value) {
  return String(value ?? "").replace(/[\r\n\x00-\x1f\x7f]+/g, " ").trim();
}

function isValidAddress(addr) {
  return /^[^\s@<>,;:"'\\]+@[^\s@<>,;:"'\\]+$/.test(addr);
}

// ---------- event catalog + templates ----------
// Templates use {{path}} placeholders (dot-path into the event payload).
// The HTML variant is escaped; the text variant is not. Missing placeholders
// render as "" and are reported back in the delivery detail.

export const EVENTS = {
  "task.completed": {
    description: "A clone task finished successfully",
    subject: "Clone completed: {{sourceUrl}}",
    text: "Your clone of {{sourceUrl}} completed successfully.\n\nTask: {{taskId}}\nDuration: {{durationSeconds}}s\nArtifacts captured: {{artifactCount}}\n\nOpen the task dashboard to view or export the clone.",
    html: "<p>Your clone of <strong>{{sourceUrl}}</strong> completed successfully.</p><ul><li>Task: <code>{{taskId}}</code></li><li>Duration: {{durationSeconds}}s</li><li>Artifacts captured: {{artifactCount}}</li></ul><p>Open the task dashboard to view or export the clone.</p>",
    sample: { taskId: "00000000-0000-0000-0000-000000000000", sourceUrl: "https://example.com", durationSeconds: 42, artifactCount: 3 },
  },
  "task.failed": {
    description: "A clone task failed",
    subject: "Clone failed: {{sourceUrl}}",
    text: "Your clone of {{sourceUrl}} failed.\n\nTask: {{taskId}}\nError: {{error}}\n\nYou can retry the task from the dashboard.",
    html: "<p>Your clone of <strong>{{sourceUrl}}</strong> failed.</p><ul><li>Task: <code>{{taskId}}</code></li><li>Error: <code>{{error}}</code></li></ul><p>You can retry the task from the dashboard.</p>",
    sample: { taskId: "00000000-0000-0000-0000-000000000000", sourceUrl: "https://example.com", error: "render timeout after 120s" },
  },
  "quota.limit_reached": {
    description: "A resource quota limit was hit",
    subject: "Quota limit reached: {{limitKey}}",
    text: "A quota limit was reached on your {{scope}} scope.\n\nLimit: {{limitKey}}\nValue: {{limit}}\nUsage: {{used}}\n\nRunning jobs may be queued until the window resets.",
    html: "<p>A quota limit was reached on your {{scope}} scope.</p><ul><li>Limit: <code>{{limitKey}}</code></li><li>Value: {{limit}}</li><li>Usage: {{used}}</li></ul><p>Running jobs may be queued until the window resets.</p>",
    sample: { limitKey: "max_jobs_per_day", scope: "user", limit: 50, used: 50 },
  },
  "org.member_added": {
    description: "A member was added to one of your organizations",
    subject: "{{memberEmail}} joined {{orgName}}",
    text: "{{memberEmail}} was added to organization {{orgName}} with role {{role}}.",
    html: "<p>{{memberEmail}} was added to organization <strong>{{orgName}}</strong> with role <strong>{{role}}</strong>.</p>",
    sample: { orgName: "Acme", memberEmail: "dev@example.com", role: "member" },
  },
  "org.member_removed": {
    description: "A member was removed from one of your organizations",
    subject: "{{memberEmail}} left {{orgName}}",
    text: "{{memberEmail}} was removed from organization {{orgName}}.",
    html: "<p>{{memberEmail}} was removed from organization <strong>{{orgName}}</strong>.</p>",
    sample: { orgName: "Acme", memberEmail: "dev@example.com" },
  },
  "api_key.created": {
    description: "A new API key was created on your account",
    subject: "New API key created: {{name}}",
    text: "A new API key \"{{name}}\" was created for your account.\n\nScopes: {{scopes}}\n\nIf this wasn't you, revoke it immediately in the dashboard.",
    html: "<p>A new API key &quot;{{name}}&quot; was created for your account.</p><p>Scopes: <code>{{scopes}}</code></p><p>If this wasn't you, revoke it immediately in the dashboard.</p>",
    sample: { name: "ci-key", scopes: "read:task, export:task" },
  },
  "export.ready": {
    description: "A task export is ready for download",
    subject: "Export ready: task {{taskId}}",
    text: "Your export of task {{taskId}} is ready.\n\nFormat: {{format}}\nSize: {{sizeBytes}} bytes\n\nDownload it from the task dashboard (links are single-use).",
    html: "<p>Your export of task <code>{{taskId}}</code> is ready.</p><ul><li>Format: {{format}}</li><li>Size: {{sizeBytes}} bytes</li></ul><p>Download it from the task dashboard (links are single-use).</p>",
    sample: { taskId: "00000000-0000-0000-0000-000000000000", format: "zip", sizeBytes: 1048576 },
  },
};

export const EVENT_IDS = Object.keys(EVENTS);

export function listEvents() {
  return EVENT_IDS.map((id) => ({ id, description: EVENTS[id].description }));
}

// ---------- template rendering ----------

function lookupPath(payload, path) {
  let cur = payload;
  for (const seg of String(path).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Render `{{path}}` placeholders. Returns { text, missing[] }.
function renderTemplate(tpl, payload, { escape = false } = {}) {
  const missing = new Set();
  const text = String(tpl).replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path) => {
    const v = lookupPath(payload, path);
    if (v === undefined || v === null) { missing.add(path); return ""; }
    return escape ? escapeHtml(v) : String(v);
  });
  return { text, missing: [...missing] };
}

// ---------- per-user preferences ----------

function cleanOverrides(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestError("event_overrides must be an object");
  const out = {};
  for (const [event, channels] of Object.entries(raw)) {
    if (!EVENTS[event]) throw new BadRequestError(`unknown event in event_overrides: ${event}`);
    if (typeof channels !== "object" || channels === null || Array.isArray(channels)) {
      throw new BadRequestError(`event_overrides.${event} must be an object like {"email": true, "webhook": false}`);
    }
    const entry = {};
    for (const ch of Object.keys(channels)) {
      if (ch !== "email" && ch !== "webhook") throw new BadRequestError(`event_overrides.${event}: unknown channel ${ch}`);
      if (typeof channels[ch] !== "boolean") throw new BadRequestError(`event_overrides.${event}.${ch} must be a boolean`);
      entry[ch] = channels[ch];
    }
    if (Object.keys(entry).length) out[event] = entry;
  }
  return out;
}

// Validate + normalize a webhook URL. Reuses the codebase SSRF guard so a
// webhook cannot point at loopback / RFC1918 / cloud metadata unless the
// deployment opted in (CLONER_ALLOW_PRIVATE_TARGETS=1).
async function validateWebhookUrl(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const check = await validatePublicUrl(String(raw));
  if (!check.ok) throw new BadRequestError(`webhook_url rejected: ${check.error}`);
  return check.url;
}

// Internal read with the RAW secret — the emission path needs it to sign.
// Never exposed through the HTTP API (getPreferences masks it below).
async function getRawPreferences(userId) {
  if (!userId) throw new Error("getRawPreferences: userId required");
  const account = await query("SELECT email FROM users WHERE id = $1", [userId]);
  if (!account.rows.length) throw new Error("user not found");
  const prefsResult = await query("SELECT * FROM notification_preferences WHERE user_id = $1", [userId]);
  return { account: account.rows[0], p: prefsResult.rows[0] || null };
}

// Public shape (hunt G5.3 fix): the per-user webhook SECRET is no longer
// echoed back on every read — GET /preferences leaked it on every poll to
// anything that could read the response (XSS, proxies, logs). Callers see
// only webhook_secret_set; a (re)generation returns the secret EXACTLY ONCE
// from updatePreferences, GitHub-style.
export async function getPreferences(userId) {
  const { account, p } = await getRawPreferences(userId);
  const emailAddress = p?.email_address || account.email;
  return {
    user_id: userId,
    account_email: account.email,
    email_enabled: p ? p.email_enabled : true,
    email_address: emailAddress,
    email_address_override: p ? p.email_address : null,
    webhook_url: p ? p.webhook_url : null,
    webhook_secret: null, // never echoed — reveal-once at (re)generation only
    webhook_secret_set: !!(p && p.webhook_secret),
    event_overrides: p ? (p.event_overrides || {}) : {},
  };
}

export async function updatePreferences(userId, patch = {}) {
  if (!userId) throw new Error("updatePreferences: userId required");
  const { account, p: rawCurrent } = await getRawPreferences(userId); // validates the user exists
  const current = {
    email_enabled: rawCurrent ? rawCurrent.email_enabled : true,
    email_address_override: rawCurrent ? rawCurrent.email_address : null,
    webhook_url: rawCurrent ? rawCurrent.webhook_url : null,
    webhook_secret: rawCurrent ? rawCurrent.webhook_secret : null,
    event_overrides: rawCurrent ? (rawCurrent.event_overrides || {}) : {},
  };
  const next = {
    email_enabled: patch.email_enabled === undefined ? current.email_enabled : !!patch.email_enabled,
    email_address: patch.email_address === undefined
      ? current.email_address_override
      : (patch.email_address === null || patch.email_address === "" ? null : String(patch.email_address)),
    webhook_url: patch.webhook_url === undefined
      ? current.webhook_url
      : await validateWebhookUrl(patch.webhook_url),
    event_overrides: patch.event_overrides === undefined
      ? current.event_overrides
      : cleanOverrides(patch.event_overrides),
  };
  if (next.email_address !== null && !isValidAddress(next.email_address)) {
    throw new BadRequestError("email_address is not a valid address");
  }
  // Regenerate a secret whenever a new webhook URL is configured, so a leaked
  // URL from an old endpoint cannot forge signatures on the new one — or when
  // the caller explicitly rotates (rotate_webhook_secret: true).
  const rotating = patch.rotate_webhook_secret === true;
  const needSecret = rotating || (!!next.webhook_url && (!current.webhook_secret || current.webhook_url !== next.webhook_url));
  const secret = needSecret ? "whs_" + crypto.randomBytes(24).toString("hex") : current.webhook_secret;
  await query(
    `INSERT INTO notification_preferences
       (user_id, email_enabled, email_address, webhook_url, webhook_secret, event_overrides)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       email_enabled = EXCLUDED.email_enabled,
       email_address = EXCLUDED.email_address,
       webhook_url = EXCLUDED.webhook_url,
       webhook_secret = EXCLUDED.webhook_secret,
       event_overrides = EXCLUDED.event_overrides,
       updated_at = now()`,
    [userId, next.email_enabled, next.email_address, next.webhook_url, secret, JSON.stringify(next.event_overrides)]
  );
  // Reveal-once (hunt G5.3): the raw secret is returned HERE only, and only
  // when it was (re)generated on this call. Every later read sees the masked
  // shape from getPreferences (webhook_secret_set: true).
  const masked = await getPreferences(userId);
  if (needSecret && secret) masked.webhook_secret_once = secret;
  return masked;
}

// ---------- real SMTP client (product transport; no dependencies) ----------

function qpTokens(raw) {
  // One token per output "unit": a literal char or an =XX escape.
  const tokens = [];
  for (const b of Buffer.from(String(raw), "utf8")) {
    if (b === 0x3d) tokens.push("=3D");                                        // '='
    else if (b === 0x09 || b === 0x20) tokens.push(String.fromCharCode(b));    // tab/space (trailing fixed below)
    else if (b >= 0x21 && b <= 0x7e) tokens.push(String.fromCharCode(b));
    else tokens.push("=" + b.toString(16).toUpperCase().padStart(2, "0"));
  }
  return tokens;
}

// RFC 2045 quoted-printable: encode non-printables, wrap at 75 chars with soft
// breaks, never splitting an =XX token, never emitting a bare trailing space.
function qpEncode(text) {
  const norm = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const outLines = [];
  for (const rawLine of norm.split("\n")) {
    const tokens = qpTokens(rawLine);
    // encode a trailing space/tab (QP rule: trailing WSP must be encoded)
    if (tokens.length && (tokens[tokens.length - 1] === " " || tokens[tokens.length - 1] === "\t")) {
      tokens[tokens.length - 1] = "=" + Buffer.from(tokens.pop(), "utf8")[0].toString(16).toUpperCase().padStart(2, "0");
    }
    let line = "";
    const lines = [];
    for (const t of tokens) {
      if (line.length + t.length > 75) { lines.push(line + "="); line = ""; }
      line += t;
    }
    lines.push(line);
    outLines.push(...lines);
  }
  return outLines.join("\r\n");
}

// Build the RFC 5322 message (headers + multipart/alternative body).
function buildMime({ from, fromName, to, subject, text, html }) {
  const boundary = "cloner-" + crypto.randomBytes(12).toString("hex");
  const domain = from.split("@")[1] || "cloner.local";
  const headers = [
    `From: ${fromName ? `${sanitizeHeader(fromName)} <${from}>` : from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${sanitizeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (ct, body) =>
    `--${boundary}\r\nContent-Type: ${ct}; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qpEncode(body)}`;
  const body = `${part("text/plain", text)}\r\n${part("text/html", html)}\r\n--${boundary}--`;
  return headers.join("\r\n") + "\r\n\r\n" + body;
}

// Dot-stuffing per RFC 5321 §4.5.2: every line starting with "." gains one ".".
function dotStuff(message) {
  return message.split("\r\n").map((l) => (l.startsWith(".") ? "." + l : l)).join("\r\n");
}

class SmtpError extends Error {
  constructor(msg, code, lines) { super(msg); this.code = code; this.lines = lines; }
}

function connectSocket(cfg) {
  return new Promise((resolve, reject) => {
    const opts = { host: cfg.host, port: cfg.port };
    const onFirstError = (e) => { socket?.destroy(); reject(new SmtpError(`SMTP connect failed (${e.message})`, null)); };
    let socket;
    const ready = () => {
      socket.setTimeout(cfg.timeoutMs);
      socket.removeListener("error", onFirstError);
      resolve(socket);
    };
    socket = cfg.secure
      ? tls.connect({ ...opts, servername: cfg.host, rejectUnauthorized: cfg.tlsRejectUnauthorized }, ready)
      : net.connect(opts, ready);
    socket.once("error", onFirstError);
  });
}

// Read one SMTP reply: 1..n CRLF lines, terminated by "NNN " (or bare "NNN").
function readReply(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const lines = [];
    const detach = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      socket.removeListener("close", onClose);
    };
    const finish = (fn) => { detach(); fn(); };
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        lines.push(line);
        if (/^\d{3}([ ]|$)/.test(line)) { finish(() => resolve(lines)); return; }
      }
    };
    const onError = (e) => finish(() => reject(new SmtpError(`SMTP connection error (${e.message})`, null)));
    const onTimeout = () => { socket.destroy(); finish(() => reject(new SmtpError(`SMTP timeout after ${timeoutMs}ms`, null))); };
    const onClose = () => finish(() => reject(new SmtpError(`SMTP connection closed unexpectedly`, null)));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.once("close", onClose);
  });
}

async function command(socket, cfg, line, expected) {
  if (line !== null) socket.write(line + "\r\n");
  const reply = await readReply(socket, cfg.timeoutMs);
  const code = parseInt(reply[0], 10);
  if (!expected.includes(code)) {
    throw new SmtpError(`SMTP ${code} unexpected for "${line ? line.split("\r\n")[0].slice(0, 40) : "reply"}": ${reply.join(" / ")}`, code, reply);
  }
  return { code, lines: reply };
}

function parseFeatures(ehloLines) {
  const set = new Set();
  for (const line of ehloLines.slice(1)) set.add(line.split(/[\s=]/)[0].toUpperCase());
  return set;
}

async function authSession(socket, cfg) {
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  try {
    await command(socket, cfg, `AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass}`)}`, [235]);
  } catch (e) {
    // Mechanism not supported (5xx other than bad-credentials) → try AUTH LOGIN.
    if (e instanceof SmtpError && e.code >= 500 && e.code !== 535) {
      await command(socket, cfg, "AUTH LOGIN", [334]);
      await command(socket, cfg, b64(cfg.user), [334]);
      await command(socket, cfg, b64(cfg.pass), [235]);
    } else { throw e; }
  }
}

// One SMTP transaction. `data` is the full message (headers + body); it must
// already be dot-stuffed by the caller.
async function smtpDeliver(cfg, { from, recipients, data }) {
  let socket = await connectSocket(cfg);
  try {
    await command(socket, cfg, null, [220]);                                  // greeting
    let ehlo = await command(socket, cfg, `EHLO ${cfg.ehloName}`, [250]);
    const features = parseFeatures(ehlo.lines);
    if (!cfg.secure && cfg.starttls && features.has("STARTTLS")) {
      await command(socket, cfg, "STARTTLS", [220]);
      socket = await new Promise((resolve, reject) => {
        const tlsSock = tls.connect({ socket, servername: cfg.host, rejectUnauthorized: cfg.tlsRejectUnauthorized }, () => resolve(tlsSock));
        tlsSock.once("error", reject);
      });
      socket.setTimeout(cfg.timeoutMs);
      ehlo = await command(socket, cfg, `EHLO ${cfg.ehloName}`, [250]);        // capabilities change after TLS
    }
    if (cfg.user) await authSession(socket, cfg);
    await command(socket, cfg, `MAIL FROM:<${from}>`, [250]);
    for (const rcpt of recipients) await command(socket, cfg, `RCPT TO:<${rcpt}>`, [250, 251]);
    await command(socket, cfg, "DATA", [354]);
    socket.write(data + "\r\n.\r\n");
    await readReply(socket, cfg.timeoutMs).then((reply) => {
      const code = parseInt(reply[0], 10);
      if (code !== 250) throw new SmtpError(`SMTP ${code} unexpected for message accept: ${reply.join(" / ")}`, code, reply);
    });
    await command(socket, cfg, "QUIT", [221]);
  } finally {
    socket.destroy();
  }
}

// Send one email. Used by emitEvent; the injected test transport (if any)
// replaces the real SMTP path entirely (never set in product code).
async function sendEmail(cfg, { to, subject, text, html }) {
  if (injectedEmailTransport) {
    return injectedEmailTransport({ to, subject, text, html });
  }
  if (!cfg.host || !cfg.from) {
    throw new Error("email not configured: set SMTP_HOST and SMTP_FROM (see .env.example)");
  }
  const recipients = (Array.isArray(to) ? to : [to]).map((a) => {
    const clean = sanitizeHeader(a);
    if (!isValidAddress(clean)) throw new BadRequestError(`invalid recipient address: ${clean}`);
    return clean;
  });
  const from = sanitizeHeader(cfg.from);
  if (!isValidAddress(from)) throw new Error(`SMTP_FROM is not a valid address: ${from}`);
  const message = dotStuff(buildMime({
    from, fromName: cfg.fromName, to: recipients,
    subject: sanitizeHeader(subject), text: String(text), html: String(html),
  }));
  await smtpDeliver(cfg, { from, recipients, data: message });
}

// ---------- webhook transport (real fetch; signed, replay-safe) ----------

// hunt G5.3 fix — the old scheme signed the raw body ALONE
// (sha256=HMAC(secret, body)): no timestamp, no delivery id, so a captured
// delivery could be replayed at the receiver indefinitely with no way to
// detect it. Stripe-style scheme instead: the signed string covers a
// timestamp AND a unique delivery id, both riding along as headers:
//   signed string = "v1." + ts(seconds) + "." + deliveryId + "." + rawBody
//   x-cloner-signature: v1=<hex hmac-sha256(signedString, secret)>
//   x-cloner-timestamp: <unix seconds>     x-cloner-delivery: <uuid>
// A receiver using verifyUserWebhook() rejects replays (nonce store) and
// stale-but-re-signed captures (tolerance window) with a constant-time compare.
export function signUserWebhook({ secret, rawBody, timestamp, deliveryId }) {
  if (!secret || !rawBody) throw new Error("signUserWebhook: secret and rawBody required");
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const id = deliveryId ?? crypto.randomUUID();
  const sig = crypto.createHmac("sha256", String(secret)).update(`v1.${ts}.${id}.${rawBody}`).digest("hex");
  return {
    deliveryId: id,
    timestamp: ts,
    headers: {
      "x-cloner-signature": `v1=${sig}`,
      "x-cloner-timestamp": String(ts),
      "x-cloner-delivery": id,
    },
  };
}

// Receiver-side verification of the scheme above. Throws WebhookSignatureError
// on any mismatch; the deliveryId is marked in the nonce store only AFTER the
// signature verifies — an attacker who cannot sign cannot pre-burn a nonce to
// DoS a future legitimate delivery.
export function verifyUserWebhook({ rawBody, secret, headers, toleranceMs = 5 * 60 * 1000, seenStore = null }) {
  const h = headers || {};
  const sig = String(h["x-cloner-signature"] || "");
  const m = /^v1=([0-9a-f]{64})$/i.exec(sig);
  if (!m) throw new WebhookSignatureError("missing or malformed x-cloner-signature (expected v1=<hex>)", "BAD_SIGNATURE");
  const ts = String(h["x-cloner-timestamp"] || "");
  if (!/^\d+$/.test(ts)) throw new WebhookSignatureError("missing x-cloner-timestamp", "BAD_TIMESTAMP");
  const id = String(h["x-cloner-delivery"] || "");
  if (!id) throw new WebhookSignatureError("missing x-cloner-delivery", "BAD_DELIVERY_ID");
  const skew = Math.abs(Date.now() - Number(ts) * 1000);
  if (skew > toleranceMs) throw new WebhookSignatureError(`timestamp outside tolerance window (${Math.round(skew / 1000)}s, allowed ${Math.round(toleranceMs / 1000)}s)`, "TIMESTAMP_EXPIRED");
  const expected = crypto.createHmac("sha256", String(secret)).update(`v1.${ts}.${id}.${rawBody}`).digest("hex");
  const ab = Buffer.from(m[1], "utf8");
  const bb = Buffer.from(expected, "utf8");
  if (ab.length !== bb.length || !crypto.timingSafeEqual(ab, bb)) throw new WebhookSignatureError("signature mismatch", "BAD_SIGNATURE");
  if (seenStore) {
    if (seenStore.has(id)) throw new WebhookSignatureError(`delivery ${id} already processed (replay)`, "REPLAY");
    seenStore.mark(id);
  }
  return { ok: true, deliveryId: id, timestamp: Number(ts) };
}

async function postWebhook({ url, secret, event, payload, correlationId }) {
  // Re-check SSRF posture at send time (a URL validated at set time could be
  // pointed elsewhere by DNS changes before the next send).
  const check = await validatePublicUrl(url);
  if (!check.ok) throw new Error(`webhook_url rejected: ${check.error}`);
  const rawBody = JSON.stringify({
    event,
    occurred_at: new Date().toISOString(),
    correlation_id: correlationId ?? null,
    payload,
  });
  const signed = signUserWebhook({ secret, rawBody });
  const res = await fetch(check.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "cloner-notifications/1",
      "x-cloner-event": event,
      ...signed.headers,
    },
    body: rawBody,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`webhook endpoint returned HTTP ${res.status}`);
}

// ---------- delivery log ----------

async function logDelivery({ userId, event, channel, status, recipient, subject, detail, correlationId, dedupeKey }) {
  await query(
    `INSERT INTO notification_deliveries
       (user_id, event, channel, status, recipient, subject, detail, correlation_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [userId, event, channel, status, recipient ?? null, subject ?? null, JSON.stringify(detail || {}), correlationId ?? null, dedupeKey ?? null]
  );
}

export async function listDeliveries(userId, { limit = 50, event = null } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));
  const r = event
    ? await query(
        "SELECT id, event, channel, status, recipient, subject, detail, correlation_id, dedupe_key, created_at FROM notification_deliveries WHERE user_id = $1 AND event = $2 ORDER BY id DESC LIMIT $3",
        [userId, String(event), lim]
      )
    : await query(
        "SELECT id, event, channel, status, recipient, subject, detail, correlation_id, dedupe_key, created_at FROM notification_deliveries WHERE user_id = $1 ORDER BY id DESC LIMIT $2",
        [userId, lim]
      );
  return r.rows;
}

// ---------- emission pipeline ----------

// Emit one notification event for one user:
//   1. resolve prefs + account email
//   2. dedupe (retry-safe: dedupeKey already sent → skip, no log noise)
//   3. decide channels (global toggle + per-event override)
//   4. rate limit per user (only when a channel would actually fire)
//   5. render template, send per channel, log every attempted delivery
// Returns { event, email: {status, ...}, webhook: {status, ...} }.
export async function emitEvent({ userId, event, payload = {}, correlationId = null, dedupeKey = null }) {
  if (!EVENTS[event]) throw new BadRequestError(`unknown notification event: ${event}`);
  const prefs = await getPreferences(userId);
  // the raw secret is needed to sign — read it through the internal accessor
  // (getPreferences masks it; only the emission path may see the raw value)
  const rawSecret = (await getRawPreferences(userId)).p?.webhook_secret || null;
  const tpl = EVENTS[event];

  if (dedupeKey) {
    const seen = await query(
      "SELECT 1 FROM notification_deliveries WHERE user_id = $1 AND event = $2 AND dedupe_key = $3 AND status = 'sent' LIMIT 1",
      [userId, event, String(dedupeKey)]
    );
    if (seen.rows.length) {
      return { event, deduped: true, email: { status: "skipped", reason: "duplicate" }, webhook: { status: "skipped", reason: "duplicate" } };
    }
  }

  const ov = prefs.event_overrides[event] || {};
  const emailEnabled = ov.email !== undefined ? !!ov.email : prefs.email_enabled;
  const webhookEnabled = ov.webhook !== undefined ? !!ov.webhook : !!prefs.webhook_url;
  const cfg = emailConfig();
  const emailConfigured = emailChannelReady(cfg);
  const emailActive = emailEnabled && emailConfigured;
  const webhookActive = webhookEnabled && !!prefs.webhook_url && !!rawSecret;
  const webhookUrl = prefs.webhook_url;

  // Why a channel did not fire (used both in the return value and in logs).
  const skip = {
    email: !emailEnabled ? { status: "skipped", reason: "muted_by_preferences" }
      : !emailConfigured ? { status: "skipped", reason: "email_not_configured" }
      : { status: "skipped", reason: "not_configured" },
    webhook: !webhookEnabled ? { status: "skipped", reason: "muted_by_preferences" }
      : !prefs.webhook_url ? { status: "skipped", reason: "not_configured" }
      : { status: "skipped", reason: "not_configured" },
  };

  if (!emailActive && !webhookActive) {
    return { event, email: skip.email, webhook: skip.webhook };
  }

  // Rate limit: one budget per user across both channels (a send is a send).
  const lim = rateLimits();
  const limit = await checkLimit(`notif:${userId}`, { perMinute: lim.perMinute, perHour: lim.perHour });
  if (!limit.allowed) {
    const rl = { status: "rate_limited", reason: `rate limit exceeded (${limit.window})`, resetAt: limit.resetAt };
    if (emailActive) await logDelivery({ userId, event, channel: "email", status: "rate_limited", recipient: prefs.email_address, subject: null, detail: rl, correlationId, dedupeKey });
    if (webhookActive) await logDelivery({ userId, event, channel: "webhook", status: "rate_limited", recipient: webhookUrl, subject: null, detail: rl, correlationId, dedupeKey });
    return { event, email: emailActive ? rl : skip.email, webhook: webhookActive ? rl : skip.webhook };
  }

  const renderedSubject = renderTemplate(tpl.subject, payload);
  const renderedText = renderTemplate(tpl.text, payload);
  const renderedHtml = renderTemplate(tpl.html, payload, { escape: true });
  const missingPlaceholders = [...new Set([...renderedSubject.missing, ...renderedText.missing, ...renderedHtml.missing])];
  // Sanitize ONCE here so every consumer (transport seam, delivery log, SMTP
  // wire) sees a header-safe subject; buildMime re-sanitizes as defense in depth.
  const subject = sanitizeHeader(renderedSubject.text);

  let emailResult = skip.email;
  if (emailActive) {
    try {
      await sendEmail(cfg, { to: prefs.email_address, subject, text: renderedText.text, html: renderedHtml.text });
      emailResult = { status: "sent", recipient: prefs.email_address };
    } catch (e) {
      emailResult = { status: "failed", recipient: prefs.email_address, error: String(e.message || e).slice(0, 500) };
    }
    await logDelivery({ userId, event, channel: "email", status: emailResult.status, recipient: prefs.email_address, subject, detail: { ...emailResult, missing_placeholders: missingPlaceholders }, correlationId, dedupeKey });
  }

  let webhookResult = skip.webhook;
  if (webhookActive) {
    try {
      await postWebhook({ url: webhookUrl, secret: rawSecret, event, payload, correlationId });
      webhookResult = { status: "sent", recipient: webhookUrl };
    } catch (e) {
      webhookResult = { status: "failed", recipient: webhookUrl, error: String(e.message || e).slice(0, 500) };
    }
    await logDelivery({ userId, event, channel: "webhook", status: webhookResult.status, recipient: webhookUrl, subject, detail: webhookResult, correlationId, dedupeKey });
  }

  return { event, email: emailResult, webhook: webhookResult, missing_placeholders: missingPlaceholders };
}

// Send a sample notification through the exact production path (prefs, rate
// limit, templates) — exposed to the user via POST /api/notifications/test.
export async function sendTestNotification(userId, eventId = "task.completed") {
  if (!EVENTS[eventId]) throw new BadRequestError(`unknown notification event: ${eventId}`);
  return emitEvent({
    userId,
    event: eventId,
    payload: { ...EVENTS[eventId].sample },
    correlationId: null, // sample sends are never deduped
  });
}

// ---------- HTTP router ----------
// INTEGRATOR MOUNT LINE:
//   app.use("/api/notifications", notificationRouter());
// Session-authenticated: every row/route is scoped to req.userId.

export function notificationRouter() {
  const r = Router();

  r.get("/events", authRequired, (req, res) => {
    res.json({ events: listEvents() });
  });

  r.get("/preferences", authRequired, async (req, res) => {
    try { res.json({ preferences: await getPreferences(req.userId) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.put("/preferences", authRequired, async (req, res) => {
    try {
      const preferences = await updatePreferences(req.userId, req.body || {});
      res.json({ preferences });
    } catch (e) {
      res.status(e.status === 400 ? 400 : 500).json({ error: e.message });
    }
  });

  r.get("/deliveries", authRequired, async (req, res) => {
    try {
      res.json({ deliveries: await listDeliveries(req.userId, { limit: req.query.limit, event: req.query.event }) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.post("/test", authRequired, async (req, res) => {
    try {
      const outcomes = await sendTestNotification(req.userId, (req.body || {}).event);
      res.json({ outcomes });
    } catch (e) {
      res.status(e.status === 400 ? 400 : 500).json({ error: e.message });
    }
  });

  return r;
}
