#!/usr/bin/env node
// Notification delivery e2e (task 4.2.16).
// Boots the platform on an EPHEMERAL port against the compose PostgreSQL for
// the real auth flows, mounts the notifications router on a test-local Express
// app (same process, same DB) because src/platform/server.js is integrator-owned,
// and exercises the FULL delivery pipeline through live HTTP:
//   • per-user preferences: defaults, validation, webhook URL SSRF posture,
//     per-event channel overrides (respected on every send)
//   • templates: per-event subject/text/html rendering, HTML escaping of
//     payload values, missing-placeholder reporting
//   • rate-limited sends: NOTIF_MAX_PER_MINUTE budget → 'rate_limited' logged
//   • retry-safe dedupe via dedupeKey
//   • REAL product SMTP transport (dependency-free RFC 5321 client) driven
//     against a simulated remote SMTP server: EHLO/AUTH PLAIN/MAIL FROM/
//     RCPT TO/DATA transcript, quoted-printable, dot-stuffing, header-injection
//     sanitization, RCPT rejection → failed delivery with webhook unaffected
//   • webhook channel: real fetch to a local HTTP simulator (the remote-end
//     stand-in), HMAC-SHA256 X-Cloner-Signature verified against the raw body
// Mocks appear ONLY as (a) the injected email transport (the documented test
// seam, setEmailTransport) and (b) local remote-end simulators — never inside
// a product code path.
// Prints PASS/FAIL lines, exits nonzero on any failure, closes everything.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // platform-data etc. are cwd-relative
// small budget so the rate-limit test is short and deterministic; webhook
// simulator runs on loopback → allow private targets for THIS test process
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1";
process.env.NOTIF_MAX_PER_MINUTE = "50"; // generous headroom; phase E tightens it
process.env.NOTIF_MAX_PER_HOUR = "100";
// never let a developer's real .env SMTP settings hijack the pipeline tests
delete process.env.SMTP_HOST;
delete process.env.SMTP_PORT;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.SMTP_FROM;

const { query, closePool } = await import("../src/database/client.js");
const { startPlatform } = await import("../src/platform/server.js");
const { default: express } = await import("express");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(base, method, p, { body, headers } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// ---- apply ONLY our own migrations (integrator runs the full ordered set) ----
async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const users = await query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'users'`);
  if (!users.rows.length) {
    const sql = fs.readFileSync(path.join(PROJECT, "src/database/migrations/001-initial.sql"), "utf8");
    await query(sql);
    await query(`INSERT INTO _migrations (id) VALUES ('001-initial.sql') ON CONFLICT DO NOTHING`);
  }
  const mine = await query(`SELECT 1 FROM _migrations WHERE id = '017-notification-delivery.sql'`);
  if (!mine.rows.length) {
    const sql = fs.readFileSync(path.join(PROJECT, "src/database/migrations/017-notification-delivery.sql"), "utf8");
    await query(sql);
    await query(`INSERT INTO _migrations (id) VALUES ('017-notification-delivery.sql') ON CONFLICT DO NOTHING`);
  }
}

// ---- postgres reachability (SKIP posture per repo rule 3) ----
try {
  await query("SELECT 1");
  await ensureSchema();
} catch (e) {
  console.log("SKIP  notification-delivery suite — PostgreSQL unreachable (" + String(e?.message || e).split("\n")[0] + ")");
  console.log("SKIP  hint: docker compose up -d postgres, then re-run");
  process.exit(0);
}

// ---- webhook remote-end simulator (a REAL local HTTP server: the stand-in
// for the user's webhook receiver) ----
const hookHits = []; // { path, headers, raw, json }
const hookServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    hookHits.push({ path: req.url, headers: req.headers, raw, json });
    res.statusCode = req.url.startsWith("/fail") ? 500 : 200;
    res.end("ok");
  });
});
await new Promise((r) => hookServer.listen(0, "127.0.0.1", r));
const hookPort = hookServer.address().port;
const HOOK_URL = `http://127.0.0.1:${hookPort}/hook`;
const hookCount = () => hookHits.length;

// ---- SMTP remote-end simulator (drives the REAL product SMTP client) ----
function startSmtpServer({ rejectRcpt = false } = {}) {
  const transcript = { commands: [], message: null, authPlain: null };
  const server = net.createServer((sock) => {
    let buffer = "";
    let inData = false;
    let dataBuf = "";
    const reply = (s) => sock.write(s + "\r\n");
    reply("220 smtp-sim ESMTP ready");
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            transcript.message = dataBuf;
            dataBuf = "";
            reply("250 OK message accepted");
          } else {
            dataBuf += line + "\r\n"; // store STUFFED lines verbatim
          }
          continue;
        }
        transcript.commands.push(line);
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) {
          // NOT advertising STARTTLS → the client must skip the TLS upgrade
          reply("250-smtp-sim greets you\r\n250 AUTH PLAIN LOGIN");
        } else if (cmd.startsWith("AUTH PLAIN")) {
          transcript.authPlain = Buffer.from(line.slice("AUTH PLAIN ".length), "base64").toString("utf8");
          reply("235 2.7.0 accepted");
        } else if (cmd.startsWith("MAIL FROM:")) {
          reply("250 2.1.0 sender ok");
        } else if (cmd.startsWith("RCPT TO:")) {
          reply(rejectRcpt ? "550 5.1.1 recipient rejected by simulator" : "250 2.1.5 recipient ok");
        } else if (cmd.startsWith("DATA")) {
          inData = true;
          reply("354 go ahead");
        } else if (cmd.startsWith("QUIT")) {
          reply("221 2.0.0 bye");
          sock.end();
        } else {
          reply("502 5.5.2 command not implemented");
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, transcript, port: server.address().port })));
}
const goodSmtp = await startSmtpServer();
const badSmtp = await startSmtpServer({ rejectRcpt: true });

