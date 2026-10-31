// Platform UI logic — task create/list/switch, tabbed workspace (clone / original /
// compare / exploration / verification), element picker + inspector, chat bar,
// export, live WS activity log. Contracts fixed by src/platform/server.js.
"use strict";

const $ = (s) => document.querySelector(s);
const state = { tasks: [], meta: null, current: null, picked: null, armed: false, frameTask: null };

// ---------- helpers ----------
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hhmmss = (d = new Date()) => d.toLocaleTimeString([], { hour12: false });
function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60e3) return "just now";
  if (ms < 3600e3) return `${Math.floor(ms / 60e3)}m ago`;
  if (ms < 86400e3) return `${Math.floor(ms / 3600e3)}h ago`;
  return new Date(iso).toLocaleDateString();
}
const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

// ---------- sidebar: task list + history ----------
async function refreshTasks() {
  state.tasks = await api("/api/tasks").catch(() => []);
  const ul = $("#task-list");
  ul.innerHTML = state.tasks.map((t) => `
    <li data-id="${t.id}" class="${t.id === state.current ? "active" : ""}">
      <span class="status-dot ${esc(t.status)}" title="${esc(t.status)}"></span>
      <span class="t-title">${esc(hostOf(t.url))}</span>
      <span class="t-meta">${esc(t.status)} · ${esc(relTime(t.createdAt))}</span>
    </li>`).join("") || `<li class="empty-note" style="cursor:default">no tasks — paste a URL below</li>`;
  ul.querySelectorAll("li[data-id]").forEach((li) => (li.onclick = () => selectTask(li.dataset.id)));

  const sel = $("#task-switch");
  sel.innerHTML = state.tasks.length
    ? state.tasks.map((t) => `<option value="${t.id}" ${t.id === state.current ? "selected" : ""}>${esc(t.id)} · ${esc(hostOf(t.url))} · ${esc(t.status)}</option>`).join("")
    : `<option value="">no tasks yet</option>`;
}

function renderHistory(t) {
  $("#history-owner").textContent = t.id;
  const hist = (t.history || []).slice().reverse(); // latest first
  $("#history").innerHTML = hist.map((h) => `
    <li><span class="h-event">${esc(h.event)}</span><br><span class="h-time">${esc(new Date(h.at).toLocaleTimeString([], { hour12: false }))} · ${esc(relTime(h.at))}</span></li>`).join("")
    || `<li class="empty-note">no events</li>`;
}

async function selectTask(id) {
  state.current = id;
  const t = await api(`/api/tasks/${id}`).catch((e) => { appendLog(`task ${id}: ${e.message}`, "warn"); return null; });
  if (!t) return;
  state.meta = t;
  renderTask(t);
  renderHistory(t);
  refreshTasks();
}

// ---------- workspace: tabs + per-view rendering ----------
const STATUS_PILL = { done: "done", error: "error", running: "running", verifying: "verifying" };

function renderTask(t) {
  const pill = $("#task-status-pill");
  pill.textContent = t.status;
  pill.className = `status-pill ${STATUS_PILL[t.status] || ""}`;
  $("#btn-export").disabled = !(t.status === "done" || t.status === "exported");

  // clone iframe — only re-navigate when the task actually changes (avoid flicker on poll)
  if (state.frameTask !== t.id) {
    state.frameTask = t.id;
    $("#frame-clone").src = `/preview/${t.id}/index.html`;
    if (state.armed) rearm(); // fresh document needs the picker re-armed
  }
  setImg("#img-original", "#empty-original", `/preview/${t.id}/_reference/page-1.png`);
  setImg("#img-diff", "#empty-diff", `/preview/${t.id}/_reference/diff.png`);
  setImg("#ab-orig", "#empty-ab", `/preview/${t.id}/_reference/page-1.png`, true);
  setImg("#ab-clone", "#empty-ab", `/preview/${t.id}/_reference/clone-verify.png`, true);
  loadExploration(t);
  renderVerification(t);
}

