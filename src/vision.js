// Pluggable vision-model client. Providers:
//  - anthropic        (ANTHROPIC_API_KEY [+ ANTHROPIC_BASE_URL])
//  - openai           (OPENAI_API_KEY, api.openai.com — also used for whisper ASR)
//  - custom           (any OpenAI-compatible endpoint: baseUrl + apiKey + model)
//  - none             (model-dependent steps are skipped gracefully)

export function hasVision(cfg) {
  return cfg.model.provider !== "none" && !!cfg.model.apiKey;
}

function imageDataUrl(part) {
  return part.type === "image" ? part.dataUrl : null;
}

export class VisionClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.provider = cfg.model.provider;
    this.model = cfg.model.model;
    this.apiKey = cfg.model.apiKey;
    this.baseUrl = (cfg.model.baseUrl || "").replace(/\/+$/, "");
  }

  get openaiBase() {
    return this.baseUrl || "https://api.openai.com/v1";
  }
  get anthropicBase() {
    return (this.baseUrl || "https://api.anthropic.com").replace(/\/v1$/, "");
  }

  // messages: [{ role: "user"|"assistant", content: string | parts[] }]
  // parts:    { type:"text", text } | { type:"image", dataUrl, mediaType }
  async chat(messages, { maxTokens = 16000, onDelta, timeoutMs = 300000 } = {}) {
    if (this.provider === "anthropic") return this.#anthropic(messages, maxTokens, onDelta, timeoutMs);
    return this.#openaiCompatible(messages, maxTokens, onDelta, timeoutMs);
  }

  async #openaiCompatible(messages, maxTokens, onDelta, timeoutMs) {
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      stream: !!onDelta,
      messages: messages.map((m) => ({
        role: m.role,
        content: Array.isArray(m.content)
          ? m.content.map((p) =>
              p.type === "image"
                ? { type: "image_url", image_url: { url: p.dataUrl } }
                : { type: "text", text: p.text },
            )
          : m.content,
      })),
    };
    let res;
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        res = await fetch(`${this.openaiBase}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        throw e;
      }
      // NOTE: timer intentionally NOT cleared yet — it must stay alive to abort a
      // stalled SSE body stream; it is cleared after the stream is consumed below.
      // free relays flap — retry gateway/server errors once with a short backoff
      if ([500, 502, 503, 524].includes(res.status) && attempt < 1) {
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }
      this._activeTimer = timer; // cleared post-stream (see chat() tail)
      break;
    }
    if (!res.ok) {
      if (this._activeTimer) clearTimeout(this._activeTimer);
      throw new Error(`${this.provider} API ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    if (!onDelta) {
      if (this._activeTimer) clearTimeout(this._activeTimer);
      const json = await res.json();
      return json.choices?.[0]?.message?.content || "";
    }
    let out = "";
    // keep the abort timer alive while the SSE body streams — a stalled stream after
    // headers must still hit the deadline instead of hanging the read loop forever
    for await (const evt of sseLines(res.body)) {
      if (evt === "[DONE]") break;
      try {
        const j = JSON.parse(evt);
        const d = j.choices?.[0]?.delta?.content;
        if (d) {
          out += d;
          onDelta(d);
        }
      } catch {}
    }
    if (this._activeTimer) clearTimeout(this._activeTimer);
    return out;
  }

  async #anthropic(messages, maxTokens, onDelta, timeoutMs) {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") : m.content))
      .join("\n\n");
    const conv = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role,
        content: Array.isArray(m.content)
          ? m.content.map((p) => {
              if (p.type === "image") {
                const [, , b64] = p.dataUrl.match(/^data:([^;]+);base64,(.*)$/) || [];
                return { type: "image", source: { type: "base64", media_type: p.mediaType || b64 && "image/png", data: b64 } };
              }
              return { type: "text", text: p.text };
            })
          : m.content,
      }));
    const body = { model: this.model, max_tokens: maxTokens, messages: conv, stream: !!onDelta };
    if (system) body.system = system;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${this.anthropicBase}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
    // timer stays alive across the SSE body read (stall-safe); cleared on all exits
    if (!res.ok) {
      clearTimeout(timer);
      throw new Error(`anthropic API ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    if (!onDelta) {
      clearTimeout(timer);
      const json = await res.json();
      return (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    }
    let out = "";
    // keep the abort timer alive while the SSE body streams (stall-safe)
    for await (const evt of sseLines(res.body)) {
      try {
        const j = JSON.parse(evt);
        if (j.type === "content_block_delta" && j.delta?.text) {
          out += j.delta.text;
          onDelta(j.delta.text);
        }
      } catch {}
    }
    clearTimeout(timer);
    return out;
  }

  // Audio transcription via OpenAI whisper (only provider with a stable ASR endpoint).
  async transcribe(wavPath) {
    if (this.provider === "none") return null;
    const key = this.provider === "openai" ? this.apiKey : process.env.OPENAI_API_KEY;
    if (!key) return null;
    const { readFile } = await import("node:fs/promises");
    const fd = new FormData();
    fd.append("file", new Blob([await readFile(wavPath)], { type: "audio/wav" }), "audio.wav");
    fd.append("model", "whisper-1");
    const res = await fetch(`${this.openaiBase}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: fd,
    });
    if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    return json.text || "";
  }
}

async function* sseLines(stream) {
  const reader = stream.getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

// ---------- shared helpers ----------

const MEDIA_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export async function imagePart(p) {
  const ext = p.split(".").pop().toLowerCase();
  const mediaType = MEDIA_TYPES[ext] || "image/png";
  const { readFile } = await import("node:fs/promises");
  const b64 = (await readFile(p)).toString("base64");
  return { type: "image", dataUrl: `data:${mediaType};base64,${b64}`, mediaType };
}