// ---- boot platform (auth flows) + test app (notification routes) ----
const started = await startPlatform({ port: 0 });
const platform = `http://127.0.0.1:${started.server.address().port}`;
const app = express();
app.use(express.json());
const { notificationRouter } = await import("../src/platform/notification-delivery.js");
const notif = await import("../src/platform/notification-delivery.js");
// G5.3: nonce store for the product webhook verifier under test (receiver side)
const seenStore = (() => { const m = new Map(); return { has: (id) => m.has(id), mark: (id) => m.set(id, Date.now() + 86400000) }; })();
app.use("/api/notifications", notificationRouter()); // the integrator mount line
const testServer = http.createServer(app);
await new Promise((r) => testServer.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${testServer.address().port}`;

// ---- users (real register/login against the platform) ----
const stamp = Date.now();
const emails = {};
const tokens = {};
for (const name of ["alice", "bob", "carol", "dave", "eve"]) {
  const email = `${name}-${stamp}@notif.test`;
  const reg = await api(platform, "POST", "/api/auth/register", { body: { email, password: "Notif-Pass-1!" } });
  if (reg.status !== 200) { console.log(`FAIL  register ${name}: ${reg.status} ${reg.text?.slice(0, 200)}`); process.exit(1); }
  const login = await api(platform, "POST", "/api/auth/login", { body: { email, password: "Notif-Pass-1!" } });
  if (login.status !== 200) { console.log(`FAIL  login ${name}: ${login.status}`); process.exit(1); }
  emails[name] = email;
  tokens[name] = login.json.token;
}
const tok = (n) => ({ Authorization: `Bearer ${tokens[n]}` });
const uid = async (n) => (await query("SELECT id FROM users WHERE email = $1", [emails[n]])).rows[0].id;

// ---- injected email transport (the documented TEST seam) ----
const sentMails = [];
notif.setEmailTransport(async (mail) => { sentMails.push(mail); });
const mailCount = () => sentMails.length;

try {
  // =========================== A. auth + defaults ===========================
  {
    const r = await api(base, "GET", "/api/notifications/preferences");
    check("A1 unauthenticated preferences read is rejected", r.status === 401, `status=${r.status}`);
  }
  {
    const ev = await api(base, "GET", "/api/notifications/events", { headers: tok("alice") });
    const ids = (ev.json?.events || []).map((e) => e.id);
    check("A2 event catalog lists the 7 template events",
      ev.status === 200 && ["task.completed", "task.failed", "quota.limit_reached", "org.member_added", "org.member_removed", "api_key.created", "export.ready"].every((x) => ids.includes(x)),
      `events=${ids.join(",")}`);
  }
  {
    const r = await api(base, "GET", "/api/notifications/preferences", { headers: tok("alice") });
    const p = r.json?.preferences || {};
    check("A3 default preferences: email on, account address, no webhook",
      r.status === 200 && p.email_enabled === true && p.email_address === emails.alice && p.webhook_url === null,
      `email=${p.email_address} webhook=${p.webhook_url}`);
  }

  // =========================== B. preference updates ========================
  {
    const r = await api(base, "PUT", "/api/notifications/preferences", { headers: tok("alice"), body: { webhook_url: HOOK_URL } });
    const p = r.json?.preferences || {};
    globalThis.__aliceWebhookSecret = p.webhook_secret_once || null; // reveal-once (G5.3)
    check("B1 webhook URL accepted, secret generated (revealed ONCE on PUT, masked in reads)", r.status === 200 && p.webhook_url === HOOK_URL && typeof globalThis.__aliceWebhookSecret === "string" && globalThis.__aliceWebhookSecret.startsWith("whs_") && p.webhook_secret === null && p.webhook_secret_set === true,
      `status=${r.status} body=${JSON.stringify(r.json).slice(0, 300)}`);
  }
  {
    const bad1 = await api(base, "PUT", "/api/notifications/preferences", { headers: tok("alice"), body: { webhook_url: "ftp://example.com/hook" } });
    const bad2 = await api(base, "PUT", "/api/notifications/preferences", { headers: tok("alice"), body: { webhook_url: "https://user:pass@example.com/hook" } });
    const bad3 = await api(base, "PUT", "/api/notifications/preferences", { headers: tok("alice"), body: { webhook_url: "definitely not a url" } });
    check("B2 invalid webhook URLs rejected 400 (scheme / userinfo / garbage)",
      bad1.status === 400 && bad2.status === 400 && bad3.status === 400,
      `${bad1.status}/${bad2.status}/${bad3.status}`);
  }
  {
    delete process.env.CLONER_ALLOW_PRIVATE_TARGETS; // SSRF posture back ON
    const r = await api(base, "PUT", "/api/notifications/preferences", { headers: tok("bob"), body: { webhook_url: "http://127.0.0.1:9/hook" } });
    process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // restore for the simulator
    check("B3 loopback webhook rejected without CLONER_ALLOW_PRIVATE_TARGETS=1",
      r.status === 400 && /private|blocked/i.test(r.json?.error || ""), `status=${r.status} err=${r.json?.error}`);
  }
  {
    const r = await api(base, "PUT", "/api/notifications/preferences", { headers: tok("alice"), body: { event_overrides: { "api_key.created": { email: false } } } });
    check("B4 per-event override saved", r.status === 200 && r.json?.preferences?.event_overrides?.["api_key.created"]?.email === false,
      `status=${r.status} overrides=${JSON.stringify(r.json?.preferences?.event_overrides || {})}`);
    const badEvent = await api(base, "PUT", "/api/notifications/preferences", { headers: tok("alice"), body: { event_overrides: { "not.an.event": { email: false } } } });
    const badShape = await api(base, "PUT", "/api/notifications/preferences", { headers: tok("alice"), body: { event_overrides: { "task.failed": "nope" } } });
    check("B5 invalid overrides rejected (unknown event / bad shape)", badEvent.status === 400 && badShape.status === 400, `${badEvent.status}/${badShape.status}`);
  }

  // ================= C. emission: templates + webhook + log ================
  let aliceDeliveriesBefore = 0;
  {
    const before = await api(base, "GET", "/api/notifications/deliveries", { headers: tok("alice") });
    aliceDeliveriesBefore = (before.json?.deliveries || []).length;
    const m0 = mailCount(), h0 = hookCount();
    const out = await notif.emitEvent({
      userId: await uid("alice"),
      event: "task.completed",
      payload: { taskId: "task-123", sourceUrl: "https://example.com/shop", durationSeconds: 41, artifactCount: 7 },
      correlationId: "task-123",
    });
    await sleep(50);
    const mail = sentMails[sentMails.length - 1];
    const hook = hookHits[hookHits.length - 1];
    const okMail = sentMails.length === m0 + 1
      && mail.subject === "Clone completed: https://example.com/shop"
      && mail.to === emails.alice
      && mail.text.includes("task-123") && mail.text.includes("41s");
    check("C1 email sent with rendered template (subject/to/text placeholders)", okMail,
      `subject="${mail?.subject}" to=${mail?.to}`);
    const sig = hook.headers["x-cloner-signature"];
    // G5.3: verify through the PRODUCT receiver-side verifier (timestamp +
    // delivery id covered by the HMAC, tolerance + nonce store enforced) and
    // prove a re-POST of the same captured delivery is rejected as REPLAY.
    let verified = null, replayErr = null, verifyErr = null;
    try { verified = notif.verifyUserWebhook({ rawBody: hook.raw, secret: globalThis.__aliceWebhookSecret, headers: hook.headers, seenStore }); }
    catch (e) { verifyErr = e; }
    try { notif.verifyUserWebhook({ rawBody: hook.raw, secret: globalThis.__aliceWebhookSecret, headers: hook.headers, seenStore }); }
    catch (e) { replayErr = e; }
    check("C2 webhook delivered with replay-safe signature (v1 ts+nonce HMAC) verified by product verifier",
      hookHits.length === h0 + 1 && hook.json?.event === "task.completed" && hook.json?.correlation_id === "task-123"
        && !!verified && /^v1=[0-9a-f]{64}$/.test(sig)
        && !!hook.headers["x-cloner-timestamp"] && !!hook.headers["x-cloner-delivery"]
        && replayErr?.code === "REPLAY" && !verifyErr,
      `verified=${!!verified} replay=${replayErr?.code} err=${verifyErr?.code}`);
    check("C3 emission reports both channels sent",
      out.email?.status === "sent" && out.webhook?.status === "sent",
      JSON.stringify({ email: out.email?.status, webhook: out.webhook?.status }));
    const after = await api(base, "GET", "/api/notifications/deliveries", { headers: tok("alice") });
    const fresh = (after.json?.deliveries || []).slice(0, 2);
    check("C4 delivery log records both channels as sent with subject",
      (after.json?.deliveries || []).length === aliceDeliveriesBefore + 2
        && fresh.every((d) => d.status === "sent" && d.subject === "Clone completed: https://example.com/shop"),
      `rows=${(after.json?.deliveries || []).length - aliceDeliveriesBefore}`);
  }
  {
    // XSS-safe HTML rendering: payload values are escaped in the html part
    await notif.emitEvent({
      userId: await uid("alice"), event: "org.member_added",
      payload: { orgName: "Acme", memberEmail: "<img src=x onerror=alert(1)>@evil.test", role: "member" },
    });
    await sleep(30);
    const mail = sentMails[sentMails.length - 1];
    check("C5 payload values are HTML-escaped in the html template",
      mail.html.includes("&lt;img") && !mail.html.includes("<img"), htmlSlice(mail.html));
    // header injection: CRLF in a payload field must not create headers
    await notif.emitEvent({
      userId: await uid("alice"), event: "task.completed",
      payload: { taskId: "t2", sourceUrl: "https://a.test\r\nBcc: attacker@evil.test", durationSeconds: 1, artifactCount: 1 },
    });
    await sleep(30);
    const m = sentMails[sentMails.length - 1];
    // The security property: CRLF is flattened so no new header line can be
    // started (the payload text itself may remain, harmlessly, inside the one
    // Subject value — the wire-level no-Bcc-header proof is check G2).
    check("C6 header injection sanitized (no CR/LF reaches the Subject header)",
      !/[\r\n]/.test(m.subject), `subject=${JSON.stringify(m.subject)}`);
  }

  // ====================== D. preferences are respected =====================
  {
    await api(base, "PUT", "/api/notifications/preferences", { headers: tok("alice"), body: { event_overrides: { "task.completed": { email: false }, "task.failed": { email: false }, "quota.limit_reached": { email: false, webhook: false }, "org.member_added": {} } } });
    const m0 = mailCount(), h0 = hookCount();
    const out1 = await notif.emitEvent({ userId: await uid("alice"), event: "task.failed", payload: { taskId: "t3", sourceUrl: "https://x.test", error: "boom" } });
    check("D1 event override email:false mutes email, webhook still fires",
      sentMails.length === m0 && hookHits.length === h0 + 1 && out1.email?.status === "skipped" && out1.webhook?.status === "sent",
      `email=${out1.email?.status}/${out1.email?.reason} hook=+${hookHits.length - h0}`);
    const out2 = await notif.emitEvent({ userId: await uid("alice"), event: "quota.limit_reached", payload: { limitKey: "max_jobs_per_day", scope: "user", limit: 5, used: 5 } });
    check("D2 both channels muted → nothing sent, nothing logged",
      sentMails.length === m0 && hookHits.length === h0 + 1 && out2.email?.status === "skipped" && out2.webhook?.status === "skipped",
      JSON.stringify({ email: out2.email, webhook: out2.webhook }));
  }
  {
    await api(base, "PUT", "/api/notifications/preferences", { headers: tok("bob"), body: { email_enabled: false, webhook_url: HOOK_URL } });
    const m0 = mailCount(), h0 = hookCount();
    const out = await notif.emitEvent({ userId: await uid("bob"), event: "export.ready", payload: { taskId: "t4", format: "zip", sizeBytes: 2048 } });
    check("D3 global email_enabled:false disables email only",
      sentMails.length === m0 && hookHits.length === h0 + 1 && out.email?.status === "skipped" && out.webhook?.status === "sent",
      `email=${out.email?.reason} hook=+${hookHits.length - h0}`);
  }

  // ============================ E. rate limiting ===========================
  {
    process.env.NOTIF_MAX_PER_MINUTE = "3"; // tighten the budget for THIS phase only
    const m0 = sentMails.filter((m) => m.to === emails.carol).length;
    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push(await notif.emitEvent({ userId: await uid("carol"), event: "export.ready", payload: { taskId: `t-${i}`, format: "zip", sizeBytes: 100 + i } }));
    }
    process.env.NOTIF_MAX_PER_MINUTE = "50"; // restore headroom for later phases
    const statuses = outcomes.map((o) => o.email?.status);
    const carolMails = sentMails.filter((m) => m.to === emails.carol).length - m0;
    const rows = (await api(base, "GET", "/api/notifications/deliveries", { headers: tok("carol") })).json?.deliveries || [];
    check("E1 NOTIF_MAX_PER_MINUTE=3 enforced: 3 sent then 2 rate_limited",
      statuses.join(",") === "sent,sent,sent,rate_limited,rate_limited" && carolMails === 3,
      statuses.join(","));
    check("E2 rate-limited attempts are logged with status rate_limited",
      rows.filter((d) => d.status === "rate_limited").length === 2 && rows.filter((d) => d.status === "sent").length === 3,
      `sent=${rows.filter((d) => d.status === "sent").length} limited=${rows.filter((d) => d.status === "rate_limited").length}`);
  }

  // ============================== F. dedupe ================================
  {
    const m0 = mailCount(), h0 = hookCount();
    const first = await notif.emitEvent({ userId: await uid("alice"), event: "org.member_added", payload: { orgName: "Acme", memberEmail: "new@acme.test", role: "member" }, dedupeKey: "org-9:alice" });
    const second = await notif.emitEvent({ userId: await uid("alice"), event: "org.member_added", payload: { orgName: "Acme", memberEmail: "other@acme.test", role: "member" }, dedupeKey: "org-9:alice" });
    check("F1 dedupeKey replay is skipped (no second send)",
      first.email?.status === "sent" && second.deduped === true && sentMails.length === m0 + 1 && hookHits.length === h0 + 1,
      `second=${JSON.stringify(second.email)}`);
  }

  // ============ G. REAL SMTP transport vs simulated SMTP server ============
  {
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(goodSmtp.port);
    process.env.SMTP_FROM = "cloner@test.local";
    process.env.SMTP_USER = "mailer";
    process.env.SMTP_PASS = "mailer-pass";
    notif.resetEmailTransport(); // product path: the real SMTP client

    await api(base, "PUT", "/api/notifications/preferences", { headers: tok("dave"), body: { email_enabled: true, webhook_url: HOOK_URL } });
    const h0 = hookCount();
    const out = await notif.emitEvent({
      userId: await uid("dave"), event: "task.failed", correlationId: "t-smtp",
      payload: {
        taskId: "t-smtp", sourceUrl: "https://dave.test\r\nBcc: attacker@evil.test",
        error: "\n.stuffed-line\nunicode: π signed",
      },
    });
    await sleep(100);
    const t = goodSmtp.transcript;
    const authOk = t.authPlain === "\0mailer\0mailer-pass";
    check("G1 real SMTP client completed a full transaction (EHLO→AUTH PLAIN→MAIL→RCPT→DATA→QUIT)",
      out.email?.status === "sent"
        && t.commands.some((c) => c.startsWith("EHLO"))
        && t.commands.some((c) => c.startsWith("AUTH PLAIN")) && authOk
        && t.commands.includes("MAIL FROM:<cloner@test.local>")
        && t.commands.includes(`RCPT TO:<${emails.dave}>`)
        && t.commands.includes("DATA")
        && t.commands.includes("QUIT"),
      `status=${out.email?.status} err=${out.email?.error || ""} cmds=${t.commands.length}`);
    const msg = t.message || "";
    const headerBlock = msg.split("\r\n\r\n")[0] || "";
    check("G2 MIME message: multipart/alternative + quoted-printable, no injected Bcc header",
      msg.includes("Content-Type: multipart/alternative") && msg.includes("Content-Transfer-Encoding: quoted-printable")
        && !/^Bcc:/mi.test(headerBlock) && headerBlock.split("\r\n").some((l) => l.startsWith("Subject: Clone failed: https://dave.test Bcc: attacker@evil.test")),
      `subject-line-ok=${headerBlock.split("\r\n").some((l) => l.startsWith("Subject: Clone failed"))}`);
    check("G3 dot-stuffing applied (leading-dot body line doubled in DATA)",
      msg.includes("..stuffed-line"), msg.split("\r\n").filter((l) => l.includes("stuffed-line")).join(" | "));
    check("G4 quoted-printable encodes unicode (π → =CF=80)",
      msg.includes("=CF=80"), msg.split("\r\n").filter((l) => l.includes("CF=80")).join(" | "));
    check("G5 webhook unaffected by email success path", hookHits.length === h0 + 1, `+${hookHits.length - h0}`);
    const rows = (await api(base, "GET", "/api/notifications/deliveries", { headers: tok("dave") })).json?.deliveries || [];
    const pair = rows.slice(0, 2);
    check("G6 delivery log: email sent + webhook sent",
      pair.length === 2 && pair.some((d) => d.channel === "email" && d.status === "sent") && pair.some((d) => d.channel === "webhook" && d.status === "sent"),
      JSON.stringify(pair.map((d) => `${d.channel}:${d.status}`)));
  }
  {
    // RCPT rejection → email fails, webhook still delivered (channel independence)
    process.env.SMTP_PORT = String(badSmtp.port);
    await api(base, "PUT", "/api/notifications/preferences", { headers: tok("eve"), body: { email_enabled: true, webhook_url: HOOK_URL } });
    const h0 = hookCount();
    const out = await notif.emitEvent({ userId: await uid("eve"), event: "task.failed", payload: { taskId: "t-bad", sourceUrl: "https://eve.test", error: "boom" } });
    const rows = (await api(base, "GET", "/api/notifications/deliveries", { headers: tok("eve") })).json?.deliveries || [];
    check("G7 SMTP 550 rejection → email failed with server reply in detail, webhook still sent",
      out.email?.status === "failed" && /550/.test(out.email?.error || "") && out.webhook?.status === "sent"
        && rows.slice(0, 2).some((d) => d.channel === "email" && d.status === "failed")
        && rows.slice(0, 2).some((d) => d.channel === "webhook" && d.status === "sent"),
      `email=${out.email?.error?.slice(0, 60)} hook=+${hookHits.length - h0}`);
    delete process.env.SMTP_PORT; delete process.env.SMTP_HOST; delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS; delete process.env.SMTP_FROM;
  }

  // ================== H. test endpoint + unconfigured posture ================
  {
    notif.setEmailTransport(async (mail) => { sentMails.push(mail); }); // re-inject for API-level checks
    // undo the D-phase mute so the sample send can exercise both channels
    await api(base, "PUT", "/api/notifications/preferences", { headers: tok("alice"), body: { event_overrides: {} } });
    const m0 = mailCount();
    const r = await api(base, "POST", "/api/notifications/test", { headers: tok("alice"), body: { event: "quota.limit_reached" } });
    const m = sentMails[sentMails.length - 1];
    check("H1 POST /test sends a sample through the real pipeline (template sample payload)",
      r.status === 200 && r.json?.outcomes?.email?.status === "sent" && sentMails.length === m0 + 1
        && m.subject === "Quota limit reached: max_jobs_per_day",
      `subject="${m?.subject}"`);
    const bad = await api(base, "POST", "/api/notifications/test", { headers: tok("alice"), body: { event: "nope.nothing" } });
    check("H2 unknown event on /test → 400", bad.status === 400, `status=${bad.status}`);
    notif.resetEmailTransport();
    delete process.env.SMTP_HOST; delete process.env.SMTP_FROM; // nothing configured
    const out = await notif.emitEvent({ userId: await uid("carol"), event: "task.completed", payload: { taskId: "t-unconf", sourceUrl: "https://u.test", durationSeconds: 2, artifactCount: 0 } });
    check("H3 no SMTP config and no transport → clean skip (email_not_configured), no throw",
      out.email?.status === "skipped" && out.email?.reason === "email_not_configured",
      JSON.stringify(out.email));
  }

  // ============================ I. deliveries API ==========================
  {
    const r = await api(base, "GET", "/api/notifications/deliveries?limit=3", { headers: tok("alice") });
    const rows = r.json?.deliveries || [];
    const desc = rows.every((d, i) => i === 0 || Number(rows[i - 1].id) >= Number(d.id)); // BIGSERIAL ids arrive as strings
    check("I1 GET /deliveries returns newest-first, honor ?limit",
      r.status === 200 && rows.length <= 3 && rows.length > 0 && desc,
      `n=${rows.length}`);
  }
} finally {
  notif.resetEmailTransport();
  hookServer.close();
  goodSmtp.server.close();
  badSmtp.server.close();
  testServer.close();
  started.server.close();
  await closePool();
}

const failed = results.filter((x) => !x).length;
console.log(`\nnotification-delivery: ${results.length - failed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);

function htmlSlice(s) {
  const i = String(s).indexOf("&lt;");
  return i >= 0 ? `…${String(s).slice(Math.max(0, i - 10), i + 12)}…` : String(s).slice(0, 60);
}
