// Video → understand → clone. ffmpeg keyframes + (optional) Whisper transcript.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { bus } from "./events.js";
import { VisionClient, imagePart } from "./vision.js";
import { SYSTEM_CLONER, CLONE_FROM_VIDEO } from "./prompts.js";
import { extractParts } from "./cloneImage.js";

function ff(cmd) {
  const bin = cmd === "ffprobe" ? "ffprobe" : "ffmpeg";
  try {
    return spawnSync(bin, ["-version"], { encoding: "utf8" }).status === 0 ? bin : null;
  } catch {
    return null;
  }
}

export async function cloneVideo(videoPath, cfg, outDir, opts = {}) {
  if (cfg.model.provider === "none" || !cfg.model.apiKey) {
    throw new Error("video mode needs a vision model — set OPENAI_API_KEY / ANTHROPIC_API_KEY or cloner.config.json");
  }
  fs.mkdirSync(outDir, { recursive: true });
  const ref = path.join(outDir, "_reference");
  fs.mkdirSync(ref, { recursive: true });

  const ffmpeg = ff("ffmpeg");
  const ffprobe = ff("ffprobe");
  if (!ffmpeg) throw new Error("ffmpeg not found on PATH (winget install Gyan.FFmpeg)");

  // ---- duration ----
  let duration = 0;
  try {
    const out = execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath], { encoding: "utf8" });
    duration = parseFloat(out.trim()) || 0;
  } catch {}
  if (!duration) duration = 60;
  bus.emit("step", { id: "video", status: "start", msg: `video ${Math.round(duration)}s — extracting frames` });

  // ---- frames ----
  const maxFrames = cfg.video?.maxFrames || 16;
  const step = cfg.video?.frameSeconds || Math.max(1.5, duration / maxFrames);
  const fpsFilter = `fps=1/${step.toFixed(2)},scale='min(1280,iw)':-2`;
  execFileSync(ffmpeg, ["-y", "-i", videoPath, "-vf", fpsFilter, "-q:v", "3", path.join(ref, "frame-%03d.jpg")], { stdio: "ignore" });
  let frames = fs.readdirSync(ref).filter((f) => /^frame-\d+\.jpg$/.test(f)).sort().slice(0, maxFrames);
  if (!frames.length) throw new Error("no frames extracted — unsupported codec?");
  bus.emit("step", { id: "video", status: "done", msg: `${frames.length} frames` });

  // ---- audio + transcript ----
  let transcript = null;
  const wav = path.join(ref, "audio.wav");
  execFileSync(ffmpeg, ["-y", "-i", videoPath, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", wav], { stdio: "ignore" });
  if (fs.existsSync(wav) && fs.statSync(wav).size > 10000) {
    bus.emit("step", { id: "asr", status: "start", msg: "transcribing narration…" });
    try {
      const client = new VisionClient(cfg);
      transcript = await client.transcribe(wav);
      bus.emit("step", { id: "asr", status: transcript ? "done" : "skip", msg: transcript ? `${transcript.length} chars of speech` : "no ASR provider" });
      bus.emit("transcript", { transcript });
    } catch (e) {
      bus.emit("step", { id: "asr", status: "warn", msg: `ASR failed: ${e.message.slice(0, 80)}` });
    }
  } else {
    bus.emit("step", { id: "asr", status: "skip", msg: "no audio track" });
  }

  // ---- vision ----
  // even sample up to 12 frames to stay in context
  const useFrames = frames.length > 12 ? evenSample(frames, 12) : frames;
  bus.emit("step", { id: "vision", status: "start", msg: `${cfg.model.provider}/${cfg.model.model} watching ${useFrames.length} frames` });
  const client = new VisionClient(cfg);
  const parts = [];
  for (const f of useFrames) parts.push(await imagePart(path.join(ref, f)));
  parts.push({ type: "text", text: CLONE_FROM_VIDEO(transcript, useFrames.length, duration) });

  let out = "";
  try {
    out = await client.chat(
      [
        { role: "system", content: SYSTEM_CLONER },
        { role: "user", content: parts },
      ],
      {
        maxTokens: 24000,
        onDelta: (d) => {
          out += d;
          if (out.length % 1500 < d.length) bus.emit("model:progress", { chars: out.length });
        },
      },
    );
  } catch (e) {
    // context too big? retry with fewer frames
    if (out.length === 0 && useFrames.length > 6) {
      bus.emit("log", { level: "warn", msg: `retrying with 6 frames (${e.message.slice(0, 80)})` });
      const fewer = evenSample(frames, 6);
      const retryParts = [];
      for (const f of fewer) retryParts.push(await imagePart(path.join(ref, f)));
      retryParts.push({ type: "text", text: CLONE_FROM_VIDEO(transcript, fewer.length, duration) });
      out = await client.chat([{ role: "system", content: SYSTEM_CLONER }, { role: "user", content: retryParts }], { maxTokens: 20000 });
    } else throw e;
  }

  const { html, brief } = extractParts(out || "");
  if (!html) throw new Error("model returned no HTML");
  fs.writeFileSync(path.join(outDir, "index.html"), html);
  fs.writeFileSync(path.join(outDir, "brief.md"), brief || "_no brief returned_");
  fs.writeFileSync(
    path.join(outDir, "clone.json"),
    JSON.stringify({ mode: "video", source: videoPath, durationSec: duration, frames: useFrames, generatedAt: new Date().toISOString(), pages: [{ file: "index.html", screenshot: null }] }, null, 2),
  );
  bus.emit("step", { id: "vision", status: "done", msg: `clone + brief written (${html.length.toLocaleString()} bytes)` });
  bus.emit("brief", { brief });
  bus.emit("run:done", { outDir, pages: 1, assets: 0 });
  return { outDir, brief };
}

function evenSample(arr, n) {
  if (arr.length <= n) return arr;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}
