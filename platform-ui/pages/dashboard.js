// Page 1 — Projects Dashboard. One list, both pipelines:
//   v1 legacy task meta  { id, url, status, createdAt, verification?, error? }
//   v2 pipeline job      { id, jobId, url, status, createdAt, finishedAt }  (clone-queue listJobs)
// Status buckets mirror src/platform/dashboard-routes.js STATUS_BUCKETS.
// Progress for running v2 rows comes from GET /api/jobs/:id → manifest.coverage
// (routesExplored / routesDiscovered — written by exploration-pipeline.js).
import { api, esc, fmtTime, statusMeta, wsSubscribe, wsJoin } from "../app.js";

const RUNNING = new Set(["running", "verifying", "exploring", "reconstructing"]);
const DONE = new Set(["done", "completed", "completed_with_limitations", "exported"]);
const FAILED = new Set(["error", "cancelled"]);
let reloadTimer = null;

export default async function render(root) {
  window.__project = null; // no project context here
  wsJoin(null); // everything visible to this identity
  const body = root.querySelector("#dash-body");
  const summary = root.querySelector("#dash-summary");
  const tabs = root.querySelector("#dash-tabs");
  let rows = [];
  let filter = "all";

  const bucketOf = (r) => (RUNNING.has(r.status) ? "running" : DONE.has(r.status) ? "completed" : FAILED.has(r.status) ? "failed" : "running");

  function normalize(list) {
    const out = (list || []).map((t) => {
      const v2 = t.jobId !== undefined || t.kind === "v2" || t.pipeline === "v2";
      return {
        id: t.id || t.jobId,
        kind: v2 ? "v2" : "v1",
        url: t.url || null,
        status: t.status || "queued",
        createdAt: t.createdAt || t.startedAt || t.queuedAt || null,
        finishedAt: t.finishedAt || null,
        error: t.error || null,
        verified: t.verification ? !!t.verification.passed : null,
        progress: null,
        pages: null,
      };
    });
    out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return out;
  }

  async function enrichRunning() {
    const targets = rows.filter((r) => r.kind === "v2" && RUNNING.has(r.status)).slice(0, 12);
    await Promise.allSettled(targets.map(async (r) => {
      const job = await api("/api/jobs/" + encodeURIComponent(r.id));
      const cov = job && job.manifest && job.manifest.coverage;
      if (cov && cov.routesDiscovered) r.progress = Math.min(100, Math.round((cov.routesExplored / cov.routesDiscovered) * 100));
      if (job && job.manifest && job.manifest.pages != null) r.pages = job.manifest.pages;
    }));
  }

  function renderSummary() {
    const n = (b) => rows.filter((r) => bucketOf(r) === b).length;
    const verified = rows.filter((r) => r.verified === true).length;
    summary.innerHTML =
      "<span><b>" + rows.length + "</b> total</span><span aria-hidden=\"true\">·</span>" +
      "<span><b>" + n("running") + "</b> running</span><span aria-hidden=\"true\">·</span>" +
      "<span><b>" + n("completed") + "</b> completed</span><span aria-hidden=\"true\">·</span>" +
      "<span><b>" + n("failed") + "</b> failed/cancelled</span><span aria-hidden=\"true\">·</span>" +
      '<span class="dim">verification passed: <b>' + verified + "</b></span>";
  }

  function rowHtml(r) {
    const st = statusMeta(r.status);
    const meter = r.progress != null
      ? '<div class="meter running"><i style="width:' + r.progress + '%"></i></div><span class="dim">' + r.progress + "%</span>"
      : r.pages != null ? '<span class="dim">' + r.pages + " pages</span>" : '<span class="dim">—</span>';
    const actions = [];
    if (r.kind === "v2" && RUNNING.has(r.status)) actions.push('<a href="#/projects/' + encodeURIComponent(r.id) + '/exploration">live</a>');
    if (r.kind === "v2") actions.push('<a href="#/projects/' + encodeURIComponent(r.id) + '/intelligence">intelligence</a>');
    if (r.kind === "v1" && DONE.has(r.status)) actions.push('<a href="/preview/' + encodeURIComponent(r.id) + '" target="_blank" rel="noopener">preview</a>');
    return "<tr>" +
      '<td><span class="sdot ' + esc(r.status) + '" title="' + esc(r.status) + '"></span> ' + esc(r.status) + "</td>" +
      '<td class="url">' + (r.url ? esc(r.url) : '<span class="dim">no url</span>') + "</td>" +
      '<td class="mono">' + esc(r.id) + "</td>" +
      '<td><span class="chip">' + r.kind + "</span></td>" +
      "<td>" + meter + "</td>" +
      "<td>" + fmtTime(r.createdAt) + "</td>" +
      '<td class="hide-sm">' + (r.verified === true ? '<span class="chip ok">verified</span>' : r.verified === false ? '<span class="chip err">failed</span>' : '<span class="dim">—</span>') + "</td>" +
      "<td>" + (actions.join(" · ") || '<span class="dim">—</span>') + "</td>" +
      "</tr>";
  }

  function renderTable() {
    const shown = filter === "all" ? rows : rows.filter((r) => bucketOf(r) === filter);
    if (!rows.length) {
      body.innerHTML =
        '<div class="state"><div class="big">No tasks yet</div>' +
        "<div>Nothing has been cloned from this origin/session. Start the first one:</div>" +
        '<div class="actions"><a class="btn primary" href="#/new">Create New Clone</a></div></div>';
      return;
    }
    if (!shown.length) {
      body.innerHTML = '<div class="state"><div class="big">No ' + esc(filter) + " tasks</div><div>Switch the filter or start a new clone.</div></div>";
      return;
    }
    body.innerHTML =
      '<div class="panel" style="padding:0;overflow-x:auto"><table class="grid">' +
      "<thead><tr><th>Status</th><th>Target</th><th>Id</th><th>Pipeline</th><th>Progress</th><th>Created (UTC)</th><th class=\"hide-sm\">Verification</th><th>Open</th></tr></thead>" +
      "<tbody>" + shown.map(rowHtml).join("") + "</tbody></table></div>";
  }

  async function load() {
    body.innerHTML = '<div class="state"><div class="big">Loading tasks…</div></div>';
    try {
      rows = normalize(await api("/api/tasks"));
      await enrichRunning();
      renderSummary();
      renderTable();
    } catch (e) {
      body.innerHTML =
        '<div class="state error"><div class="big">Task list unavailable</div>' +
        "<div>GET /api/tasks answered: " + esc(String(e.message || e).slice(0, 160)) + "</div>" +
        '<div class="actions"><button class="btn" id="dash-retry" type="button">Retry</button></div></div>';
      body.querySelector("#dash-retry").addEventListener("click", load);
    }
  }

  tabs.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-f]");
    if (!b) return;
    filter = b.dataset.f;
    for (const x of tabs.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    renderTable();
  });

  const unsub = wsSubscribe((msg) => {
    if (!["job:status", "task:done", "run:done", "run:error"].includes(msg && msg.type)) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 1200); // coalesce bursts
  });

  await load();
  return () => { unsub(); clearTimeout(reloadTimer); };
}