// image with empty-state fallback; pair=true hides the shared empty only when both imgs are ok
const imgState = {};
function setImg(imgSel, emptySel, src, pair) {
  const img = $(imgSel), key = imgSel;
  img.onerror = () => { imgState[key] = false; $(emptySel).classList.remove("hidden"); };
  img.onload = () => {
    imgState[key] = true;
    if (pair) {
      const both = Object.keys(imgState).filter((k) => k.startsWith("#ab-"));
      if (both.every((k) => imgState[k])) $("#empty-ab").classList.add("hidden");
    } else $(emptySel).classList.add("hidden");
  };
  if (img.getAttribute("src") !== src) img.src = src;
}

// exploration report — real table from exploration.json, md fallback
async function loadExploration(t) {
  const file = t.artifacts?.exploration;
  const box = $("#expl-content");
  $("#expl-meta").textContent = "";
  if (!file) { box.innerHTML = `<p class="empty-note">exploration report not available yet</p>`; return; }
  let data;
  try { data = await (await fetch(`/preview/${t.id}/${file}`)).text(); } catch { box.innerHTML = `<p class="empty-note">could not load ${esc(file)}</p>`; return; }
  if (file.endsWith(".json")) {
    let j; try { j = JSON.parse(data); } catch { box.innerHTML = `<p class="empty-note">exploration.json unparseable</p>`; return; }
    const b = Array.isArray(j.behaviors) ? j.behaviors : [];
    $("#expl-meta").textContent = `${b.length} behavior${b.length === 1 ? "" : "s"} · ${esc(j.generatedAt || "")}`;
    box.innerHTML = b.length ? `
      <table class="expl-table">
        <thead><tr><th>Trigger</th><th>Opens</th><th>Discovered panels / entries</th><th>State</th></tr></thead>
        <tbody>${b.map(behaviorRow).join("")}</tbody>
      </table>` : `<p class="empty-note">no interactive behaviors were recorded</p>`;
  } else {
    box.innerHTML = `<pre class="md-pre">${esc(data)}</pre>`; // exploration.md fallback — same table, raw
  }
}
function behaviorRow(b) {
  const tr = b.trigger || {};
  const op = b.opens ? `<span class="open-box">${esc(b.opens.kind || "opens")} ${b.opens.w || "?"}×${b.opens.h || "?"}</span>` : `<span class="open-box">—</span>`;
  const panels = (b.childPanels || []).map((c) => `<span class="panel-chip">${esc(c.text || c.kind || "?")} <span style="color:var(--faint)">${c.w ? `${c.w}×${c.h}` : ""}</span></span>`).join("") || `<span class="open-box">—</span>`;
  const shot = b.screenshot ? `<img class="state-thumb" loading="lazy" title="open full state" src="/preview/${esc(state.current)}/${stateShot(b.screenshot)}" data-full="/preview/${esc(state.current)}/${stateShot(b.screenshot)}">` : `<span class="open-box">—</span>`;
  return `<tr>
    <td><span class="trigger-label">${esc(tr.label || tr.id || "?")}</span>${tr.id ? `<span class="trigger-id">${esc(tr.id)}</span>` : ""}</td>
    <td>${op}</td><td>${panels}</td><td>${shot}</td>
  </tr>`;
}
const stateShot = (s) => (s.includes("/") ? s : `_reference/states/${s}`);

// verification — 3 stages with pass/fail (task.json.verification, written by verify.js)
function renderVerification(t) {
  const v = t.verification;
  const banner = $("#ver-banner"), grid = $("#ver-stages");
  if (!v) {
    banner.className = "ver-banner pending";
    banner.innerHTML = `verification ${t.status === "done" ? "unavailable" : "pending"} <span class="muted">status: ${esc(t.status)}</span>`;
    grid.innerHTML = ""; return;
  }
  banner.className = `ver-banner ${v.passed ? "passed" : "failed"}`;
  banner.innerHTML = `${v.passed ? "✓ All 3 stages passed" : "✗ Completed with failures"} <span class="muted">${esc(v.generatedAt || "")}</span>`;
  const STAGE_ICON = { structural: "▤", visual: "◑", functional: "⚡" };
  grid.innerHTML = `<div class="ver-grid">${(v.stages || []).map((s, i) => `
    <div class="stage-card">
      <div class="stage-head"><span class="stage-num">S${i + 1}</span> ${STAGE_ICON[s.stage] || ""} ${esc(s.stage)}
        <span class="pill ${s.passed ? "pass" : "fail"}">${s.passed ? "pass" : "fail"}</span></div>
      <div class="stage-checks">${(s.checks || []).map((c) => `
        <div class="check-row"><span class="ck ${c.ok ? "ok" : "no"}">${c.ok ? "✓" : "✗"}</span>
          <span>${esc(c.name)}<span class="detail">${esc(c.detail || "")}</span></span></div>`).join("")}
        ${s.metrics ? `<div class="metric-chips">${Object.entries(s.metrics).map(([k, n]) => `<span>${esc(k)}: ${esc(n)}</span>`).join("")}</div>` : ""}
        ${Array.isArray(s.results) && s.results.length ? `<table class="fn-table">${s.results.map((r) => `<tr><td>trigger ${esc(r.trigger)}</td><td class="${r.opened ? "ok" : "no"}">${r.opened ? "opened ✓" : "no overlay"}</td></tr>`).join("")}</table>` : ""}
      </div>
    </div>`).join("")}</div>`;
}

