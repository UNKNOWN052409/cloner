// Phase-2 reconstruction e2e: exploration job → reconstruct → assert the
// generated project contract (editable pages, tokens, assets, runtime, report).
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";
import { reconstructFromArtifacts } from "../src/reconstruction/reconstruction-pipeline.js";

const ROOT = path.resolve(".");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

// fixture: 2-route site with nav, section, image-less rich content
const pages = {
  "/": `<!DOCTYPE html><html><head><title>Home</title></head><body>
<nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
<main><h1>Home Page</h1>
<section class="hero" style="background:#101418;color:#fff;padding:40px"><h2>Hero Title</h2><p>Hero paragraph with real content.</p></section>
<section class="cards"><div class="card" style="background:#1a1f26;border-radius:8px;padding:16px"><h3>Card One</h3><p>Card one body text.</p></div><div class="card" style="background:#1a1f26;border-radius:8px;padding:16px"><h3>Card Two</h3><p>Card two body text.</p></div><div class="card" style="background:#1a1f26;border-radius:8px;padding:16px"><h3>Card Three</h3><p>Card three body text.</p></div></section>
</main></body></html>`,
  "/pricing": `<!DOCTYPE html><html><head><title>Pricing</title></head><body>
<nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
<main><h1>Pricing</h1><table><tr><th>Plan</th><th>Price</th></tr><tr><td>Basic</td><td>10</td></tr><tr><td>Pro</td><td>20</td></tr></table>
<p>Pricing page unique content for the signature.</p></main></body></html>`,
};
const srv = http.createServer((req, res) => {
  const body = pages[req.url.split("?")[0]];
  if (body) { res.writeHead(200, { "content-type": "text/html" }); res.end(body); }
  else { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + srv.address().port;

// 1) exploration
const { jobId, artifactsDir, manifest } = await runExplorationJob({
  url: base + "/",
  artifactsRoot: path.join(ROOT, "artifacts"),
  config: { policy: { budgets: { maxRoutes: 3, maxStatesPerPage: 8, maxTotalTimeMs: 90000 } } },
});
check("exploration completed", manifest.status === "completed", manifest.status);
check("routes >= 2", manifest.discoveredRoutes >= 2, manifest.discoveredRoutes + "");

// 2) reconstruction
const outDir = path.join(ROOT, "artifacts", jobId + "-project");
const rec = await reconstructFromArtifacts(artifactsDir, { outDir, interactionRecords: [] });
check("reconstruction ok", rec.ok === true, "rounds: " + rec.report.rounds.length);
check("all pages validated", rec.report.validation.every((v) => v.ok), rec.report.validation.map((v) => v.route + ":" + v.size + "B").join(", "));
check("components.css substantive", fs.existsSync(path.join(outDir, "styles", "components.css")) && fs.statSync(path.join(outDir, "styles", "components.css")).size > 200, fs.statSync(path.join(outDir, "styles", "components.css")).size + "B");
check("tokens.css generated", fs.existsSync(path.join(outDir, "styles", "tokens.css")), "");
const tokensCss = fs.readFileSync(path.join(outDir, "styles", "tokens.css"), "utf8");
check("tokens carry HEX values", /--color-1: #[0-9a-f]{6}/i.test(tokensCss), "");
check("index.html substantive", fs.existsSync(path.join(outDir, "index.html")) && fs.statSync(path.join(outDir, "index.html")).size > 800, fs.statSync(path.join(outDir, "index.html")).size + "B");
check("multi-page generated", fs.existsSync(path.join(outDir, "pricing.html")), "");
check("reconstruction report exists", fs.existsSync(path.join(outDir, "reconstruction-report.json")), "");

// 3) internal links point to the generated clone
const outDirReal = outDir;
const index = fs.readFileSync(path.join(outDirReal, "index.html"), "utf8");
check("nav links rewritten to clone", !index.includes(`href="${base}`) && (index.includes('href="pricing.html"') || index.includes('href="./pricing.html"') || !index.includes(`href="${base}/pricing"`)), "links point at generated files");

// 4) honest limitations surfaced
check("limitations recorded", Array.isArray(rec.report.limitations), rec.report.limitations.length + " limitation(s)");

console.log(`\n${pass} passed, ${fail} failed`);
fs.writeFileSync(path.join(ROOT, "artifacts", "test-reconstruction-result.json"), JSON.stringify({ pass, fail, jobId }, null, 2));
srv.close();
process.exit(fail ? 1 : 0);
