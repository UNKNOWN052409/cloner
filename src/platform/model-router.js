// Multi-provider model router (spec §12): the platform uses ALL configured
// providers/models — different purposes go to different models, and when one
// provider hits a quota or errors, the next one takes over automatically.
//
// Configuration (cloner.config.json):
//   {
//     "providers": [
//       { "name": "glm",    "provider": "custom",    "model": "glm-5.3-flash-free", "baseUrl": "https://kiosapi.com/v1", "apiKey": "sk-...", "capabilities": ["vision", "text"] },
//       { "name": "gemini", "provider": "openai",    "model": "gemini-2.5-flash",   "baseUrl": "https://gcss.googleapis.com/v1", "apiKey": "..." }
//     ]
//   }
// Legacy single "model" block keeps working (becomes the primary provider).
// Env fallbacks: OPENAI_API_KEY / ANTHROPIC_API_KEY.
import { VisionClient } from "../vision.js";

const usage = new Map(); // name -> { ok, errors, quota, lastError }
const track = (name, kind, err = null) => {
  const u = usage.get(name) || { ok: 0, errors: 0, quota: 0, lastError: null };
  u[kind === "ok" ? "ok" : kind === "quota" ? "quota" : "errors"]++;
  if (err) u.lastError = String(err).slice(0, 160);
  usage.set(name, u);
};
export function usageStats() {
  return Object.fromEntries([...usage.entries()].map(([k, v]) => [k, { ...v }]));
}

export function getProviders(cfg) {
  const list = [];
  for (const p of cfg.providers || []) {
    if (!p.baseUrl && !p.provider) continue;
    list.push({
      name: p.name || p.model || p.provider,
      provider: p.provider || "custom",
      model: p.model || "",
      baseUrl: p.baseUrl || "",
      apiKey: p.apiKey || "",
      capabilities: p.capabilities || ["text"],
    });
  }
  if (!list.length && cfg.model && cfg.model.provider !== "none") {
    list.push({ name: "primary", capabilities: ["vision", "text"], ...cfg.model });
  }
  // env-provided extras so users can add keys without touching config —
  // but skip keys already present in the providers list (a local-relay key in
  // OPENAI_API_KEY must not spawn a bogus api.openai.com provider)
  if (process.env.OPENAI_API_KEY && !list.some((p) => p.apiKey === process.env.OPENAI_API_KEY)) {
    list.push({ name: "env-openai", provider: "openai", model: process.env.OPENAI_MODEL || "gpt-4o", baseUrl: process.env.OPENAI_BASE_URL || "", apiKey: process.env.OPENAI_API_KEY, capabilities: ["vision", "text"] });
  }
  return list.filter((p) => p.provider !== "none" && (p.apiKey || p.baseUrl));
}

// purpose → preferred capabilities: visual tasks need vision-capable providers first
function orderForPurpose(providers, purpose) {
  const wantVision = /polish|visual|image|screenshot|compare/i.test(purpose);
  const score = (p) =>
    (wantVision && p.capabilities.includes("vision") ? -10 : 0) +
    (usage.get(p.name)?.quota > 2 ? +20 : 0) + // deprioritize quota-exhausted
    (usage.get(p.name)?.errors > 3 ? +10 : 0); // deprioritize flaky
  return [...providers].sort((a, b) => score(a) - score(b));
}

// chat with automatic provider fallback; returns { out, provider }
export async function routeChat(cfg, messages, opts = {}, purpose = "general") {
  const providers = orderForPurpose(getProviders(cfg), purpose);
  if (!providers.length) throw new Error("no API providers configured");
  let lastErr = null;
  for (const p of providers) {
    try {
      const client = new VisionClient({ model: { provider: p.provider, model: p.model, baseUrl: p.baseUrl, apiKey: p.apiKey } });
      const out = await client.chat(messages, opts);
      track(p.name, "ok");
      return { out, provider: p.name };
    } catch (e) {
      const quota = /429|quota|rate limit/i.test(e.message);
      track(p.name, quota ? "quota" : "error", e.message);
      lastErr = e;
      continue; // next provider takes over
    }
  }
  throw new Error(`all ${providers.length} provider(s) failed — last: ${String(lastErr?.message || lastErr).slice(0, 140)}`);
}
