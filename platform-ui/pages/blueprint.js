// Page 5 page-script — renders blueprint.json + posts scope edits.
// Data contract: artifacts/<jobId>/blueprint.json (src/reconstruction/blueprint.js:174).
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const params = new URLSearchParams(location.search);
const jobId = params.get("job") || params.get("id") || "";
const artifactUrl = (p) => `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${p}`;

let blueprint = null;

function renderShell() {
  $("#main").className = "";
  $("#main").innerHTML = `
    <div class="grid">
      <div class="card" id="card-scope"><h2>Scope (include / exclude)</h2><div id="scope-body" class="empty">no instructions parsed</div></div>
      <div class="card"><h2>Detected stack → framework decision</h2><div id="stack-body"></div></div>
      <div class="card"><h2>Per-page regions</h2><div id="pages-body"></div></div>
      <div class="grid cols2">
        <div class="card"><h2>Interaction model</h2><div id="inter-body"></div></div>
        <div class="card"><h2>Ambiguities (recorded, not resolved)</h2><div id="amb-body"></div></div>
      </div>
      <div class="card"><h2>Acceptance evidence</h2><div id="acc-body"></div></div>
      <div class="card"><h2>Action</h2>
        <div class="actions">
          <button id="btn-approve">APPROVE</button>
          <button id="btn-scope" class="ghost">EDIT-SCOPE</button>
          <span class="kv">POSTs the scope edits to <code>/api/jobs/${esc(jobId)}/blueprint/approve</code></span>
        </div>
        <div id="action-out"></div>
      </div>
    </div>`;
  $("#btn-approve").addEventListener("click", () => postScope({ approved: true }));
  $("#btn-scope").addEventListener("click", () => {
    // EDIT-SCOPE sends the edited textareas verbatim; the engine decides.
    postScope({ approved: false });
  });
}

