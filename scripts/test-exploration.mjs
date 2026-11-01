// Phase-1 exploration pipeline test: multi-route fixture site (home + SPA-ish
// pages + modal + tabs) → runExplorationJob → assert the §15 artifact contract.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { runExplorationJob } from "../src/pipeline/exploration-pipeline.js";

const ROOT = path.resolve(".");
const outDir = path.join(ROOT, "artifacts");
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

// ---- fixture: 3-route site with modal + tabs ----
const page = (title, extra) => `<!DOCTYPE html><html><head><title>${title}</title></head><body>
<nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>
<h1>${title}</h1>${extra || ""}
<script>
function openModal(){ document.getElementById('modal').style.display='block'; }
function selectTab(t){ document.querySelectorAll('.tabpane').forEach(p=>p.style.display='none'); document.getElementById('pane-'+t).style.display='block'; document.querySelectorAll('.tabbtn').forEach(b=>b.classList.remove('active')); document.querySelector('.tabbtn[data-t='+t+']').classList.add('active'); }
</script>
</body></html>`;

const pages = {
  "/": page("Home", `<button class="btn" onclick="openModal()">Open Modal</button>
<div id='modal' style='display:none' class='modal'><h2>Settings Modal</h2><form><label>Name <input name='n'></label><label>Email <input name='e' type='email'></label><select><option>Option A</option><option>Option B</option></select><label><input type='checkbox'> Subscribe</label></form><button onclick='this.parentElement.style.display="none"'>Close</button></div>
<div><button class="tabbtn active" data-t="1" onclick="selectTab(1)">Tab 1</button><button class="tabbtn" data-t="2" onclick="selectTab(2)">Tab 2</button>
<div class="tabpane" id="pane-1">Pane 1 content</div><div class="tabpane" id="pane-2" style="display:none">Pane 2 content</div></div>
<p>Some unique home content for the signature.</p>`),
  "/about": page("About", "<p>About page unique content.</p>"),
  "/contact": page("Contact", "<p>Contact page unique content.</p>"),
};

const srv = http.createServer((req, res) => {
  const key = req.url === "/" ? "/" : req.url.split("?")[0];
  const body = pages[key];
  if (body) { res.writeHead(200, { "content-type": "text/html" }); res.end(body); }
  else { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + srv.address().port;

// ---- run the pipeline ----
const t0 = Date.now();
const { jobId, artifactsDir, manifest } = await runExplorationJob({
  url: base + "/",
  artifactsRoot: path.join(ROOT, "artifacts"),
  config: { policy: { budgets: { maxRoutes: 4, maxStatesPerPage: 10, maxTotalTimeMs: 120000 } } },
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// ---- assertions ----
check("job completed", manifest.status === "completed", manifest.status);
check("routes >= 3 discovered", manifest.discoveredRoutes >= 3, manifest.discoveredRoutes + " routes");
check("pages explored >= 3", manifest.pages.length >= 3, manifest.pages.map((p) => p.pageId).join(","));
check("states recorded (graph nodes >= pages + modal/tab)", manifest.discoveredStates >= 5, manifest.discoveredStates + " states");
check("interactions recorded (edges >= 3)", manifest.discoveredInteractions >= 3, manifest.discoveredInteractions + " edges");
check("manifest schemaVersion", manifest.schemaVersion === "1.0.0", manifest.schemaVersion);
check("no credentials in manifest", !JSON.stringify(manifest).match(/"password"|ZZCRED-FRAGMENT|sk-[a-z0-9]{20}/i), "redacted/clean");
check("coverage report exists", fs.existsSync(path.join(artifactsDir, "reports", "coverage-report.json")));
check("graph files exist", ["routes.json", "states.json", "transitions.json"].every((f) => fs.existsSync(path.join(artifactsDir, "graph", f))));
check("page-1 dom.json exists", fs.existsSync(path.join(artifactsDir, "pages", "page-001", "dom.json")));
check("page-1 styles.json exists", fs.existsSync(path.join(artifactsDir, "pages", "page-001", "styles.json")));
check("page-1 geometry.json exists", fs.existsSync(path.join(artifactsDir, "pages", "page-001", "geometry.json")));
check("page-1 network.json exists", fs.existsSync(path.join(artifactsDir, "pages", "page-001", "network.json")));
check("page-1 screenshot exists", fs.existsSync(path.join(artifactsDir, "pages", "page-001", "screenshot-viewport.png")));
check("asset manifest exists", fs.existsSync(path.join(artifactsDir, "assets", "manifest.json")));
check("exploration finished under 120s", Number(elapsed) < 120, elapsed + "s");

console.log(`\n${pass} passed, ${fail} failed — pipeline took ${elapsed}s`);
fs.writeFileSync(path.join(ROOT, "artifacts", "test-exploration-result.json"), JSON.stringify({ pass, fail, jobId, elapsed, manifest: { status: manifest.status, routes: manifest.discoveredRoutes, states: manifest.discoveredStates } }, null, 2));
srv.close();
process.exit(fail ? 1 : 0);
