// Page 6 page-script — reconstruction workspace.
// Sources of truth:
//   • swarm viewer: GET /progress/:jobId (src/platform/progress-routes.js) embedded in the iframe
//   • build log + stage pills: /ws WebSocket (src/platform/server.js) — server pushes
//     {type:"catchup", data:{meta, events}} on connect; client may send {type:"join", task}
//     to scope delivery; live messages are bus-shaped {type, data, t, job} records
//     (workflow.stage / workflow.todo.add / workflow.todo.done / workflow.agent).
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const params = new URLSearchParams(location.search);
const jobId = params.get("job") || params.get("id") || "";

const STAGES = ["exploration", "reconstruction", "verification", "export"]; // public/progress/viewer.js:18
const stageStatus = Object.fromEntries(STAGES.map((s) => [s, "pending"]));
const MAX_LOG_LINES = 300;
let logEl, logCount = 0;

function setWsState(state) {
  const el = $("#ws-state");
  el.textContent = "ws " + state;
  el.className = state === "open" ? "open" : state === "reconnecting" ? "reconnecting" : "";
}

function renderPills() {
  $("#pills").innerHTML = STAGES.map((s) => {
    const st = stageStatus[s];
    return `<span class="pill ${st}" data-stage="${esc(s)}"><span class="dot"></span>${esc(s)}${st === "running" ? " …" : ""}</span>`;
  }).join("");
}

function logLine({ type, data, t, job }, isCatchup) {
  if (!logEl) return;
  const foreign = job && jobId && job !== jobId;
  const line = document.createElement("div");
  if (foreign) line.className = "foreign";
  const time = new Date(Number(t) || Date.now()).toLocaleTimeString();
  let body = "";
  if (type === "workflow.stage") body = `stage ${data?.stage ?? "?"}${data?.status ? " → " + data.status : ""}${data?.progress != null ? ` (${data.progress})` : ""}`;
  else if (type === "workflow.todo.add") body = `+ build unit: ${data?.label ?? data?.id ?? "?"}${data?.route ? " [" + data.route + "]" : ""}`;
  else if (type === "workflow.todo.done") body = `✓ done: ${data?.label ?? data?.id ?? "?"}${data?.note ? " — " + data.note : ""}${data?.agent && data.agent !== data.label ? " (" + data.agent + ")" : ""}`;
  else if (type === "workflow.agent") body = `agent ${data?.name ?? data?.id ?? "?"} announced`;
  else body = JSON.stringify(data || {}).slice(0, 160);
  line.innerHTML = `<span class="t">${time}${isCatchup ? " ⏮" : ""}</span> <span class="type">${esc(type)}</span> ${esc(body)}`;
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  logEl.appendChild(line);
  logCount++;
  while (logEl.childNodes.length > MAX_LOG_LINES) logEl.removeChild(logEl.firstChild);
  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

function applyEvent(evt) {
  if (evt?.type === "workflow.stage" && STAGES.includes(evt.data?.stage)) {
    stageStatus[evt.data.stage] = evt.data.status || "running";
    renderPills();
  }
  logLine(evt, evt?._catchup);
}

// ---- /ws connection: catchup replay then live, with reconnect backoff ----
let ws = null, wsBackoff = 1000, wsStopped = false;
function connectWs() {
  if (wsStopped) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  try { ws = new WebSocket(`${proto}//${location.host}/ws`); } catch (e) { setWsState("error"); return scheduleReconnect(); }
  setWsState("connecting");
  ws.onopen = () => {
    setWsState("open");
    wsBackoff = 1000;
    // legacy loopback dashboard joins by task id; authenticated sockets get
    // scoped delivery automatically (src/platform/server.js connection handler)
    if (jobId) { try { ws.send(JSON.stringify({ type: "join", task: jobId })); } catch { /* closed already */ } }
  };
  ws.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.type === "catchup") {
      const events = Array.isArray(msg.data) ? msg.data : (msg.data?.events || []);
      for (const evt of events) applyEvent({ ...evt, _catchup: true });
      logLine({ type: "log.replay", data: { replayed: events.length }, t: Date.now() }, false);
    } else if (msg.type) {
      applyEvent(msg);
    }
  };
  ws.onclose = () => { setWsState("closed"); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
}
function scheduleReconnect() {
  setWsState("reconnecting");
  setTimeout(connectWs, wsBackoff);
  wsBackoff = Math.min(wsBackoff * 2, 15000);
}

// ---- swarm viewer iframe (the live build animation — default view) ----
function embedSwarm() {
  const f = $("#swarm");
  if (!jobId) {
    $("#frame-note").textContent = "no job selected — open with ?job=<jobId>";
    $("#job-body").innerHTML = '<span style="color:var(--err)">no job id in URL (?job=…)</span>';
    return;
  }
  f.src = `/progress/${encodeURIComponent(jobId)}`;
  f.addEventListener("load", () => { $("#frame-note").textContent = `embedded swarm viewer · /progress/${jobId} (live build animation)`; });
  f.addEventListener("error", () => { $("#frame-note").textContent = "swarm viewer failed to load"; });
}

// ---- job status (registry read; honest when absent) ----
async function loadJob() {
  const el = $("#job-body");
  if (!jobId) return;
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`).catch(() => null);
  if (!res || !res.ok) {
    el.innerHTML = res ? `<span style="color:var(--warn)">job registry: HTTP ${res.status} — status shown from /ws events only</span>`
      : '<span style="color:var(--warn)">job registry unreachable — status shown from /ws events only</span>';
    return;
  }
  const job = await res.json().catch(() => null);
  el.innerHTML = job
    ? `<div>status: <b>${esc(job.status || "?")}</b>${job.url ? ` · ${esc(job.url)}` : ""}</div>
       ${job.verification ? `<div class="kv">verification: ${job.verification.passed ? "PASSED" : "completed with failures"}</div>` : ""}`
    : "job registry returned nothing";
}

function boot() {
  logEl = $("#log");
  $("#src-line").textContent = jobId ? `job ${jobId}` : "no job selected";
  renderPills();
  embedSwarm();
  loadJob();
  connectWs();
}

boot();
