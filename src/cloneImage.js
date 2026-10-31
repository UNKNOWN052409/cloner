// Image → code (Stitch-style single shot).
import fs from "node:fs";
import path from "node:path";
import { bus } from "./events.js";
import { VisionClient, imagePart } from "./vision.js";
import { SYSTEM_CLONER, CLONE_FROM_IMAGE } from "./prompts.js";

export async function cloneImage(imgPath, cfg, outDir, opts = {}) {
  if (cfg.model.provider === "none" || !cfg.model.apiKey) {
    throw new Error("image mode needs a vision model — set OPENAI_API_KEY / ANTHROPIC_API_KEY or cloner.config.json");
  }
  fs.mkdirSync(outDir, { recursive: true });
  const ref = path.join(outDir, "_reference");
  fs.mkdirSync(ref, { recursive: true });
  fs.copyFileSync(imgPath, path.join(ref, "source" + path.extname(imgPath)));

  bus.emit("step", { id: "vision", status: "start", msg: `analyzing with ${cfg.model.provider}/${cfg.model.model}` });
  const client = new VisionClient(cfg);
  const img = await imagePart(imgPath);

  let streamed = "";
  const html = await client.chat(
    [
      { role: "system", content: SYSTEM_CLONER },
      { role: "user", content: [img, { type: "text", text: CLONE_FROM_IMAGE({ hint: opts.hint }) }] },
    ],
    {
      maxTokens: 24000,
      onDelta: (d) => {
        streamed += d;
        if (streamed.length % 1500 < d.length) bus.emit("model:progress", { chars: streamed.length });
      },
    },
  );

  const code = extractHtml(html || streamed);
  if (!code) throw new Error("model returned no HTML block");
  fs.writeFileSync(path.join(outDir, "index.html"), code);
  fs.writeFileSync(
    path.join(outDir, "clone.json"),
    JSON.stringify({ mode: "image", source: imgPath, generatedAt: new Date().toISOString(), pages: [{ file: "index.html", screenshot: "_reference/" + path.basename(path.join(ref, "source" + path.extname(imgPath))) }] }, null, 2),
  );
  bus.emit("step", { id: "vision", status: "done", msg: `${code.length.toLocaleString()} bytes of HTML` });
  bus.emit("run:done", { outDir, pages: 1, assets: 0 });
  return { outDir };
}

export function extractHtml(text) {
  const m = text.match(/```html\s*([\s\S]*?)```/i) || text.match(/```\s*<!DOCTYPE([\s\S]*?)```/i);
  if (m) {
    let code = m[1].trim();
    if (/^<!DOCTYPE/i.test(code) === false && /^<html/i.test(code) === false) code = "<!DOCTYPE html>\n" + code;
    if (/^<!DOCTYPE/i.test(code) === false && !/^<html/i.test(code)) return null;
    return code;
  }
  if (/<html[\s>]/i.test(text)) {
    const start = text.indexOf("<!DOCTYPE") >= 0 ? text.indexOf("<!DOCTYPE") : text.search(/<html[\s>]/i);
    const end = text.lastIndexOf("</html>");
    if (end > start) return text.slice(start, end + 7);
  }
  return null;
}

export function extractParts(text) {
  // returns { html, brief } for video mode output
  let brief = null;
  let body = text;
  const bIdx = text.indexOf("---BRIEF---");
  if (bIdx >= 0) {
    brief = text.slice(bIdx + 11).trim();
    body = text.slice(0, bIdx);
  }
  return { html: extractHtml(body), brief };
}
