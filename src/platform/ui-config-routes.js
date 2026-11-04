// G2.3 — Model-provider configuration API backing the onboarding flow and
// provider/model management clients (headless since G7.1 — API consumers only).
//
//   GET  /api/config/providers            — provider inventory + key status + usage
//   POST /api/config/providers/:name/key  — key rotation (writes the env-backed config)
//   POST /api/config/providers/:name/test — REAL connectivity probe with the effective key
//   GET  /api/config/rotations            — rotation ledger (fingerprints only, never keys)
//
// KEY ROTATION CONTRACT (why ".env-backed config"):
//   The platform reads provider keys from env (src/config.js:44-50 and
//   src/platform/model-router.js:46-49):
//     OPENAI_API_KEY / OPENAI_BASE_URL       (provider "openai" + the "env-openai" slot)
//     ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL (provider "anthropic")
//     CUSTOM_API_KEY / CUSTOM_BASE_URL       (provider "custom")
//   Rotation writes the new key into (a) process.env — so the RUNNING platform
//   picks it up on the very next loadConfig()/routeChat() with zero restart —
//   and (b) the .env file (path overridable with CLONER_ENV_FILE) so the
//   rotation survives a restart through whatever env loader the deployment
//   uses. The env layer SHADOWS the cloner.config.json key for the same
//   provider type (documented resolution: env wins). Raw keys are never
//   returned by any endpoint and never logged; the ledger stores a SHA-256
//   fingerprint prefix only. Rotations land in the real hash-chained audit
//   trail (admin.action, 4.0.9).
//
// INTEGRATOR MOUNT LINE (src/platform/server.js is integrator-owned — do not
// edit here; mount the same posture as GET /api/providers, before the static UI):
//   import { uiConfigRouter } from "./ui-config-routes.js";
//   app.use("/api/config", uiConfigRouter());
//
// Test note: scripts/test-ui-onboarding.mjs applies exactly this mount line
// dynamically to a booted platform (server.listeners("request") prepending)
// until the integrator merges the static line above.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { loadConfig } from "../config.js";
import { authRequired } from "../auth/auth-middleware.js";
import * as wsAuth from "./ws-auth.js";
import { audit } from "./audit-service.js";

// env vars each provider TYPE rotates into (mirrors config.js env fallbacks)
const KEY_VARS = {
  openai: { key: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL" },
  anthropic: { key: "ANTHROPIC_API_KEY", baseUrl: "ANTHROPIC_BASE_URL" },
  custom: { key: "CUSTOM_API_KEY", baseUrl: "CUSTOM_BASE_URL" },
};
const SLOTS = ["openai", "anthropic", "custom"]; // activatable even with no providers configured
const MAX_LEDGER = 100;

function envFile() {
  return process.env.CLONER_ENV_FILE || path.join(process.cwd(), ".env");
}

function ledgerFile() {
  return path.join(process.cwd(), "platform-data", "model-key-rotations.json");
}

function maskKey(key) {
  const k = String(key || "");
  if (!k) return "";
  if (k.length < 12) return "•".repeat(Math.min(k.length, 8));
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

function fingerprint(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 16);
}

// ---- .env store: ordered, comment-preserving, atomic ----
function parseEnvFile(text) {
  const entries = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      entries.push({ key: m[1], value: v });
    } else {
      entries.push({ raw: line }); // comment / blank line
    }
  }
  return entries;
}

function serializeEnvFile(entries) {
  return entries.map((e) => (e.key !== undefined ? `${e.key}=${e.value}` : e.raw)).join("\n").replace(/\s*$/, "\n");
}

// merge a single var into the env file; preserves every other line as-is
export function writeEnvVar(file, key, value) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# cloner platform env (rotated provider keys land here — never commit)\n";
  const entries = parseEnvFile(existing);
  const idx = entries.findIndex((e) => e.key === key);
  if (idx >= 0) entries[idx] = { key, value };
  else entries.push({ key, value });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, serializeEnvFile(entries), { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic on POSIX; same-volume rename on Windows
  return file;
}

export function readLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerFile(), "utf8"));
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

function appendLedger(entry) {
  const entries = [...readLedger(), entry].slice(-MAX_LEDGER);
  const file = ledgerFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2));
  fs.renameSync(tmp, file);
}

