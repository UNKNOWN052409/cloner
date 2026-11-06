#!/usr/bin/env node
process.env.CLONER_ALLOW_PRIVATE_TARGETS = "1"; // G5.3 SSRF guard: loopback fixture only — documented opt-in
// Live-events test (log-driven cloning, end to end). Runs ONE full pipeline job
// in-process against a 127.0.0.1 fixture site (ephemeral port, offline) and
// asserts the two delivery surfaces the user actually watches:
//   • job.log carries EXACTLY ONE stage summary line per stage for ALL FIVE
//     stages (exploration, artifact_validation, reconstruction, verification,
//     export) — not just exploration (evidence: exp-mw56nmaljpke had
//     exploration lines only);
//   • the bus carries job-tagged workflow.* events: reconstruction todo.add per
//     page file with todo.done closure (ok:true or honest ok:false + note),
//     flow-matrix todos closed, workflow.stage running→terminal pairs;
//   • the slug collision is fixed: page-001 ("/") keeps index.html and the
//     "/index.html" route lands in index-2.html (distinct files, no overwrite);
//   • the /ws live whitelist (read from server.js SOURCE) contains the four
//     workflow.* types — the catchup replay shipped them, live traffic didn't;
//   • /progress/:jobId/events (SSE) rejects a FOREIGN-OWNED job id with 404
//     (the same owner gate the artifacts read uses) while an ownerless job id
//     still streams (loopback legacy posture).
// Run: node scripts/test-live-events.mjs   (exit 1 on any failure)
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { runPipelineJob } from "../src/queues/pipeline-job.js";
import { bus } from "../src/events.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT); // exportV2Task resolves artifacts/<id> from cwd — same as the memory queue path

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

