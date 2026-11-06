// Stitch provider tests (image→code backend) — fully OFFLINE.
// Covers: provider selection, missing-key config error, missing-package error path,
// the text-prompt mapping, and that provider "none"/openai/anthropic paths are
// unchanged. No network calls: chat() is only ever invoked with image-only messages,
// which fails before any SDK/network work, and the SDK import is exercised via a
// bogus specifier and from a temp dir where @google/stitch-sdk does not resolve.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { VisionClient, hasVision, imagePart } from "../src/vision.js";
import { StitchClient, stitchPromptFromMessages, loadStitchSdk } from "../src/stitch-client.js";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (detail ? " — " + detail : "")); }
}
const savedKey = process.env.STITCH_API_KEY;
delete process.env.STITCH_API_KEY;
try {
  // ── 1. hasVision selection ────────────────────────────────────────────────
  check("hasVision: none → false", hasVision({ model: { provider: "none", apiKey: "" } }) === false);
  check("hasVision: openai + key → true", hasVision({ model: { provider: "openai", apiKey: "k" } }) === true);
  check("hasVision: openai no key → false", hasVision({ model: { provider: "openai", apiKey: "" } }) === false);
  check("hasVision: custom + key → true", hasVision({ model: { provider: "custom", apiKey: "k" } }) === true);
  check("hasVision: stitch + cfg key → true", hasVision({ model: { provider: "stitch", apiKey: "sk-stitch" } }) === true);
  process.env.STITCH_API_KEY = "sk-env";
  check("hasVision: stitch + env key → true", hasVision({ model: { provider: "stitch", apiKey: "" } }) === true);
  delete process.env.STITCH_API_KEY;
  check("hasVision: stitch no key anywhere → false", hasVision({ model: { provider: "stitch", apiKey: "" } }) === false);

  // ── 2. VisionClient construction / selection (unchanged providers included) ──
  const scfg = { model: { provider: "stitch", apiKey: "sk-stitch" } };
  const sv = new VisionClient(scfg);
  check("select: stitch provider kept", sv.provider === "stitch" && sv.apiKey === "sk-stitch");
  process.env.STITCH_API_KEY = "sk-env";
  const sve = new VisionClient({ model: { provider: "stitch", apiKey: "" } });
  check("select: stitch key from env", sve.apiKey === "sk-env");
  delete process.env.STITCH_API_KEY;

  const oc = new VisionClient({ model: { provider: "openai", model: "gpt-4o", apiKey: "k" } });
  check("unchanged: openai selection", oc.provider === "openai" && oc.model === "gpt-4o" && oc.openaiBase === "https://api.openai.com/v1");
  const cc = new VisionClient({ model: { provider: "custom", apiKey: "k", baseUrl: "http://127.0.0.1:20130/v1/" } });
  check("unchanged: custom baseUrl strip", cc.provider === "custom" && cc.openaiBase === "http://127.0.0.1:20130/v1");
  const ac = new VisionClient({ model: { provider: "anthropic", apiKey: "k" } });
  check("unchanged: anthropic base", ac.provider === "anthropic" && ac.anthropicBase === "https://api.anthropic.com");
  const nc = new VisionClient({ model: { provider: "none", apiKey: "" } });
  check("unchanged: none provider kept", nc.provider === "none" && hasVision(nc.cfg) === false);

  // ── 3. missing-key error: clear message, no silent fallback ──────────────
  try {
    new VisionClient({ model: { provider: "stitch", apiKey: "" } });
    check("missing key: VisionClient throws", false, "constructed without error");
  } catch (e) {
    check("missing key: VisionClient throws", e.message.includes("STITCH_API_KEY") && e.message.includes("stitch"), e.message);
  }
  try {
    new StitchClient({ model: { provider: "stitch" } });
    check("missing key: StitchClient throws", false, "constructed without error");
  } catch (e) {
    check("missing key: StitchClient throws", e.message.includes("STITCH_API_KEY"), e.message);
  }

  // ── 4. missing-package error path ─────────────────────────────────────────
  // (a) direct: bogus specifier exercises the same catch branch as a real absence
  try {
    await loadStitchSdk("cloner-test-no-such-stitch-pkg");
    check("missing pkg: loadStitchSdk rejects", false, "resolved");
  } catch (e) {
    check("missing pkg: loadStitchSdk rejects", /@google\/stitch-sdk/.test(e.message) && /npm install/.test(e.message), e.message);
  }
  // (b) end-to-end: run the real default import from a temp dir where the package
  //     does not resolve (stitch-client.js is self-contained, so the copy is honest)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stitch-pkg-missing-"));
  fs.copyFileSync(new URL("../src/stitch-client.js", import.meta.url), path.join(tmp, "stitch-client.js"));
  fs.writeFileSync(
    path.join(tmp, "driver.mjs"),
    `import { loadStitchSdk } from "./stitch-client.js";
     try { await loadStitchSdk(); console.log("RESOLVED"); }
     catch (e) { console.log("ERR: " + e.message); }`,
  );
  const out = execFileSync(process.execPath, [path.join(tmp, "driver.mjs")], { cwd: tmp, encoding: "utf8" });
  check("missing pkg: real import fails with config error", /@google\/stitch-sdk/.test(out) && /npm install/.test(out), out.trim());
  fs.rmSync(tmp, { recursive: true, force: true });

  // ── 5. text-prompt mapping: image parts dropped, text parts joined in order ──
  const prompt = stitchPromptFromMessages([
    { role: "system", content: "SYS PROMPT" },
    { role: "user", content: [{ type: "image", dataUrl: "data:image/png;base64,AAAA" }, { type: "text", text: "USER TEXT" }] },
  ]);
  check("prompt: system + user text joined", prompt.includes("SYS PROMPT") && prompt.includes("USER TEXT"), JSON.stringify(prompt));
  check("prompt: image dataUrl dropped", !prompt.includes("AAAA") && !prompt.includes("data:image"));
  check("prompt: empty messages → empty prompt", stitchPromptFromMessages([]) === "");
  check("prompt: plain string content kept", stitchPromptFromMessages([{ role: "user", content: "hello" }]) === "hello");

  // ── 6. offline dispatch: stitch chat with image-only messages fails clearly ──
  // (fails in stitch-client before any SDK or network work — proves the dispatch
  // reaches the stitch backend instead of the openai/anthropic fetch paths)
  try {
    await sv.chat([{ role: "user", content: [{ type: "image", dataUrl: "data:image/png;base64,AAAA" }] }], { maxTokens: 100 });
    check("dispatch: image-only stitch chat errors clearly", false, "no error");
  } catch (e) {
    check("dispatch: image-only stitch chat errors clearly", /needs text in the prompt/.test(e.message), e.message);
  }
  // same call through VisionClient with env-only key
  process.env.STITCH_API_KEY = "sk-env";
  try {
    await sve.chat([{ role: "user", content: [{ type: "image", dataUrl: "data:image/png;base64,AAAA" }] }]);
    check("dispatch: env-key stitch instance wired", false, "no error");
  } catch (e) {
    check("dispatch: env-key stitch instance wired", /needs text in the prompt/.test(e.message), e.message);
  }
  delete process.env.STITCH_API_KEY;

  // ── 7. device/model option plumbing ───────────────────────────────────────
  const d1 = new StitchClient({ model: { provider: "stitch", apiKey: "k" } });
  check("opts: device defaults to DESKTOP", d1.deviceType === "DESKTOP");
  process.env.STITCH_DEVICE = "MOBILE";
  const d2 = new StitchClient({ model: { provider: "stitch", apiKey: "k" } });
  check("opts: STITCH_DEVICE env override", d2.deviceType === "MOBILE");
  delete process.env.STITCH_DEVICE;
  const d3 = new StitchClient({ model: { provider: "stitch", apiKey: "k", stitchDevice: "TABLET" } });
  check("opts: cfg stitchDevice wins", d3.deviceType === "TABLET");
  const d4 = new StitchClient({ model: { provider: "stitch", apiKey: "k", stitchDevice: "BOGUS" } });
  check("opts: bogus device falls back to DESKTOP", d4.deviceType === "DESKTOP");
  const d5 = new StitchClient({ model: { provider: "stitch", apiKey: "k", model: "GEMINI_3_FLASH" } });
  check("opts: stitch model id mapped", d5.modelId === "GEMINI_3_FLASH");
  const d6 = new StitchClient({ model: { provider: "stitch", apiKey: "k", model: "gpt-4o" } });
  check("opts: non-stitch model ignored", d6.modelId === "");
  const d7 = new StitchClient({ model: { provider: "stitch", apiKey: "k", stitchProject: "123" } });
  check("opts: project id from cfg", d7.projectId === "123");
} finally {
  if (savedKey === undefined) delete process.env.STITCH_API_KEY;
  else process.env.STITCH_API_KEY = savedKey;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
