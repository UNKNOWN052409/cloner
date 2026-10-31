// Verifies the VisionClient adapters against a local mock server (no real API needed).
// Checks: openai-compatible request shape, image encoding, response parsing, SSE streaming,
// anthropic request shape (x-api-key), error surfacing.
import http from "node:http";
import { VisionClient, imagePart } from "../src/vision.js";

const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ url: req.url, auth: req.headers["authorization"] || req.headers["x-api-key"], body: JSON.parse(body || "{}") });
    if (req.url.endsWith("/chat/completions")) {
      if (req.headers.authorization !== "Bearer mock-key") return fail(res, 401, "bad auth");
      const b = seen.at(-1).body;
      const img = b.messages?.[0]?.content?.find?.((p) => p.type === "image_url");
      if (!img?.image_url?.url?.startsWith("data:image/")) return fail(res, 400, "image part missing");
      if (b.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of ["VIS", "ION", "_STREAM_OK"]) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        ok(res, { choices: [{ message: { content: "VISION_OPENAI_OK" } }] });
      }
    } else if (req.url.endsWith("/v1/messages")) {
      if (req.headers["x-api-key"] !== "mock-key") return fail(res, 401, "bad auth");
      const b = seen.at(-1).body;
      const img = b.messages?.[0]?.content?.find?.((p) => p.type === "image");
      if (!img?.source?.data || img.source.media_type !== "image/png") return fail(res, 400, "anthropic image part wrong");
      ok(res, { content: [{ type: "text", text: "VISION_ANTHROPIC_OK" }] });
    } else {
      fail(res, 404, "unknown route");
    }
  });
});
function ok(res, json) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(json)); }
function fail(res, code, msg) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: msg } })); }

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const img = await imagePart(process.cwd() + "/output/test3/_reference/clone-verify.png");

let pass = 0, failCount = 0;
const check = (name, cond) => { console.log(cond ? `  ✔ ${name}` : `  ✖ ${name}`); cond ? pass++ : failCount++; };

// 1) openai non-stream
{
  const c = new VisionClient({ model: { provider: "custom", model: "mock-vision", baseUrl: `http://localhost:${port}/v1`, apiKey: "mock-key" } });
  const out = await c.chat([{ role: "user", content: [img, { type: "text", text: "hi" }] }]);
  check("openai-compatible non-stream + image part", out === "VISION_OPENAI_OK");
  const req = seen.at(-1);
  check("auth header Bearer", req.auth === "Bearer mock-key");
  check("model id passed", req.body.model === "mock-vision");
}
// 2) openai stream
{
  const c = new VisionClient({ model: { provider: "custom", model: "mock-vision", baseUrl: `http://localhost:${port}/v1`, apiKey: "mock-key" } });
  let acc = "";
  const out = await c.chat([{ role: "user", content: [img, { type: "text", text: "hi" }] }], { onDelta: (d) => (acc += d) });
  check("SSE streaming assembly", out === "VISION_STREAM_OK" && acc === "VISION_STREAM_OK");
}
// 3) anthropic shape
{
  const c = new VisionClient({ model: { provider: "anthropic", model: "mock-vision", baseUrl: `http://localhost:${port}`, apiKey: "mock-key" } });
  const out = await c.chat([{ role: "user", content: [img, { type: "text", text: "hi" }] }]);
  check("anthropic messages + base64 image", out === "VISION_ANTHROPIC_OK");
  const req = seen.at(-1);
  check("x-api-key header", req.auth === "mock-key");
}
// 4) error surfacing
{
  const c = new VisionClient({ model: { provider: "custom", model: "m", baseUrl: `http://localhost:${port}/v1`, apiKey: "wrong" } });
  try { await c.chat([{ role: "user", content: "x" }]); check("401 surfaces as error", false); }
  catch (e) { check("401 surfaces as error (" + e.message.slice(0, 30) + "…)", /401/.test(e.message)); }
}

server.closeAllConnections?.(); // kill server-side keep-alive sockets
await new Promise((r) => server.close(() => r()));
console.log(`\n${pass} passed, ${failCount} failed`);
// natural drain instead of process.exit(): forced exit raced undici's pooled
// sockets → libuv assert at teardown (exit 127) even though all tests passed
process.exitCode = failCount ? 1 : 0;