// ---- fixture site: the seed "/" plus a "/index.html" twin (the slug collision)
// and a "/pricing" page, joined by a real <nav>. The home button opens a popup
// overlay (class="popup" + real size — the interaction recorder's overlay probe
// only counts visible modal/popup/dialog-class elements) so exploration records
// a trigger behavior the reconstruction wires and the flow matrix replays.
const PAGES = {
  "/": `<!DOCTYPE html><html><head><title>Live Events Home</title><style>
body{font-family:Arial,sans-serif;margin:0;background:#f4f5f7;color:#1c2733}
.nav{background:#1d3557;padding:14px 24px}.nav a{color:#fff;margin-right:18px;text-decoration:none}
main{max-width:720px;margin:32px auto;background:#fff;padding:24px;border:1px solid #ccd}
.popup{display:none;position:fixed;left:20%;top:20%;width:420px;height:180px;background:#eef;border:1px solid #99c;padding:16px;z-index:1000}
</style></head><body>
<div class="nav"><a href="/">Home</a><a href="/index.html">Index alias</a><a href="/pricing">Pricing</a></div>
<main><h1>Live Events Home</h1><p>Seed page with unique home content for the signature check.</p>
<button id="open-panel" onclick="document.getElementById('panel').style.display='block'">Open panel</button>
<div id="panel" class="popup"><h2>Panel opened</h2><p>Panel body recorded by the capture stage.</p></div>
</main></body></html>`,
  "/index.html": `<!DOCTYPE html><html><head><title>Live Events Index Alias</title></head><body>
<div class="nav"><a href="/">Home</a><a href="/pricing">Pricing</a></div>
<main><h1>Index Alias Page</h1><p>This route slugs to "index" and used to OVERWRITE page-001's index.html.</p></main></body></html>`,
  "/pricing": `<!DOCTYPE html><html><head><title>Live Events Pricing</title></head><body>
<div class="nav"><a href="/">Home</a></div>
<main><h1>Pricing</h1><table><tr><th>Plan</th><th>Price</th></tr><tr><td>Basic</td><td>10</td></tr></table>
<p>Pricing page unique content for the signature.</p></main></body></html>`,
};
const fixture = http.createServer((req, res) => {
  const body = PAGES[req.url.split("?")[0]];
  if (body) { res.writeHead(200, { "content-type": "text/html" }); res.end(body); }
  else { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + fixture.address().port;

// ---- capture the bus: every workflow.* emission from the pipeline run ----
const EVENT_TYPES = ["workflow.stage", "workflow.todo.add", "workflow.todo.done", "workflow.agent"];
const captured = [];
const off = EVENT_TYPES.map((t) => { const h = (e) => captured.push(e); bus.on(t, h); return [t, h]; });

// ---- run the FULL pipeline in-process (all five stages) ----
const jobId = "live-events-" + Date.now().toString(36);
const artifactsRoot = path.join(ROOT, "artifacts");
console.log(`live-events test — offline 127.0.0.1 fixture ${base}, job ${jobId}`);
const t0 = Date.now();
let result = null, pipelineError = null;
try {
  result = await runPipelineJob({ url: base + "/", policy: { budgets: { maxRoutes: 3, maxStatesPerPage: 8, maxTotalTimeMs: 90000, maxInteractionsPerState: 8 } } }, { jobId, artifactsRoot });
} catch (e) { pipelineError = e; }
for (const [t, h] of off) bus.off(t, h);

if (pipelineError || !result) {
  check("pipeline completed all five stages", false, String(pipelineError?.message || pipelineError || "no result").slice(0, 200));
} else {
  check("pipeline completed all five stages", ["completed", "completed_with_limitations"].includes(result.status),
    `status=${result.status} reconstruction=${result.reconstruction?.passed} verification=${result.verification?.passed} export=${result.export?.skipped ? "skipped" : "zip"}`);

  // ---- 1. job.log: exactly one stage summary line per stage, all five ----
  const logFile = path.join(artifactsRoot, jobId, "logs", "job.log");
  let recs = [];
  try { recs = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const stageRecs = recs.filter((r) => r.level === "stage");
  const byStage = {};
  for (const r of stageRecs) byStage[r.stage] = (byStage[r.stage] || 0) + 1;
  const FIVE = ["exploration", "artifact_validation", "reconstruction", "verification", "export"];
  for (const st of FIVE) check(`job.log: exactly one "${st}" stage summary`, byStage[st] === 1, `count=${byStage[st] || 0}`);
  const rRec = stageRecs.find((r) => r.stage === "reconstruction");
  check("reconstruction summary carries status + key numbers", !!rRec && typeof rRec.status === "string" && Number.isFinite(Number(rRec.pages)) && Number.isFinite(Number(rRec.files)),
    rRec ? `${rRec.status} pages=${rRec.pages} files=${rRec.files} repairs=${rRec.repairs} limitations=${rRec.limitations}` : "missing");
  const vRec = stageRecs.find((r) => r.stage === "verification");
  check("verification summary carries status + key numbers", !!vRec && typeof vRec.status === "string" && Number.isFinite(Number(vRec.rounds)),
    vRec ? `${vRec.status} rounds=${vRec.rounds} flows_passed=${vRec.flows_passed} flows_failed=${vRec.flows_failed} bugs=${vRec.bugs}` : "missing");
  const eRec = stageRecs.find((r) => r.stage === "export");
  check("export summary carries the deliverable bytes", !!eRec && Number.isFinite(Number(eRec.bytes)) && Number(eRec.bytes) > 0,
    eRec ? `${eRec.status} bytes=${eRec.bytes}` : "missing");

  // ---- 2. bus events: job-tagged, todo closure for reconstruction units ----
  const wfe = captured.filter((e) => (!e.job || e.job === jobId));
  const adds = wfe.filter((e) => e.type === "workflow.todo.add" && String(e.data?.id || "").startsWith("recon:")).map((e) => e.data);
  const dones = wfe.filter((e) => e.type === "workflow.todo.done" && String(e.data?.id || "").startsWith("recon:")).map((e) => e.data);
  check("reconstruction todo.add per page file", adds.length === (result.manifest.pages || 0) && adds.length >= 3,
    `adds=${adds.length} pages=${result.manifest.pages}`);
  const addIds = new Set(adds.map((a) => a.id)), doneIds = new Set(dones.map((d) => d.id));
  check("every reconstruction todo.add gets todo.done", adds.length > 0 && [...addIds].every((id) => doneIds.has(id)),
    `open=${[...addIds].filter((id) => !doneIds.has(id)).join(",") || "none"}`);
  check("reconstruction todos close ok:true or honest ok:false + note",
    dones.every((d) => d.ok === true || (d.ok === false && typeof d.note === "string" && d.note.length > 0)),
    `ok=${dones.filter((d) => d.ok === true).length} failedNote=${dones.filter((d) => d.ok === false).length}`);
  const flowAdds = wfe.filter((e) => e.type === "workflow.todo.add" && String(e.data?.id || "").startsWith("verify:")).map((e) => e.data);
  const flowDones = wfe.filter((e) => e.type === "workflow.todo.done" && String(e.data?.id || "").startsWith("verify:")).map((e) => e.data);
  check("flow-matrix todos closed (one done per flow add)", [...new Set(flowAdds.map((a) => a.id))].every((id) => flowDones.some((d) => d.id === id)),
    `flowAdds=${flowAdds.length} flowDones=${flowDones.length}`);
  check("reconstruction workflow.agent per generated page", wfe.filter((e) => e.type === "workflow.agent").length >= adds.filter((a) => !dones.find((d) => d.id === a.id && d.ok === false)).length,
    `agents=${wfe.filter((e) => e.type === "workflow.agent").length}`);
  const stages = wfe.filter((e) => e.type === "workflow.stage").map((e) => e.data);
  for (const st of ["reconstruction", "verification"]) {
    const s = stages.filter((x) => x.stage === st);
    check(`workflow.stage "${st}" runs running → terminal at progress 1`, s.length >= 2 && s[0].status === "running" && s[s.length - 1].progress === 1,
      s.map((x) => x.status).join(" → ") || "none");
  }

  // ---- 3. slug collision: page-001 keeps index.html, the twin lands in index-2.html ----
  const project = path.join(artifactsRoot, jobId + "-project");
  const indexHtml = fs.existsSync(path.join(project, "index.html")) ? fs.readFileSync(path.join(project, "index.html"), "utf8") : "";
  const index2 = fs.existsSync(path.join(project, "index-2.html")) ? fs.readFileSync(path.join(project, "index-2.html"), "utf8") : "";
  check("index.html exists and is page-001's output", indexHtml.includes('data-page="page-001"'), `${indexHtml.length}B`);
  check('the "/index.html" route landed in a DISTINCT file (index-2.html)', index2.includes('data-page="page-002"') && !index2.includes('data-page="page-001"'), `${index2.length}B`);
  const validation = result.reconstruction ? [] : [];
  try { validation.push(...(JSON.parse(fs.readFileSync(path.join(project, "reconstruction-report.json"), "utf8")).validation || [])); } catch {}
  const files = validation.map((v) => v.file);
  check("validation rows carry distinct file names (no overwrite)", new Set(files).size === files.length && files.filter(Boolean).length >= 3, files.join(", "));
  check("links rewritten to the clone (no absolute fixture hrefs left)",
    !indexHtml.includes(`href="${base}`) && !index2.includes(`href="${base}`), "index.html + index-2.html scanned");
}

// ---- 4. /ws live whitelist (read from server.js SOURCE, per the ask) ----
const serverSrc = fs.readFileSync(path.join(ROOT, "src", "platform", "server.js"), "utf8");
let whitelist = null;
for (const m of serverSrc.matchAll(/for \(const evt of \[([\s\S]*?)\]\)/g)) {
  const types = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (types.includes("step")) whitelist = types; // the engine-progress loop is THE whitelist
}
check("server.js /ws whitelist exists (engine events present)", Array.isArray(whitelist) && whitelist.includes("step"), (whitelist || []).join(","));
for (const t of EVENT_TYPES) check(`/ws whitelist carries "${t}"`, !!whitelist?.includes(t));

// ---- 5. /progress SSE ownership: foreign-owned job → 404, ownerless → streams ----
try {
  const { startPlatform } = await import("../src/platform/server.js");
  const { getCloneQueue } = await import("../src/queues/clone-queue.js");
  const platform = await startPlatform({ port: 0 });
  const P = `http://127.0.0.1:${platform.port}`;
  // a job owned by someone else: enqueued with a no-op run — the queue singleton
  // is never resolved in this process, so the entry stays "queued" (no execution)
  const foreignJob = "sse-owned-" + Date.now().toString(36);
  getCloneQueue().enqueue({ payload: { url: "http://127.0.0.1:9/" }, run: async () => {}, jobId: foreignJob, owner: { userId: "sse-owner-u1" } });
  const resForeign = await fetch(`${P}/progress/${foreignJob}/events`);
  check("/progress SSE rejects a foreign-owned job id with 404", resForeign.status === 404, `status=${resForeign.status}`);
  await resForeign.body?.cancel().catch(() => {});
  // the ownerless pipeline job keeps the loopback legacy posture: the stream opens
  const ac = new AbortController();
  const resOwn = await fetch(`${P}/progress/${jobId}/events`, { signal: ac.signal });
  let firstChunk = "";
  if (resOwn.ok && resOwn.body) {
    const reader = resOwn.body.getReader();
    const { value } = await reader.read();
    firstChunk = new TextDecoder().decode(value || new Uint8Array());
    await reader.cancel().catch(() => {});
  }
  check("/progress SSE still streams for an ownerless job id (legacy posture)", resOwn.status === 200 && firstChunk.includes("event: hello"),
    `status=${resOwn.status} first=${JSON.stringify(firstChunk.slice(0, 40))}`);
  ac.abort();
  platform.server.close();
} catch (e) {
  check("/progress SSE ownership gate reachable", false, String(e?.message || e).slice(0, 160));
}

fixture.close();
const totalS = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n=== live-events test: ${pass} PASS / ${fail} FAIL (of ${pass + fail}) — ${totalS}s ===`);
process.exit(fail ? 1 : 0);
