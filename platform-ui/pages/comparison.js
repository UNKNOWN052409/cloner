// Page 7 page-script — comparison & QA.
// Reads (all via GET /api/jobs/:jobId/artifacts/*, src/platform/server.js:703):
//   pages/page-001/screenshot-viewport.png   — original exploration screenshot
//   _reference/clone-verify.png              — rendered clone screenshot (scripts/compare-clone.mjs:37)
//   _reference/diff.png                      — pixel-diff heatmap overlay
//   _reference/verification.json             — stage results (src/reconstruction/verify.js:764)
//   reports/flow-matrix.json                 — { flows, bugs } (src/reconstruction/verify-flows.js:343)
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const params = new URLSearchParams(location.search);
const jobId = params.get("job") || params.get("id") || "";
const artifactUrl = (p) => `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${p}`;

async function getJson(path) {
  const res = await fetch(artifactUrl(path)).catch(() => null);
  if (!res || !res.ok) return { status: res ? res.status : 0, data: null };
  return { status: res.status, data: await res.json().catch(() => null) };
}

// stage cards — verification.json stages carry {stage, passed, checks:[{name, ok, detail}]}
function gradeOfStage(stage) {
  // the visual stage records the compare grade inside its "pixel difference" detail
  const chk = (stage.checks || []).find((c) => c.name === "pixel difference") || {};
  const m = String(chk.detail || "").match(/grade:\s*([^,)]+)/i);
  return m ? m[1].trim() : null;
}

function renderStages(report) {
  const stages = report?.stages || [];
  const fm = report?.flowMatrix;
  const fmChip = fm ? `<span class="chip">flow-matrix: ${fm.passed}/${fm.total} pass · ${fm.failed} fail · ${fm.bugs} bug(s)</span>` : "";
  return stages.map((s) => `
    <div class="stage" data-stage="${esc(s.stage)}">
      <h3>${esc(s.stage)} <span class="badge ${s.passed ? "ok" : "err"}">${s.passed ? "PASSED" : "FAILED"}</span>
          ${gradeOfStage(s) ? `<span class="chip">grade: ${esc(gradeOfStage(s))}</span>` : ""}
          <span class="kv">round ${esc(String(report.round ?? "?"))} · layout ${esc(report.layout || "v1")}</span></h3>
      ${(s.checks || []).map((c) => `
        <div class="check"><span class="mark ${c.ok ? "ok" : "err"}">${c.ok ? "✓" : "✗"}</span>
          <span>${esc(c.name)}</span> <span class="detail">${esc(c.detail || "")}</span></div>`).join("")}
      ${s.metrics ? `<details><summary>metrics</summary><pre class="mono kv" style="white-space:pre-wrap">${esc(JSON.stringify(s.metrics, null, 1))}</pre></details>` : ""}
    </div>`).join("") + (fm ? `<div class="chips">${fmChip}${fm.note ? `<span class="chip">${esc(fm.note)}</span>` : ""}${fm.error ? `<span class="chip" style="color:var(--err)">${esc(fm.error)}</span>` : ""}</div>` : "");
}

// defect classification — computed from the matrix data itself (fail kinds +
// bug severities); no invented categories.
function classifyDefects(matrix) {
  const byKind = {};
  const bySeverity = {};
  for (const f of matrix?.flows || []) {
    for (const c of f.cases || []) {
      if (c.result === "fail") byKind[c.kind] = (byKind[c.kind] || 0) + 1;
    }
  }
  for (const b of matrix?.bugs || []) bySeverity[b.severity] = (bySeverity[b.severity] || 0) + 1;
  return { byKind, bySeverity };
}

function renderFlows(matrix) {
  const flows = matrix?.flows || [];
  if (!flows.length) return '<div class="empty">flow-matrix.json has no flows (no replayable recorded interactions) or is absent</div>';
  return flows.map((f) => `
    <div class="stage">
      <h3>${esc(f.id)} <span class="kv">${esc(f.page || "")}</span>
          <span class="badge ${(f.cases || []).every((c) => c.result === "pass") ? "ok" : "err"}">${(f.cases || []).filter((c) => c.result === "pass").length}/${(f.cases || []).length} pass</span></h3>
      <table><thead><tr><th>case</th><th>kind</th><th>trigger / label</th><th>result</th><th>evidence</th></tr></thead><tbody>
      ${(f.cases || []).map((c) => {
        const shot = c.evidence?.screenshotRef ? `<a href="${esc(artifactUrl(c.evidence.screenshotRef))}" target="_blank">screenshot</a>` : "";
        const consoleN = (c.evidence?.console || []).length;
        return `<tr class="flow-case" data-result="${esc(c.result)}"><td class="mono">${esc(c.id)}</td><td class="mono">${esc(c.kind)}</td>
          <td>${esc(c.label || c.trigger || c.target || "")}</td>
          <td><span class="badge ${c.result === "pass" ? "ok" : c.result === "fail" ? "err" : "warn"}">${esc(c.result)}</span></td>
          <td>${shot}${consoleN ? ` <span class="kv">${consoleN} console err</span>` : ""}</td></tr>`;
      }).join("")}
      </tbody></table>
    </div>`).join("");
}

