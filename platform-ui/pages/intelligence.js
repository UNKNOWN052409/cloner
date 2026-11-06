// Page 4 — Website Intelligence. Pure frontend over existing artifact reads:
//   GET /api/jobs/:id/artifacts/manifest.json                (coverage/pages/metrics)
//   GET /api/jobs/:id/artifacts/graph/routes.json            (discovered routes)
//   GET /api/jobs/:id/artifacts/design-tokens.json           (measured tokens)
//   GET /api/jobs/:id/artifacts/reports/exploration-summary.json
//   GET /api/jobs/:id/artifacts/blueprint.json               (reconstruction ran)
// Each read degrades independently — one missing artifact never blanks the page.
import { api, esc } from "../app.js";

export default async function render(root, { params }) {
  const id = params.id;
  window.__project = { id };
  root.querySelector("#wi-id").textContent = id;
  const art = (p) => api("/api/jobs/" + encodeURIComponent(id) + "/artifacts/" + p);
  const el = {
    cov: root.querySelector("#wi-cov"), routes: root.querySelector("#wi-routes"),
    tokens: root.querySelector("#wi-tokens"), expl: root.querySelector("#wi-expl"),
    metrics: root.querySelector("#wi-metrics"), bp: root.querySelector("#wi-blueprint"),
    issues: root.querySelector("#wi-issues"),
  };
  const absent = (note) => '<dd class="dim">not in the artifacts yet — ' + esc(note) + "</dd>";

  function kv(el, pairs) {
    el.innerHTML = pairs.map(([k, v]) => "<dt>" + k + "</dt><dd>" + v + "</dd>").join("");
  }

  // ---- manifest (the one read that carries the page) ----
  let manifest = null;
  try {
    manifest = await art("manifest.json");
  } catch (e) {
    root.querySelector(".two-col").innerHTML =
      '<div class="state error" style="grid-column:1/-1"><div class="big">manifest.json unavailable</div>' +
      "<div>GET /api/jobs/" + esc(id) + "/artifacts/manifest.json answered: " + esc(String(e.message || e).slice(0, 160)) +
      " — the exploration stage has not produced artifacts for this id (or this session may not read them).</div>" +
      '<div class="actions"><a class="btn" href="#/">Back to Projects</a></div></div>';
    return () => {};
  }

  const cov = manifest.coverage || {};
  const pct = cov.routesDiscovered ? Math.min(100, Math.round((cov.routesExplored / cov.routesDiscovered) * 100)) : null;
  el.cov.innerHTML =
    "<span>routes explored: <b>" + (cov.routesExplored ?? "?") + "/" + (cov.routesDiscovered ?? "?") + "</b></span>" +
    (pct != null ? '<span class="meter" style="flex:0 0 160px;align-self:center"><i style="width:' + pct + '%"></i></span>' : "") +
    "<span>states recorded: <b>" + (cov.statesRecorded ?? "?") + "</b></span>" +
    "<span>pages: <b>" + ((manifest.pages || []).length) + "</b></span>" +
    "<span>status: <b>" + esc(manifest.status || "—") + "</b></span>";

  // ---- routes: graph/routes.json preferred, manifest pages as fallback ----
  try {
    const rj = await art("graph/routes.json");
    const routes = (rj && rj.routes) || [];
    if (!routes.length) el.routes.innerHTML = '<div class="state"><div class="big">No routes recorded</div></div>';
    else {
      el.routes.innerHTML =
        '<div class="panel" style="padding:0;overflow-x:auto"><table class="grid">' +
        "<thead><tr><th>#</th><th>URL</th><th>Source</th><th>Score</th></tr></thead><tbody>" +
        routes.slice(0, 60).map((r, i) => {
          const url = typeof r === "string" ? r : (r.url || "");
          const src = typeof r === "string" ? "" : (r.source || "");
          const score = typeof r === "string" ? "" : (r.score != null ? r.score : "");
          let path = url;
          try { path = new URL(url).pathname + (new URL(url).search || ""); } catch { /* keep raw */ }
          return "<tr><td class='dim'>" + (i + 1) + "</td><td class='url' title=\"" + esc(url) + "\">" + esc(path || url) + "</td>" +
            "<td>" + (src ? '<span class="chip">' + esc(src) + "</span>" : '<span class="dim">—</span>') + "</td>" +
            "<td class='mono'>" + esc(String(score)) + "</td></tr>";
        }).join("") +
        "</tbody></table></div>" +
        (routes.length > 60 ? '<div class="hint">showing 60 of ' + routes.length + " routes</div>" : "");
    }
  } catch {
    const pages = manifest.pages || [];
    el.routes.innerHTML = "<dl class='kv'>" + pages.map((p) =>
      "<dt>" + esc(p.pageId) + "</dt><dd class='url'>" + esc(p.url || "—") + "</dd>").join("") +
      "</dl>" + (pages.length ? "" : absent("graph/routes.json missing and manifest lists no pages"));
  }

  // ---- design tokens ----
  try {
    const t = await art("design-tokens.json");
    const swatches = (arr) => (arr || []).slice(0, 16).map(([v]) =>
      '<span class="swatch"><i style="background:' + esc(String(v)) + '"></i>' + esc(String(v)) + "</span>").join("");
    const fonts = (t.fonts || []).map(([f]) => f);
    el.tokens.innerHTML =
      ((t.colors || []).length || (t.backgrounds || []).length
        ? "<div class='hint'>colors captured (" + (t.colors || []).length + ") + backgrounds (" + (t.backgrounds || []).length + ")</div><div class='swatches' style='margin:6px 0 10px'>" + swatches(t.colors) + swatches(t.backgrounds) + "</div>"
        : "") +
      "<dl class='kv'>" +
      "<dt>fonts</dt><dd>" + (fonts.length ? esc(fonts.slice(0, 6).join(", ")) : "—") + "</dd>" +
      "<dt>font sizes</dt><dd>" + ((t.fontSizes || []).map((x) => x[0]).slice(0, 10).join(", ") || "—") + "</dd>" +
      "<dt>radii</dt><dd>" + ((t.radii || []).map((x) => x[0]).slice(0, 8).join(", ") || "—") + "</dd>" +
      "<dt>body</dt><dd>" + esc(String(t.bodyBackground || "—")) + " on " + esc(String(t.bodyColor || "—")) + "</dd>" +
      "</dl>";
  } catch {
    el.tokens.innerHTML = absent("design-tokens.json lands with the reconstruction stage");
  }

  // ---- exploration summary ----
  try {
    const s = await art("reports/exploration-summary.json");
    kv(el.expl, [
      ["status", esc(String(s.status || "—"))],
      ["pages", esc(String(s.pages ?? "—"))],
      ["routes", esc(String(s.routes ?? "—"))],
      ["states", esc(String(s.states ?? "—"))],
      ["interactions", esc(String(s.interactions ?? "—"))],
      ["coverage", s.coveragePct != null ? esc(String(s.coveragePct)) + "%" : "—"],
    ]);
  } catch {
    kv(el.expl, [["summary", absent("reports/exploration-summary.json")]].map(([k, v]) => [k, v]));
  }

  // ---- page metrics (from the manifest) ----
  const m = manifest.metrics || {};
  kv(el.metrics, [
    ["navigation", m.navigationMs != null ? m.navigationMs + " ms" : "—"],
    ["dom extract", m.domExtractionMs != null ? m.domExtractionMs + " ms" : "—"],
    ["screenshot", m.screenshotMs != null ? m.screenshotMs + " ms" : "—"],
    ["assets", m.assetMs != null ? m.assetMs + " ms" : "—"],
    ["crashes / timeouts", (m.crashes || 0) + " / " + (m.timeouts || 0)],
    ["failed interactions", String(m.failedInteractions ?? 0)],
    ["browser memory", m.browserMemoryPeakBytes != null ? Math.round(m.browserMemoryPeakBytes / 1048576) + " MB peak" : "—"],
  ]);

  // ---- blueprint (when reconstruction ran) ----
  try {
    const b = await art("blueprint.json");
    const ins = b.instructions || {};
    kv(el.bp, [
      ["source", esc(String((b.source && b.source.url) || "—"))],
      ["framework", esc(String((b.stack && b.stack.output && b.stack.output.framework) || "—"))],
      ["engine output", esc(String((b.stack && b.stack.output && b.stack.output.engineOutput) || "—"))],
      ["stack", esc(String(((b.stack && b.stack.detected) || []).join(", ") || "none detected"))],
      ["scope applied", ins.applied ? "yes — " + ((ins.scope && ins.scope.include.length) || 0) + " include, " + ((ins.scope && ins.scope.exclude.length) || 0) + " exclude clauses" : "no — full visible scope by defaults"],
      ["pages", esc(String((b.pages || []).length))],
      ["acceptance evidence", esc(String((b.acceptanceEvidence || []).length))],
    ]);
  } catch {
    el.bp.innerHTML = absent("blueprint.json is written during reconstruction");
  }

  // ---- warnings / errors ----
  const warns = manifest.warnings || [];
  const errs = manifest.errors || [];
  el.issues.innerHTML =
    "<dt>warnings</dt><dd>" + (warns.length ? warns.map((w) => esc(String(w).slice(0, 160))).join(" · ") : '<span class="dim">none recorded</span>') + "</dd>" +
    "<dt>errors</dt><dd>" + (errs.length ? errs.map((w) => '<span class="form-err">' + esc(String(w).slice(0, 160)) + "</span>").join(" · ") : '<span class="dim">none recorded</span>') + "</dd>";

  return () => { /* static reads — nothing to tear down */ };
}