function renderScope(ins) {
  const s = ins?.scope || { include: [], exclude: [], notes: [] };
  const applied = !!ins?.applied;
  $("#scope-body").className = "";
  $("#scope-body").innerHTML = `
    ${applied ? "" : `<div class="kv">no include/exclude instruction parsed — full visible scope by defaults</div>`}
    <label>Include (one per line, editable)</label>
    <textarea id="ta-include">${esc(s.include.join("\n"))}</textarea>
    <label>Exclude (one per line, editable)</label>
    <textarea id="ta-exclude">${esc(s.exclude.join("\n"))}</textarea>
    ${s.notes?.length ? `<label>Notes</label><ul class="list">${s.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}`;
}

function renderStack(stack) {
  const det = stack?.detected || [];
  const out = stack?.output || {};
  $("#stack-body").innerHTML = `
    <div class="chips">${det.length ? det.map((d) => `<span class="chip">${esc(d)}</span>`).join("") : '<span class="chip">no stack signals detected</span>'}</div>
    <p style="margin:10px 0 4px"><b>framework:</b> <span class="mono">${esc(out.framework || "?")}</span>
       <span class="badge ${out.engineOutput === "static" ? "unverified" : "ok"}" title="what the engine actually emits">engine output: ${esc(out.engineOutput || "?")}</span></p>
    <div class="kv">${esc(out.reason || "")}</div>
    ${out.note ? `<div class="kv" style="color:var(--status-pending)">${esc(out.note)}</div>` : ""}
    <div class="kv">stack scan: ${esc(String(stack?.scannedUrls ?? "?"))} urls, ${esc(String(stack?.scannedPages ?? "?"))} pages</div>`;
}

function renderPages(pages) {
  if (!pages?.length) { $("#pages-body").innerHTML = '<div class="empty">no pages captured</div>'; return; }
  $("#pages-body").innerHTML = pages.map((p) => `
    <div class="page" style="margin-bottom:8px">
      <span class="pid">${esc(p.pageId)}</span>
      <span class="badge ${esc(p.evidence || "inferred")}">${esc(p.evidence || "inferred")}</span>
      <div class="url">${esc(p.url || p.route || "url not recorded")}</div>
      <div class="regions">
        ${(p.regions || []).map((r) => `<span class="chip" title="${esc(r.selectorHint || "")}">${esc(r.region)} <span class="badge ${esc(r.evidence)}">${esc(r.evidence)}</span></span>`).join("") || '<span class="kv">no regions classified</span>'}
      </div>
      ${(p.components || []).length ? `<div class="regions">${p.components.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>` : ""}
    </div>`).join("");
}

function renderInteractions(i) {
  $("#inter-body").innerHTML = `
    <p style="margin:0 0 6px"><b>${esc(i?.model || "unknown")}</b>
      <span class="badge ${esc(i?.evidence || "inferred")}">${esc(i?.evidence || "inferred")}</span></p>
    <div class="kv">triggers: ${esc(String(i?.triggers ?? 0))} · state nodes: ${esc(String(i?.stateNodes ?? 0))} · scroll hints: ${esc(String(i?.scrollHints ?? 0))}</div>`;
}

function renderAmbiguities(list) {
  $("#amb-body").innerHTML = list?.length
    ? `<ul class="list">${list.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`
    : '<div class="empty">none recorded</div>';
}

function renderAcceptance(list) {
  $("#acc-body").innerHTML = list?.length
    ? `<ul class="list">${list.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`
    : '<div class="empty">none recorded</div>';
}

async function postScope(extra = {}) {
  const out = $("#action-out");
  const include = ($("#ta-include")?.value || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const exclude = ($("#ta-exclude")?.value || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const body = JSON.stringify({ scope: { include, exclude, notes: [] }, jobId, ...extra });
  for (const b of [$("#btn-approve"), $("#btn-scope")]) b.disabled = true;
  out.innerHTML = '<div class="kv">posting scope…</div>';
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/blueprint/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text.slice(0, 200);
      try { detail = JSON.parse(text).error || detail; } catch { /* keep raw text */ }
      out.innerHTML = `<div class="notice err">Scope edit not applied — endpoint answered <b>HTTP ${res.status}</b> ${esc(detail)}.` +
        (res.status === 404 ? " This approval endpoint is not mounted by the platform server yet; your edits are shown above but were not persisted." : "") + `</div>`;
      return;
    }
    const data = await res.json().catch(() => ({}));
    out.innerHTML = `<div class="notice ok">Scope ${extra.approved ? "approved" : "edit submitted"}${data?.ok ? " — accepted by the server." : ` — server answered: <span class="mono">${esc(JSON.stringify(data).slice(0, 200))}</span>`}</div>`;
  } catch (e) {
    out.innerHTML = `<div class="notice err">Scope edit failed — ${esc(String(e?.message || e).slice(0, 160))}</div>`;
  } finally {
    for (const b of [$("#btn-approve"), $("#btn-scope")]) b.disabled = false;
  }
}

function showFatal(status, why) {
  $("#main").className = "state err";
  $("#main").innerHTML = `<h2 style="color:var(--status-error)">blueprint unavailable</h2>
    <p>GET ${esc(artifactUrl("blueprint.json"))} → <b>HTTP ${status}</b></p><p class="kv">${esc(why)}</p>
    <p class="kv">Job id used: <code>${esc(jobId || "(none — open with ?job=<jobId>")}</code></p>`;
}

async function boot() {
  $("#src-line").textContent = jobId ? `job ${jobId}` : "no job selected";
  if (!jobId) return showFatal(400, "open this page with ?job=<jobId> (the id printed when the clone job was created)");
  renderShell();
  const res = await fetch(artifactUrl("blueprint.json")).catch((e) => ({ ok: false, status: 0, _net: e }));
  if (!res.ok) {
    return showFatal(res.status || 0, res.status === 404
      ? "blueprint.json is not in this job's artifacts yet — it is written during reconstruction (src/reconstruction/blueprint.js:218)."
      : "artifact read endpoint unreachable.");
  }
  blueprint = await res.json().catch(() => null);
  if (!blueprint) return showFatal(502, "blueprint.json downloaded but not parseable as JSON.");
  $("#src-line").textContent = `job ${esc(blueprint.jobId || jobId)} · ${esc(blueprint.source?.url || "source url unknown")}`;
  renderScope(blueprint.instructions);
  renderStack(blueprint.stack);
  renderPages(blueprint.pages);
  renderInteractions(blueprint.interactions);
  renderAmbiguities(blueprint.ambiguities);
  renderAcceptance(blueprint.acceptanceEvidence);
}

boot();