// ---- provider inventory: configured providers + activatable env slots ----
// async because the real model-router inventory is loaded dynamically (same
// module GET /api/providers uses).
export async function providerInventory() {
  const cfg = loadConfig();
  let configured = [];
  try {
    const { getProviders } = await import("./model-router.js");
    configured = getProviders(cfg).map((p) => ({ ...p }));
  } catch {
    configured = []; // router missing — slots below still render
  }
  // rotation metadata attaches by key fingerprint (authoritative) or row name —
  // a rotated slot may BECOME a configured provider (env key → "primary"), and
  // the rotation history must follow the key, not the transient label.
  const ledger = readLedger();
  const lastRotation = (rowName, rowFingerprint) =>
    ledger.filter((e) => e.name === rowName || (rowFingerprint && e.fingerprint === rowFingerprint)).at(-1)?.rotatedAt || null;

  const rows = [];
  for (const p of configured) {
    const vars = KEY_VARS[p.provider] || KEY_VARS.custom;
    const fromEnv = !!(vars.key && process.env[vars.key] && p.apiKey && p.apiKey === process.env[vars.key]);
    rows.push({
      name: p.name,
      type: p.provider || "custom",
      model: p.model || "",
      baseUrl: p.baseUrl || "",
      capabilities: p.capabilities || ["text"],
      hasKey: !!p.apiKey,
      masked: maskKey(p.apiKey),
      source: fromEnv ? "env" : "config",
      keyVar: vars.key,
      baseUrlVar: vars.baseUrl || null,
      fingerprint: p.apiKey ? fingerprint(p.apiKey) : null,
      slot: false,
      rotatedAt: lastRotation(p.name, p.apiKey ? fingerprint(p.apiKey) : null),
    });
  }
  // activatable slots: a provider TYPE the platform can run that is not yet
  // represented — this is what onboarding activates.
  for (const type of SLOTS) {
    if (rows.some((r) => r.type === type)) continue;
    const vars = KEY_VARS[type];
    const envKey = process.env[vars.key] || "";
    const name = `${type}-slot`;
    rows.push({
      name,
      type,
      model: type === "anthropic" ? "claude-sonnet-4-5" : type === "openai" ? "gpt-4o" : "",
      baseUrl: process.env[vars.baseUrl] || "",
      capabilities: ["vision", "text"],
      hasKey: !!envKey,
      masked: maskKey(envKey),
      source: envKey ? "env" : "none",
      keyVar: vars.key,
      baseUrlVar: vars.baseUrl,
      fingerprint: envKey ? fingerprint(envKey) : null,
      slot: true,
      rotatedAt: lastRotation(name, envKey ? fingerprint(envKey) : null),
    });
  }
  return rows;
}

// ---- guard: same posture as GET /api/providers (loopback dashboard or session) ----
// Header-only bearer (server.js localOrAuthed dropped ?token= support in the
// G5.3 hardening) — keep the two postures identical.
function loopbackOrAuthed(req, res, next) {
  const hasBearer = (req.headers.authorization || "").startsWith("Bearer ");
  if (hasBearer) return authRequired(req, res, next);
  if (!wsAuth.isLoopback(req.socket?.remoteAddress)) return res.status(401).json({ error: "authentication required" });
  req.userId = null; // loopback dashboard legacy posture (matches server.js)
  next();
}

function auditSafe(fn, payload) {
  try { Promise.resolve(fn(payload)).catch(() => {}); } catch {}
}

// REAL provider connectivity probe (product path — hits the actual endpoint
// with the effective key). Never a stub: openai/custom → GET {baseUrl}/models;
// anthropic → POST /v1/messages. The effective endpoint env-shadows the config
// file the same way the key does (a rotated base URL takes effect immediately).
function effectiveBaseUrl(p) {
  return (p.baseUrlVar && process.env[p.baseUrlVar]) || p.baseUrl || "";
}