// tabs
$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab"); if (!tab) return;
  document.querySelectorAll("#tabs .tab").forEach((x) => x.classList.toggle("active", x === tab));
  for (const v of document.querySelectorAll(".view")) v.classList.toggle("hidden", v.id !== "view-" + tab.dataset.view);
});

// ---------- compare tab: heatmap / A|B slider ----------
$("#view-compare").addEventListener("click", (e) => {
  const seg = e.target.closest(".seg"); if (!seg) return;
  document.querySelectorAll(".seg").forEach((x) => x.classList.toggle("active", x === seg));
  $("#cmp-heatmap").classList.toggle("hidden", seg.dataset.cmp !== "heatmap");
  $("#cmp-ab").classList.toggle("hidden", seg.dataset.cmp !== "ab");
});
(() => { // drag divider → --cmp-x
  const wrap = $("#ab-wrap");
  const setX = (clientX) => {
    const r = wrap.getBoundingClientRect();
    wrap.style.setProperty("--cmp-x", `${Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100))}%`);
  };
  wrap.addEventListener("pointerdown", (e) => {
    wrap.setPointerCapture(e.pointerId); setX(e.clientX);
    const mv = (ev) => setX(ev.clientX);
    wrap.addEventListener("pointermove", mv);
    wrap.addEventListener("pointerup", () => wrap.removeEventListener("pointermove", mv), { once: true });
  });
})();

