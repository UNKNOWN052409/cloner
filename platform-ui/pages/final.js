// Page 8 page-script — final project deliverable view.
// Real endpoints used (src/platform/server.js unless noted):
//   GET  /preview/:id(/index.html)            — live clone preview (server.js:823)
//   GET  /api/export/:id/download             — export.zip (server.js:972, 404 "export first")
//   POST /api/export/:id                      — stage the zip (server.js:933)
//   GET  /api/github/status                   — publish config (github-publish-real.js:474)
//   POST /api/github/publish/:taskId          — publish (github-publish-real.js:481)
//   GET  /api/jobs/:jobId/artifacts/*         — verification.json / reconstruction-report.json
//   GET  /api/tasks/:jobId                    — reconstruction/verification summary (server.js:725)
//   GET  /api/versions                        — NOT MOUNTED today → honest 404 panel
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const params = new URLSearchParams(location.search);
const jobId = params.get("job") || params.get("id") || "";
const artifactUrl = (p) => `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${p}`;

async function getJson(url) {
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return { status: res ? res.status : 0, data: null };
  return { status: res.status, data: await res.json().catch(() => null) };
}

// ---- download: honest 404 state ("export first") ----
async function doDownload(btn, out) {
  btn.disabled = true;
  out.innerHTML = '<div class="kv">checking export.zip…</div>';
  try {
    const res = await fetch(`/api/export/${encodeURIComponent(jobId)}/download`);
    if (res.status === 404) {
      out.innerHTML = `<div class="notice err">Download not available — <b>HTTP 404</b> ("export first"). The export.zip is staged by <span class="mono">POST /api/export/${esc(jobId)}</span> after a completed clone; nothing was downloaded.</div>`;
      return;
    }
    if (!res.ok) {
      out.innerHTML = `<div class="notice err">Download failed — <b>HTTP ${res.status}</b>.</div>`;
      return;
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `clone-${jobId}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    out.innerHTML = `<div class="notice ok">Download started (${(blob.size / 1024).toFixed(1)} KiB).</div>`;
  } catch (e) {
    out.innerHTML = `<div class="notice err">Download failed — ${esc(String(e?.message || e).slice(0, 160))}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// ---- github publish: status badge + form + honest error states ----
async function doPublish(btn, out, form) {
  const repoName = form.querySelector("#gh-repo")?.value.trim();
  const visibility = form.querySelector("#gh-vis")?.value || "private";
  btn.disabled = true;
  out.innerHTML = '<div class="kv">publishing…</div>';
  try {
    const res = await fetch(`/api/github/publish/${encodeURIComponent(jobId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoName: repoName || undefined, visibility }),
    });
    const text = await res.text().catch(() => "");
    let data = {}; try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      out.innerHTML = `<div class="notice err">Publish not completed — <b>HTTP ${res.status}</b> ${esc(data?.error || text.slice(0, 160))}` +
        (res.status === 404 ? " (unknown task — run the clone first)" : res.status === 503 ? " (GitHub publish not configured locally — GITHUB_PUBLISH_TOKEN absent)" : res.status === 502 ? " (upstream GitHub refused the request)" : "") + `</div>`;
      return;
    }
    out.innerHTML = `<div class="notice ok">Published. ${data?.html_url ? `<a href="${esc(data.html_url)}" target="_blank">${esc(data.html_url)}</a>` : ""}${data?.existing ? " (repo already existed)" : ""}</div>`;
  } catch (e) {
    out.innerHTML = `<div class="notice err">Publish failed — ${esc(String(e?.message || e).slice(0, 160))}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderStages(ver) {
  return (ver?.stages || []).map((s) => `
    <div class="stage"><b>${esc(s.stage)}</b><span class="badge ${s.passed ? "ok" : "err"}">${s.passed ? "PASSED" : "FAILED"}</span></div>
    ${(s.checks || []).map((c) => `<div class="check"><span class="mark ${c.ok ? "ok" : "err"}">${c.ok ? "✓" : "✗"}</span><span>${esc(c.name)}</span> <span class="detail">${esc((c.detail || "").slice(0, 140))}</span></div>`).join("")}`).join("");
}

function renderVersions(res) {
  if (!res) return '<div class="notice warn">Version history unavailable — <span class="mono">GET /api/versions</span> unreachable.</div>';
  if (res.status === 404) return `<div class="notice warn">Version history not available — <b>HTTP 404</b>. The versions router exists (<span class="mono">src/platform/version-service.js</span>) but is not mounted by the platform server yet; the placeholder stays wired to <span class="mono">GET /api/versions</span> and will render data once mounted.</div>`;
  if (res.status) return `<div class="notice err">Version history failed — HTTP ${res.status}.</div>`;
  const items = Array.isArray(res.data) ? res.data : (res.data?.versions || []);
  if (!items.length) return '<div class="empty">no versions recorded</div>';
  return `<ul class="list">${items.map((v) => `<li class="mono">${esc(JSON.stringify(v).slice(0, 120))}</li>`).join("")}</ul>`;
}

async function boot() {
  $("#src-line").textContent = jobId ? `job ${jobId}` : "no job selected";
  if (!jobId) {
    $("#main").className = "state err";
    $("#main").innerHTML = "<h2 style='color:var(--err)'>no job selected</h2><p>open this page with ?job=&lt;jobId&gt;</p>";
    return;
  }
  $("#main").className = "";
  $("#main").innerHTML = `
    <div class="grid">
      <div>
        <div class="card"><h2>Live clone preview</h2>
          <div class="frame-wrap"><iframe id="preview" title="live clone preview" src="/preview/${encodeURIComponent(jobId)}/index.html"></iframe></div>
          <div class="kv" style="margin-top:6px">GET /preview/${esc(jobId)}/index.html — served from artifacts/${esc(jobId)}-project/ (v2) or the v1 output dir</div>
          <div id="preview-note" class="kv"></div>
        </div>
        <div class="card"><h2>Build report</h2>
          <div id="report-body" class="empty">loading verification.json + reconstruction-report.json…</div>
        </div>
        <div class="card"><h2>Known limitations</h2><div id="limits-body" class="empty">loading…</div></div>
      </div>
      <div>
        <div class="card"><h2>Deliverable</h2>
          <div class="actions">
            <button id="btn-download">Download export.zip</button>
            <a href="/api/export/${encodeURIComponent(jobId)}/download" id="export-link" class="mono">direct link</a>
          </div>
          <div id="dl-out"></div>
        </div>
        <div class="card"><h2>Publish to GitHub</h2>
          <div id="gh-status" class="kv">checking publish config…</div>
          <div id="gh-form"><label>Repository name (blank → cloner-&lt;jobId&gt;)</label>
            <input id="gh-repo" placeholder="my-clone" />
            <label>Visibility</label>
            <select id="gh-vis"><option value="private">private</option><option value="public">public</option></select>
            <div class="actions" style="margin-top:10px"><button id="btn-publish">Publish</button></div>
          </div>
          <div id="gh-out"></div>
        </div>
        <div class="card"><h2>Version history</h2><div id="versions-body" class="empty">checking /api/versions…</div></div>
      </div>
    </div>`;

  const previewNote = (status, why) => { $("#preview-note").innerHTML = `<span style="color:var(--warn)">preview: HTTP ${status} — ${esc(why)}</span>`; };
  $("#preview")?.addEventListener("error", () => previewNote("network error", "preview tree missing"));
  try {
    const res = await fetch(`/preview/${encodeURIComponent(jobId)}/index.html`, { method: "GET" });
    if (!res.ok) previewNote(res.status, res.status === 404 ? "no reconstructed project for this job yet" : "preview unavailable");
  } catch { previewNote(0, "preview unreachable"); }

  $("#btn-download").addEventListener("click", (e) => doDownload(e.target, $("#dl-out")));
  $("#btn-publish").addEventListener("click", (e) => doPublish(e.target, $("#gh-out"), $("#gh-form")));

  const gh = await getJson("/api/github/status");
  $("#gh-status").innerHTML = gh.data
    ? `publish configured: <span class="badge ${gh.data.configured ? "ok" : "warn"}">${gh.data.configured ? "yes" : "no (GITHUB_PUBLISH_TOKEN absent)"}</span>`
    : `<span class="badge err">github status HTTP ${gh.status}</span>`;

  const [task, ver, recReport] = await Promise.all([
    getJson(`/api/tasks/${encodeURIComponent(jobId)}`),
    getJson(artifactUrl("_reference/verification.json")),
    getJson(artifactUrl("_reference/reconstruction-report.json")),
  ]);

  let reportHtml = "";
  if (task.data) {
    reportHtml += `<div class="kv">status: <b>${esc(task.data.status || "?")}</b>${task.data.reconstruction ? ` · reconstruction ${task.data.reconstruction.passed ? "passed" : "with limitations"} · ${task.data.reconstruction.pages ?? "?"} generated files · ${task.data.reconstruction.repairs ?? 0} repair(s)` : ""}</div>`;
  } else if (task.status) {
    reportHtml += `<div class="kv" style="color:var(--warn)">task registry: HTTP ${task.status}</div>`;
  }
  reportHtml += ver.data ? renderStages(ver.data)
    : `<div class="kv" style="color:var(--warn)">verification.json not available (HTTP ${ver.status}) — written to _reference/verification.json when verification runs</div>`;
  reportHtml += recReport.data
    ? `<div class="kv" style="margin-top:8px">reconstruction-report: generatedFiles ${esc(String(recReport.data.generatedFiles ?? "?"))} · passed ${esc(String(recReport.data.passed))} · status ${esc(recReport.data.status || "")}</div>`
    : `<div class="kv" style="margin-top:8px;color:var(--warn)">reconstruction-report.json not exposed (HTTP ${recReport.status === 404 ? "404 — it lives in artifacts/&lt;jobId&gt;-project/ which the artifact read API does not serve" : recReport.status})</div>`;
  $("#report-body").innerHTML = reportHtml || '<div class="empty">nothing yet</div>';

  const limits = [];
  if (ver.data?.limitations?.length) limits.push(...ver.data.limitations.map((l) => ["verification", l]));
  if (ver.data?.repairLoop) limits.push(["repairLoop", `stopped=${ver.data.repairLoop.stopped} applied=${ver.data.repairLoop.applied} reverted=${ver.data.repairLoop.reverted} pending=${ver.data.repairLoop.pending} improved=${ver.data.repairLoop.improved}`]);
  if (recReport.data?.limitations?.length) limits.push(...recReport.data.limitations.map((l) => ["reconstruction", l]));
  $("#limits-body").innerHTML = limits.length
    ? `<ul class="list">${limits.map(([src, l]) => `<li><span class="mono kv">[${esc(src)}]</span> ${esc(l)}</li>`).join("")}</ul>`
    : '<div class="empty">no limitations recorded in the available reports</div>';

  $("#versions-body").innerHTML = renderVersions(await getJson("/api/versions"));
}

boot();
