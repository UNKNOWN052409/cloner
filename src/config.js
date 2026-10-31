import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  model: {
    // provider: auto | anthropic | openai | custom | none
    provider: "auto",
    // model id override (e.g. "gpt-4o", "claude-sonnet-4-5", or any vision model)
    model: "",
    // only used when provider=custom (OpenAI-compatible endpoint)
    baseUrl: "",
    apiKey: "",
  },
  crawl: {
    maxPages: 5, // main page + up to N-1 same-site tabs
    maxAssets: 800, // full-stack clones: JS bundles + JSON/i18n push past the old 400
    concurrency: 16,
    timeoutMs: 15000,
    viewport: { width: 1440, height: 900 },
    networkIdleMs: 6000, // cap for waiting on network idle
  },
  polish: { enabled: true, rounds: 2 },
  video: { maxFrames: 16, frameSeconds: 0 }, // 0 = auto step from duration
  server: { port: 4173, open: true },
};

const MODEL_PRESETS = {
  anthropic: { model: "claude-sonnet-4-5" },
  openai: { model: "gpt-4o" },
};

export function loadConfig(overrides = {}) {
  const cfg = structuredClone(DEFAULTS);
  const file = path.join(process.cwd(), "cloner.config.json");
  if (fs.existsSync(file)) {
    try {
      deepMerge(cfg, JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (e) {
      console.warn(`⚠ could not parse cloner.config.json: ${e.message}`);
    }
  }
  deepMerge(cfg, overrides);

  // env fallbacks for keys
  if (!cfg.model.apiKey) {
    if (cfg.model.provider === "openai") cfg.model.apiKey = process.env.OPENAI_API_KEY || "";
    else if (cfg.model.provider === "anthropic") cfg.model.apiKey = process.env.ANTHROPIC_API_KEY || "";
  }
  if (cfg.model.provider === "custom" && !cfg.model.apiKey) cfg.model.apiKey = cfg.model.apiKey || process.env.CUSTOM_API_KEY || "";
  if (cfg.model.provider === "custom" && !cfg.model.baseUrl && process.env.CUSTOM_BASE_URL) cfg.model.baseUrl = process.env.CUSTOM_BASE_URL;
  if (cfg.model.provider === "anthropic" && process.env.ANTHROPIC_BASE_URL && !cfg.model.baseUrl) {
    cfg.model.baseUrl = process.env.ANTHROPIC_BASE_URL;
  }
  // preset defaults
  const preset = MODEL_PRESETS[cfg.model.provider];
  if (preset && !cfg.model.model) cfg.model.model = preset.model;
  // "auto": first provider with a key in env
  if (cfg.model.provider === "auto") {
    if (process.env.ANTHROPIC_API_KEY) {
      cfg.model.provider = "anthropic";
      cfg.model.apiKey ||= process.env.ANTHROPIC_API_KEY;
      cfg.model.baseUrl ||= process.env.ANTHROPIC_BASE_URL || "";
      cfg.model.model = process.env.ANTHROPIC_MODEL || MODEL_PRESETS.anthropic.model;
    } else if (process.env.OPENAI_API_KEY) {
      cfg.model.provider = "openai";
      cfg.model.apiKey ||= process.env.OPENAI_API_KEY;
      cfg.model.model ||= MODEL_PRESETS.openai.model;
    } else {
      cfg.model.provider = "none";
    }
  }
  return cfg;
}

function deepMerge(dst, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof dst[k] === "object") deepMerge(dst[k], v);
    else if (v !== undefined && v !== null) dst[k] = v;
  }
}