async function probeProvider(p) {
  if (p.type === "anthropic") {
    const base = (effectiveBaseUrl(p) || "https://api.anthropic.com").replace(/\/+$/, "");
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": p.effectiveKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: p.model || "claude-sonnet-4-5", max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(12000),
    });
    return { ok: res.ok, status: res.status, detail: res.ok ? "anthropic reachable" : `anthropic responded ${res.status}` };
  }
  const base = (effectiveBaseUrl(p) || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${p.effectiveKey}` }, signal: AbortSignal.timeout(12000) });
  let models = 0;
  if (res.ok) {
    try { const j = await res.json(); models = Array.isArray(j?.data) ? j.data.length : 0; } catch { /* reachable, body not JSON */ }
  }
  return { ok: res.ok, status: res.status, detail: res.ok ? `openai-compatible reachable (${models} models)` : `endpoint responded ${res.status}` };
}

export function uiConfigRouter() {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  // provider inventory (GET) — masked keys, never raw
  router.get("/providers", loopbackOrAuthed, async (_req, res) => {
    try {
      const { usageStats } = await import("./model-router.js");
      const usage = usageStats();
      const providers = (await providerInventory()).map((p) => ({
        name: p.name, type: p.type, model: p.model, baseUrl: p.baseUrl,
        capabilities: p.capabilities, hasKey: p.hasKey, masked: p.masked,
        source: p.source, keyVar: p.keyVar, baseUrlVar: p.baseUrlVar,
        fingerprint: p.fingerprint, slot: p.slot, rotatedAt: p.rotatedAt,
        usage: usage[p.name] || null,
      }));
      res.json({ providers, usage });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
    }
  });

  // key rotation — env-backed config write (process.env live + .env durable)
  router.post("/providers/:name/key", loopbackOrAuthed, async (req, res) => {
    const name = String(req.params.name || "");
    const key = String((req.body || {}).key ?? "");
    const baseUrl = (req.body || {}).baseUrl == null ? null : String((req.body || {}).baseUrl).trim();
    if (!key.trim()) return res.status(400).json({ error: "key required" });
    if (key.length > 4096) return res.status(400).json({ error: "key too long" });
    if (/[\r\n\0]/.test(key) || /[\r\n\0]/.test(name)) return res.status(400).json({ error: "control characters not allowed" });
    if (key.trim().length < 8) return res.status(400).json({ error: "key too short (min 8 characters)" });
    if (baseUrl !== null && (!/^https?:\/\//i.test(baseUrl) || /[\r\n\0]/.test(baseUrl))) {
      return res.status(400).json({ error: "baseUrl must be an http(s) URL" });
    }
    try {
      const inventory = await providerInventory();
      const p = inventory.find((x) => x.name === name) || inventory.find((x) => x.type === name); // by name or type
      if (!p) return res.status(404).json({ error: `unknown provider ${name.slice(0, 64)}` });
      const vars = KEY_VARS[p.type];
      if (!vars) return res.status(400).json({ error: `provider type ${p.type} has no env rotation target` });

      const trimmed = key.trim();
      writeEnvVar(envFile(), vars.key, trimmed);
      process.env[vars.key] = trimmed; // LIVE immediately — loadConfig()/model-router read this
      if (baseUrl !== null && vars.baseUrl) {
        writeEnvVar(envFile(), vars.baseUrl, baseUrl);
        process.env[vars.baseUrl] = baseUrl;
      }

      const entry = {
        name: p.name, type: p.type, var: vars.key,
        fingerprint: fingerprint(trimmed), masked: maskKey(trimmed),
        baseUrl: baseUrl || p.baseUrl || null,
        rotatedAt: new Date().toISOString(),
        actorId: req.userId || null,
        actor: req.userId ? "user" : "local",
      };
      appendLedger(entry);
      auditSafe(audit.adminAction, {
        actorType: req.userId ? "user" : "anonymous",
        actorId: req.userId || null,
        targetType: "model_provider",
        targetId: p.name,
        outcome: "success",
        metadata: { operation: "key.rotate", providerType: p.type, envVar: vars.key, keyFingerprint: entry.fingerprint },
      });

      const after = (await providerInventory()).find((x) => x.name === p.name) || {};
      res.json({
        ok: true, name: p.name, type: p.type, var: vars.key,
        masked: maskKey(trimmed), fingerprint: entry.fingerprint,
        rotatedAt: entry.rotatedAt, baseUrl: baseUrl || null,
        source: after.source || "env",
      });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
    }
  });

  // REAL connectivity probe with the EFFECTIVE key (env shadows config file)
  router.post("/providers/:name/test", loopbackOrAuthed, async (req, res) => {
    const name = String(req.params.name || "");
    try {
      const inventory = await providerInventory();
      const p = inventory.find((x) => x.name === name) || inventory.find((x) => x.type === name);
      if (!p) return res.status(404).json({ error: `unknown provider ${name.slice(0, 64)}` });
      const effectiveKey = (p.keyVar && process.env[p.keyVar]) || "";
      if (!effectiveKey) return res.status(400).json({ ok: false, error: "no key configured for this provider" });
      const started = Date.now();
      const result = await probeProvider({ ...p, effectiveKey });
      auditSafe(audit.adminAction, {
        actorType: req.userId ? "user" : "anonymous",
        actorId: req.userId || null,
        targetType: "model_provider",
        targetId: p.name,
        outcome: result.ok ? "success" : "failure",
        metadata: { operation: "provider.test", status: result.status ?? null },
      });
      res.json({ ...result, latencyMs: Date.now() - started, provider: p.name });
    } catch (e) {
      // probe failure (unreachable endpoint, timeout) is a RESULT, not a 500.
      // G5.1 fix: keep the SAME response shape as the reachable branch — `detail`
      // (plus `error`) so clients reading .detail never see undefined.
      const msg = String(e?.cause?.message || e?.message || e).slice(0, 200);
      res.json({ ok: false, detail: `probe failed: ${msg}`, error: msg, provider: name });
    }
  });

  // rotation ledger (fingerprints + timestamps only)
  router.get("/rotations", loopbackOrAuthed, (_req, res) => {
    res.json({
      entries: readLedger().map(({ name, type, var: v, fingerprint: fp, masked, rotatedAt, actor }) => ({ name, type, var: v, fingerprint: fp, masked, rotatedAt, actor })),
    });
  });

  return router;
}
