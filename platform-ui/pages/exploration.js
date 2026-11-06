// Page 3 — Live Exploration Workspace.
//   live feed      /ws, join <jobId> (server.js broadcast; catchup replays the
//                  ring buffer scoped to accessible tasks)
//   screenshots    /api/jobs/:id/artifacts/pages/<pageId>/screenshot-viewport.png —
//                  the /ws whitelist (server.js:1087) carries no image payloads,
//                  so the stream = event-triggered + 8s manifest polling
//   session status job.credentialsProvided / job.hasCookies + GET /api/sessions
import { api, esc, fmtTime, statusMeta, payloadOf, wsSubscribe, wsJoin } from "../app.js";

const TERMINAL = new Set(["completed", "completed_with_limitations", "error", "cancelled"]);
const ACTIVE = new Set(["running", "exploring", "reconstructing", "verifying"]);

export default async function render(root, { params }) {
  const id = params.id;
  window.__project = { id };
  wsJoin(id);
  const el = {
    id: root.querySelector("#ex-id"), status: root.querySelector("#ex-status"),
    meta: root.querySelector("#ex-meta"), terminal: root.querySelector("#ex-terminal"),
    shot: root.querySelector("#ex-shot"), strip: root.querySelector("#ex-strip"),
    note: root.querySelector("#ex-shot-note"), current: root.querySelector("#ex-current"),
    timeline: root.querySelector("#ex-timeline"), session: root.querySelector("#ex-session"),
  };
  let jobId = id;
  let alive = true;
  let lastShotRefresh = 0;
  let pollTimer = null;
  const entries = []; // newest first, capped

  function push(kind, text, t, cls) {
    entries.unshift({ kind, text: String(text || "").slice(0, 240), t: t || Date.now(), cls: cls || "" });
    if (entries.length > 200) entries.length = 200;
    el.timeline.innerHTML = entries.map((e) =>
      "<li" + (e.cls ? ' class="' + e.cls + '"' : "") + "><time>" + fmtTime(new Date(e.t).toISOString()) +
      '</time><span class="kind">' + esc(e.kind) + '</span><span class="txt">' + esc(e.text) + "</span></li>"
    ).join("") || '<li><span class="dim">waiting for events…</span></li>';
  }

  function setStatus(s) {
    const m = statusMeta(s);
    el.status.textContent = m.label;
    el.status.className = "chip " + m.cls;
  }

  function busText(type, p) {
    if (!p || typeof p !== "object") return "";
    if (type === "step") return [p.status, p.msg || p.id].filter(Boolean).join(" — ");
    if (type === "log") return [p.level, p.msg].filter(Boolean).join(": ");
    if (type === "page:goto") return p.url || "";
    if (type === "workflow.stage") return "stage: " + (p.stage || "?");
    if (type === "workflow.agent") return "agent " + (p.name || p.id || "?") + " announced";
    if (type === "workflow.todo.add") return "unit + " + (p.label || p.id || "?") + (p.route ? " (" + p.route + ")" : "");
    if (type === "workflow.todo.done") return "unit done: " + (p.label || p.id || "?") + (p.agent ? " — " + p.agent : "");
    return JSON.stringify(p).slice(0, 160);
  }

  // Live position: page:goto must land immediately — the explorer may be on a
  // route the manifest has not captured yet, so this cannot wait for the next
  // artifact poll.
  function setCurrentUrl(url) {
    el.current.dataset.url = url;
    const first = el.current.querySelector("dd");
    if (first) first.textContent = url;
  }

  async function refreshShots() {
    if (!alive || Date.now() - lastShotRefresh < 2500) return;
    lastShotRefresh = Date.now();
    let manifest;
    try {
      manifest = await api("/api/jobs/" + encodeURIComponent(jobId) + "/artifacts/manifest.json");
    } catch (e) {
      el.note.textContent = e.status === 404
        ? "manifest.json not in the artifacts yet — it is written when the exploration stage completes."
        : "artifact read failed — " + String(e.message || e).slice(0, 120);
      return;
    }
    const pages = (manifest && manifest.pages) || [];
    if (!pages.length) {
      el.note.textContent = "no pages captured yet — screenshots appear as routes are explored.";
      return;
    }
    const cov = manifest.coverage || {};
    const pct = cov.routesDiscovered ? Math.min(100, Math.round((cov.routesExplored / cov.routesDiscovered) * 100)) : null;
    el.meta.innerHTML =
      "<span>coverage: <b>" + (cov.routesExplored ?? "?") + "/" + (cov.routesDiscovered ?? "?") + "</b> routes</span>" +
      (pct != null ? '<span class="meter running" style="flex:0 0 140px;align-self:center"><i style="width:' + pct + '%"></i></span>' : "") +
      "<span><b>" + (cov.statesRecorded ?? 0) + "</b> states</span>" +
      "<span><b>" + pages.length + "</b> pages</span>";
    const art = "/api/jobs/" + encodeURIComponent(jobId) + "/artifacts/";
    const liveUrl = el.current.dataset.url || "";
    const current = (liveUrl && pages.find((p) => p.url === liveUrl)) || pages[pages.length - 1];
    el.shot.innerHTML = '<img alt="viewport capture of ' + esc(current.url || current.pageId) +
      '" src="' + art + "pages/" + encodeURIComponent(current.pageId) + '/screenshot-viewport.png">';
    el.current.innerHTML =
      "<dt>url</dt><dd>" + esc(liveUrl || current.url || "—") + "</dd>" +
      "<dt>page</dt><dd>" + esc(current.pageId) + (current.route && current.route.url ? " · " + esc(new URL(current.route.url, "https://x.invalid").pathname) : "") + "</dd>";
    el.strip.innerHTML = pages.map((p, i) =>
      '<button type="button" data-pid="' + esc(p.pageId) + '" aria-current="' + (p.pageId === current.pageId) + '" title="' + esc(p.url || "") + '">' +
      '<img alt="" src="' + art + "pages/" + encodeURIComponent(p.pageId) + '/screenshot-viewport.png"></button>'
    ).join("");
  }

  async function loadJob() {
    let job = null;
    try {
      job = await api("/api/jobs/" + encodeURIComponent(id));
      jobId = job.jobId || id;
    } catch (e) {
      try {
        const meta = await api("/api/tasks/" + encodeURIComponent(id));
        if (meta && meta.pipeline === "v2") { jobId = meta.id || id; job = meta; }
        else return legacyV1(meta);
      } catch {
        el.id.textContent = id;
        root.querySelector(".page-head").insertAdjacentHTML("afterend",
          '<div class="state error"><div class="big">Job not found</div><div>Neither /api/jobs nor /api/tasks knows this id on this origin — it may belong to another session or have been retained out.</div><div class="actions"><a class="btn" href="#/">Back to Projects</a></div></div>');
        return;
      }
    }
    el.id.textContent = jobId;
    setStatus(job.status || "queued");
    if (job.error) push("job:error", String(job.error).slice(0, 200), null, "k-error");
    await refreshShots();
    await renderSession(job);
    if (TERMINAL.has(job.status)) terminalBanner(job.status, job.error);
    else pollTimer = setInterval(() => { refreshShots(); }, 8000);
  }

  async function renderSession(job) {
    let sessions = null;
    try { sessions = await api("/api/sessions"); } catch { /* operator surface, optional */ }
    el.session.innerHTML =
      "<dt>credentials</dt><dd>" + (job.credentialsProvided ? "provided with the task" : "none — anonymous exploration") + "</dd>" +
      "<dt>cookies</dt><dd>" + (job.hasCookies ? "cookie jar on file" : "none") + "</dd>" +
      "<dt>browser sessions</dt><dd>" + (sessions ? (sessions.active || 0) + " active" + ((sessions.ids || []).length ? " · " + esc(sessions.ids.slice(0, 3).join(", ")) : "") : "stats unavailable") + "</dd>" +
      "<dt>events</dt><dd>/ws joined as " + esc(jobId) + "</dd>";
  }

  function terminalBanner(status, error) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const ok = status === "completed" || status === "completed_with_limitations";
    el.terminal.innerHTML =
      '<div class="state' + (ok ? "" : " error") + '" style="margin-bottom:16px"><div class="big">' +
      esc(status) + (ok ? " — exploration finished" : " — job ended") + "</div>" +
      (error ? "<div>" + esc(String(error).slice(0, 240)) + "</div>" : "") +
      '<div class="actions"><a class="btn primary" href="#/projects/' + encodeURIComponent(jobId) + '/intelligence">Open Website Intelligence</a>' +
      '<a class="btn" href="#/">Projects</a></div></div>';
  }

  function legacyV1(meta) {
    el.id.textContent = id;
    setStatus(meta.status || "done");
    el.meta.innerHTML = "<span>legacy v1 task (mode " + esc(meta.mode || "url") + ")</span>";
    el.shot.innerHTML =
      '<div class="state" style="border:none"><div class="big">Legacy v1 task</div>' +
      "<div>Live event-stream exploration is a pipeline v2 surface. The v1 run kept its output in the task directory:</div>" +
      '<div class="actions"><a class="btn primary" href="/preview/' + encodeURIComponent(id) + '" target="_blank" rel="noopener">Open preview</a>' +
      '<a class="btn" href="#/">Projects</a></div></div>';
    el.strip.innerHTML = "";
    el.note.textContent = "";
    el.session.innerHTML = "<dt>pipeline</dt><dd>v1 (inline cloneUrl flow)</dd>";
  }

  const unsub = wsSubscribe((msg) => {
    if (!msg) return;
    if (msg.type === "catchup") {
      for (const evt of (msg.data || []).slice(-200)) {
        if (evt && evt.job != null && evt.job !== id && evt.job !== jobId) continue;
        if (evt.type === "page:goto" && evt.data && evt.data.url) setCurrentUrl(evt.data.url);
        push(evt.type, busText(evt.type, evt.data), evt.t, evt.type === "run:error" ? "k-error" : evt.type.startsWith("workflow") ? "k-workflow" : "");
      }
      refreshShots();
      return;
    }
    const p = payloadOf(msg);
    if (msg.type === "page:goto") {
      if (p && p.url) setCurrentUrl(p.url);
      refreshShots();
    } else if (msg.type === "job:status") {
      if (p && (p.jobId === id || p.tempId === id || p.jobId === jobId)) {
        setStatus(p.status);
        if (TERMINAL.has(p.status)) { terminalBanner(p.status, p.error); refreshShots(); }
      }
    } else if (msg.type === "run:done" || msg.type === "run:error") {
      push(msg.type, msg.type === "run:error" ? (p && p.error) || "run error" : "run finished", null, msg.type === "run:error" ? "k-error" : "k-workflow");
      refreshShots();
    } else if (msg.type === "task:done") {
      if (msg.task === id || msg.task === jobId) terminalBanner("completed");
    } else {
      push(msg.type, busText(msg.type, p), null,
        msg.type === "log" && p && p.level === "warn" ? "k-error" : msg.type.startsWith("workflow") ? "k-workflow" : "");
      if (msg.type === "step" || msg.type.startsWith("workflow")) refreshShots();
    }
  });

  await loadJob();
  return () => {
    alive = false;
    unsub();
    if (pollTimer) clearInterval(pollTimer);
  };
}