function renderBugs(matrix) {
  const bugs = matrix?.bugs || [];
  if (!bugs.length) return '<div class="empty">no bugs recorded by the flow matrix</div>';
  return `<table><thead><tr><th>severity</th><th>case</th><th>what</th><th>screenshot</th></tr></thead><tbody>
    ${bugs.map((b) => `<tr><td><span class="badge ${b.severity === "high" ? "err" : b.severity === "medium" ? "warn" : "ok"}">${esc(b.severity)}</span></td>
      <td class="mono">${esc(b.case)}</td><td>${esc(b.what)}</td>
      <td>${b.evidence?.screenshotRef ? `<a href="${esc(artifactUrl(b.evidence.screenshotRef))}" target="_blank" class="bug-link">screenshot</a>` : "—"}</td></tr>`).join("")}
    </tbody></table>`;
}

function renderDefects(matrix) {
  const { byKind, bySeverity } = classifyDefects(matrix);
  const kindChips = Object.entries(byKind).map(([k, n]) => `<span class="chip">${esc(k)} ×${n}</span>`).join("");
  const sevChips = Object.entries(bySeverity).map(([s, n]) => `<span class="chip">${esc(s)} ×${n}</span>`).join("");
  if (!kindChips && !sevChips) return '<div class="empty">no failed cases and no recorded bugs — nothing to classify</div>';
  return `<div class="chips"><span class="kv">failed case kinds:</span> ${kindChips || '<span class="empty">none</span>'}</div>
          <div class="chips"><span class="kv">bug severities:</span> ${sevChips || '<span class="empty">none</span>'}</div>`;
}

function shotCell(cap, path, missingText) {
  return `<div class="shot"><div class="cap">${esc(cap)}</div><div id="shot-${esc(path.replace(/[^a-z0-9]/gi, "-"))}" class="shot-slot" data-path="${esc(path)}"><div class="missing">loading…</div></div></div>`;
}

function showFatal(status, why) {
  $("#main").className = "state err";
  $("#main").innerHTML = `<h2 style="color:var(--err)">comparison unavailable</h2><p>HTTP ${status} — ${esc(why)}</p>
    <p class="kv">Job id used: <code>${esc(jobId || "(none — open with ?job=<jobId>")}</code></p>`;
}

async function loadShot(slot, path, missingText) {
  const el = $(`#shot-${path.replace(/[^a-z0-9]/gi, "-")}`);
  if (!el) return;
  const img = new Image();
  img.alt = missingText;
  img.onerror = () => { el.innerHTML = `<div class="missing">${esc(missingText)} (image fetch failed)</div>`; };
  img.onload = () => { el.innerHTML = ""; el.appendChild(img); };
  img.src = artifactUrl(path);
}

async function boot() {
  $("#src-line").textContent = jobId ? `job ${jobId}` : "no job selected";
  if (!jobId) return showFatal(400, "open this page with ?job=<jobId>");
  $("#main").className = "";
  $("#main").innerHTML = `
    <div class="card"><h2>Original vs clone</h2>
      <div class="compare">
        ${shotCell("original — pages/page-001/screenshot-viewport.png", "pages/page-001/screenshot-viewport.png", "original screenshot not found (404)")}
        ${shotCell("clone — _reference/clone-verify.png", "_reference/clone-verify.png", "clone screenshot not found (404) — produced by scripts/compare-clone.mjs during verification")}
      </div>
      <div style="margin-top:12px">${shotCell("diff heatmap — _reference/diff.png (red = different)", "_reference/diff.png", "diff heatmap not found (404)")}</div>
    </div>
    <div class="card"><h2>Verification stage results</h2><div id="stages-body" class="empty">loading verification.json…</div></div>
    <div class="card"><h2>Flow matrix cases</h2><div id="flows-body" class="empty">loading flow-matrix.json…</div></div>
    <div class="card"><h2>Bugs</h2><div id="bugs-body" class="empty">loading…</div></div>
    <div class="card"><h2>Defect classification summary</h2><div id="defects-body" class="empty">loading…</div></div>`;

  loadShot(null, "pages/page-001/screenshot-viewport.png", "original screenshot not found (404)");
  loadShot(null, "_reference/clone-verify.png", "clone screenshot not found (404)");
  loadShot(null, "_reference/diff.png", "diff heatmap not found (404)");

  const [ver, matrix] = await Promise.all([getJson("_reference/verification.json"), getJson("reports/flow-matrix.json")]);
  const stEl = $("#stages-body");
  if (!ver.data) stEl.innerHTML = `<div class="empty" style="color:var(--warn)">verification.json not available (HTTP ${ver.status}) — written at _reference/verification.json once verification runs</div>`;
  else { stEl.innerHTML = renderStages(ver.data); stEl.className = ""; }

  const flEl = $("#flows-body");
  if (!matrix.data) flEl.innerHTML = `<div class="empty" style="color:var(--warn)">flow-matrix.json not available (HTTP ${matrix.status}) — written to reports/flow-matrix.json by the flow replay stage</div>`;
  else flEl.innerHTML = renderFlows(matrix.data);

  const bgEl = $("#bugs-body");
  if (!matrix.data) bgEl.innerHTML = '<div class="empty">flow matrix absent — no bug list</div>';
  else bgEl.innerHTML = renderBugs(matrix.data);

  const dfEl = $("#defects-body");
  if (!matrix.data) dfEl.innerHTML = '<div class="empty">flow matrix absent — nothing to classify</div>';
  else dfEl.innerHTML = renderDefects(matrix.data);
}

boot();