// ---------- chat bar: URL → new task, else instruction for picked element ----------
const URL_RE = /https?:\/\/[^\s"'<>]+/;
async function submitChat() {
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  const m = text.match(URL_RE);
  try {
    if (m) { // contains a URL → clone task (even if an element is picked; URL intent wins per spec)
      input.value = "";
      appendLog(`creating task for ${m[0]}`, "sys");
      const t = await api("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: m[0], instructions: text }) });
      appendLog(`task ${t.id} queued — clone started`, "ok");
      openDock("activity");
      await refreshTasks();
      selectTask(t.id);
    } else if (state.current && state.picked) { // instruction for the picked element — context kept for follow-ups
      const { selector, info } = state.picked;
      appendLog(`applying to ${selector}: ${text}`, "sys");
      await api(`/api/tasks/${state.current}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selector, info, instruction: text }) });
      appendLog("instruction applied — reloading preview", "ok");
      input.value = "";
      setTimeout(reloadPreview, 450); // server also broadcasts preview:reload; this covers a missed event
    } else if (!state.current) {
      appendLog("no task yet — paste a URL to start one", "warn");
    } else {
      appendLog("pick an element first (⌖) or paste a URL", "warn");
    }
  } catch (e) {
    appendLog(`error: ${e.message}`, "error");
  }
}
$("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitChat(); });
$("#btn-send").addEventListener("click", submitChat);

function reloadPreview() {
  if (!state.current) return;
  try { $("#frame-clone").contentWindow.location.reload(); } catch { $("#frame-clone").src = `/preview/${state.current}/index.html`; }
}

// ---------- element picker (injected src/picker.js) ----------
// picker posts {type:'cloner:pick', selector, info} (and 'cloner-pick' per spec) to the parent
window.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "cloner:pick" || d.type === "cloner-pick") {
    state.picked = { selector: d.selector, info: d.info || {} };
    $("#pick-chip-selector").textContent = d.selector;
    $("#pick-chip").classList.remove("hidden");
    renderInspector();
    openDock("element");
  }
  if (d.type === "cloner:ready") if (state.armed) rearm(); // iframe (re)loaded while armed
});

$("#btn-pick").addEventListener("click", () => {
  state.armed = !state.armed;
  rearm();
  if (state.armed) openDock("element");
  else appendLog("picker off", "sys");
});
function rearm() {
  const win = $("#frame-clone").contentWindow;
  try {
    win.postMessage({ type: "cloner:arm", armed: state.armed }, "*");
    win.postMessage({ type: "cloner-toggle-pick" }, "*"); // legacy spelling
  } catch {}
  $("#btn-pick").classList.toggle("armed", state.armed);
  if (!state.armed) $("#btn-pick").classList.remove("armed");
}
$("#pick-chip-clear").addEventListener("click", () => {
  state.picked = null;
  $("#pick-chip").classList.add("hidden");
  try { $("#frame-clone").contentWindow.postMessage({ type: "cloner:deselect" }, "*"); } catch {}
});

// inspector — element name / box / classes; box measured live from the same-origin preview
function renderInspector() {
  const { selector, info } = state.picked || {};
  if (!selector) return;
  const box = $("#inspector");
  const cls = (info.classes || "").trim();
  let rectHtml = `<dt>box</dt><dd>${esc(info.outerHTML ? "from pick" : "")}</dd>`;
  try { // same-origin: measure the real element for x/y/w×h
    const doc = $("#frame-clone").contentDocument;
    const el = doc && doc.querySelector(selector);
    if (el) {
      const r = el.getBoundingClientRect();
      rectHtml = `<dt>box</dt><dd>x ${Math.round(r.left + (doc.defaultView.scrollX || 0))} · y ${Math.round(r.top + (doc.defaultView.scrollY || 0))} · ${Math.round(r.width)}×${Math.round(r.height)}</dd>`;
    }
  } catch {}
  const styles = info.styles || {};
  const styleRow = (label, val, swatch) => val == null || val === "" ? "" : `<dt>${label}</dt><dd>${swatch ? `<span class="swatch" style="background:${esc(val)}"></span>` : ""}${esc(val)}</dd>`;
  box.innerHTML = `
    <p class="insp-name"><span class="insp-tag">&lt;${esc(info.tag || "?")}&gt;</span></p>
    <p class="insp-sub">${esc(selector)}</p>
    <div class="insp-sec">Box</div>
    <dl class="insp-grid">
      ${rectHtml}
      <dt>classes</dt><dd>${esc(cls || "—")}</dd>
      ${styleRow("color", styles.color, true)}
      ${styleRow("background", styles.background, true)}
      ${styleRow("font", [styles.fontSize, styles.fontWeight].filter(Boolean).join(" / "))}
      ${styleRow("padding", styles.padding)}
      ${styleRow("radius", styles.borderRadius)}
    </div>
    ${info.text ? `<div class="insp-sec">Text</div><p class="insp-text">${esc(info.text)}</p>` : ""}
    ${info.outerHTML ? `<div class="insp-sec">HTML</div><pre class="insp-html">${esc(info.outerHTML)}</pre>` : ""}`;
}

// ---------- right dock ----------
function openDock(tab) {
  document.body.classList.add("dock-open");
  setDockTab(tab);
}
function setDockTab(tab) {
  document.querySelectorAll(".dock-tab").forEach((b) => b.classList.toggle("active", b.dataset.dock === tab));
  $("#dock-element").classList.toggle("hidden", tab !== "element");
  $("#dock-activity").classList.toggle("hidden", tab !== "activity");
}
document.querySelector(".dock-tabs").addEventListener("click", (e) => {
  if (e.target.id === "btn-dock-close") { document.body.classList.remove("dock-open"); return; }
  const t = e.target.closest(".dock-tab"); if (t) setDockTab(t.dataset.dock);
});

// ---------- activity log ----------
const logEl = $("#log");
let logStick = true;
logEl.parentElement.addEventListener("scroll", () => { logStick = logEl.parentElement.scrollHeight - logEl.parentElement.scrollTop - logEl.parentElement.clientHeight < 30; });
function appendLog(msg, cls = "info", at = null) {
  const line = document.createElement("div");
  line.className = `log-line ${cls}`;
  line.innerHTML = `<span class="lt">${at ? esc(hhmmss(new Date(at))) : hhmmss()}</span><span class="lm">${esc(msg)}</span>`;
  logEl.appendChild(line);
  while (logEl.children.length > 400) logEl.firstChild.remove();
  if (logStick) logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
}

// ---------- websocket progress ----------
function handleWsEvent(m, at = null) {
  const d = m.data || {};
  switch (m.type) {
    case "step": {
      const icon = d.status === "start" ? "▶" : d.status === "done" ? "✓" : d.status === "skip" ? "○" : "•";
      appendLog(`${icon} [${d.id || "step"}] ${d.msg || d.status || ""}`, d.status === "done" ? "ok" : "step", at);
      break;
    }
    case "log": appendLog(d.msg || "", d.level || "info", at); break;
    case "task:done":
      appendLog(`task ${m.task || ""} finished — verification ${d.verification ? "passed" : "completed with failures"}`, d.verification ? "ok" : "warn");
      refreshTasks();
      if (m.task === state.current) selectTask(m.task);
      break;
    case "preview:reload":
      if (m.task === state.current) { appendLog("preview updated", "sys"); reloadPreview(); }
      break;
    case "run:error": appendLog(`run error: ${d.error || d.message || JSON.stringify(d).slice(0, 140)}`, "error", at); break;
    case "catchup": (m.data?.events || []).forEach((e2) => handleWsEvent(e2, e2.t)); break; // replay ring buffer
    case "progress": appendLog(`▸ ${d.type || "progress"} ${JSON.stringify(d.data || {}).slice(0, 120)}`, "step", at); break;
    default: { // assets:*, tabs:found, page:goto, run:done, polish:round …
      const brief = typeof d === "object" ? JSON.stringify(d).slice(0, 140) : String(d);
      appendLog(`[${m.type}] ${brief}`, "sys", at);
    }
  }
}
function connectWs() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss://" : "ws://"}${location.host}/ws`);
  ws.onmessage = (e) => { try { handleWsEvent(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => setTimeout(connectWs, 3000); // auto-reconnect; catchup covers the gap
}

// ---------- export ----------
$("#btn-export").addEventListener("click", async (e) => {
  if (!state.current) return;
  const btn = e.currentTarget;
  btn.classList.add("busy"); btn.disabled = true;
  try {
    const r = await api(`/api/export/${state.current}`, { method: "POST" });
    window.open(r.download, "_blank");
    appendLog(`export ready (${((r.size || 0) / 1048576).toFixed(1)}MB) — credentials shredded`, "ok");
    refreshTasks();
  } catch (err) { appendLog(`export failed: ${err.message}`, "error"); }
  btn.classList.remove("busy"); btn.disabled = false;
});

// ---------- top bar ----------
$("#task-switch").addEventListener("change", (e) => { if (e.target.value) selectTask(e.target.value); });
$("#btn-activity").addEventListener("click", () => {
  const open = document.body.classList.contains("dock-open");
  if (open) document.body.classList.remove("dock-open"); else openDock("activity");
});

// settings modal
const modal = $("#modal-root");
$("#btn-settings").addEventListener("click", () => { modal.classList.remove("hidden"); loadSessions(); });
$("#btn-modal-close").addEventListener("click", () => modal.classList.add("hidden"));
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") modal.classList.add("hidden"); });
async function loadSessions() {
  try {
    const s = await api("/api/sessions");
    $("#sessions-info").textContent = `${s.active} active session(s)${s.ids?.length ? " — " + s.ids.join(", ") : " (idle — spawns per task)"}`;
  } catch { $("#sessions-info").textContent = "sessions endpoint unavailable"; }
}
$("#btn-sessions-refresh").addEventListener("click", loadSessions);

// ---------- boot ----------
$("#empty-clone-text").textContent = "no task selected — paste a URL in the chat bar below";
refreshTasks().then(() => { if (state.tasks.length) selectTask(state.tasks[0].id); });
setInterval(refreshTasks, 4000); // live status dots
connectWs();
appendLog("platform UI ready — paste a URL to clone a site", "sys");
