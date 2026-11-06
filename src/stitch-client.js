// Google Stitch backend for image→code (provider "stitch").
// Thin wrapper over the official @google/stitch-sdk — lazy-imported so the engine
// runs without the package installed (clear config error instead of a crash).
//
// SDK mapping (v0.3.5, dist/generated/src/*.d.ts — followed over the earlier guess):
//  - We construct StitchToolClient({ apiKey }) + new Stitch(client) explicitly: the
//    `stitch` singleton lazily validates the env on property access and throws an
//    opaque Zod error without a key, so it is never touched here.
//  - project.generate(prompt, deviceType, modelId) → Screen. Text prompt only — the
//    SDK exposes no image upload (all 12 MCP tools are text-based), so image parts
//    of the messages are dropped and the text prompt drives generation.
//  - screen.getHtml() returns a DOWNLOAD URL, not HTML — fetched here to return the
//    actual HTML text. screen.getImage() returns the screenshot download URL and is
//    surfaced as this.screenshotUrl without fetching.
//  - maxTokens has no Stitch equivalent (ignored). Generation is not incremental, so
//    onDelta fires once with the complete HTML.

const DEVICE_TYPES = ["MOBILE", "DESKTOP", "TABLET", "AGNOSTIC"];
const MODEL_IDS = ["GEMINI_3_PRO", "GEMINI_3_FLASH", "GEMINI_3_1_PRO"];

export function stitchApiKey(cfg) {
  const m = cfg?.model || {};
  return m.apiKey || process.env.STITCH_API_KEY || "";
}

// Stitch takes one text prompt: system text + user text parts, in order.
// Image parts cannot be sent (the SDK has no image upload) and are dropped.
export function stitchPromptFromMessages(messages) {
  const parts = [];
  for (const m of messages || []) {
    if (Array.isArray(m.content)) {
      for (const p of m.content) if (p.type === "text" && p.text?.trim()) parts.push(p.text.trim());
    } else if (typeof m.content === "string" && m.content.trim()) {
      parts.push(m.content.trim());
    }
  }
  return parts.join("\n\n");
}

// Lazy SDK load — the specifier is a parameter so tests can exercise the
// missing-package path offline by passing a module that does not exist.
export async function loadStitchSdk(specifier = "@google/stitch-sdk") {
  try {
    return await import(specifier);
  } catch (e) {
    if (e && (e.code === "ERR_MODULE_NOT_FOUND" || /cannot find (package|module)/i.test(e.message || ""))) {
      throw new Error('provider "stitch" requires the @google/stitch-sdk package — run: npm install @google/stitch-sdk');
    }
    throw e;
  }
}

export class StitchClient {
  constructor(cfg) {
    const m = cfg?.model || {};
    this.apiKey = stitchApiKey(cfg);
    if (!this.apiKey) {
      throw new Error(
        'provider "stitch" requires STITCH_API_KEY — set it in .env / process.env, or "apiKey" under "model" in cloner.config.json',
      );
    }
    const device = m.stitchDevice || process.env.STITCH_DEVICE || "DESKTOP";
    this.deviceType = DEVICE_TYPES.includes(device) ? device : "DESKTOP";
    this.projectId = m.stitchProject || process.env.STITCH_PROJECT_ID || "";
    this.modelId = MODEL_IDS.includes(m.model) ? m.model : "";
    this.#sdk = null;
    this.#project = null;
    this.screenshotUrl = null;
  }

  // chat(messages, { maxTokens, onDelta, timeoutMs }) — same surface as VisionClient.
  // maxTokens is accepted for surface fidelity but has no Stitch equivalent.
  async chat(messages, { maxTokens = 16000, onDelta, timeoutMs = 300000 } = {}) {
    const prompt = stitchPromptFromMessages(messages);
    if (!prompt.trim()) {
      throw new Error('stitch generation needs text in the prompt — messages contained no text and the SDK cannot accept image uploads');
    }
    const stitch = await this.#stitchFor(timeoutMs);
    const project = await this.#projectFor(stitch);
    const screen = await project.generate(prompt, this.deviceType, this.modelId || undefined);
    const htmlUrl = await screen.getHtml();
    // the download URL is Google-hosted and may require the SAME credential
    // (measured live: bare fetch → 401 UNAUTHENTICATED) — try the authenticated
    // variants first, then a bare fetch for pre-signed URLs.
    const authVariants = [
      { headers: { "x-goog-api-key": this.apiKey } },
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
      { headers: {} },
    ];
    let res = null;
    let lastErr = "no attempt";
    for (const init of authVariants) {
      res = await fetch(htmlUrl, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) break;
      lastErr = `${res.status}: ${(await res.text()).slice(0, 200)}`;
    }
    if (!res || !res.ok) throw new Error(`stitch html download ${lastErr}`);
    let html = await res.text();
    // Stitch serves the screen wrapped in a JSON envelope ({dataString: "<html…"}) —
    // measured live 2026-11-07. Unwrap when present; plain HTML passes through.
    try {
      const parsed = JSON.parse(html);
      if (parsed && typeof parsed.dataString === "string") html = parsed.dataString;
    } catch { /* plain HTML — keep */ }
    try {
      this.screenshotUrl = await screen.getImage();
    } catch {} // screenshot URL is a bonus — never fail the clone over it
    onDelta?.(html);
    return html;
  }

  #sdk;
  #project;

  // One client per StitchClient instance; the MCP transport auto-connects on the
  // first tool call, so construction stays offline.
  async #stitchFor(timeoutMs) {
    if (!this.#sdk) {
      const mod = await loadStitchSdk();
      const client = new mod.StitchToolClient({ apiKey: this.apiKey, timeout: timeoutMs });
      this.#sdk = new mod.Stitch(client);
    }
    return this.#sdk;
  }

  // Reuse STITCH_PROJECT_ID when given (project(id) makes no API call); otherwise
  // create one per client and memoize it so repeated chat() calls stay in it.
  async #projectFor(stitch) {
    if (!this.#project) {
      this.#project = this.projectId ? stitch.project(this.projectId) : await stitch.createProject("cloner image mode");
    }
    return this.#project;
  }
}
