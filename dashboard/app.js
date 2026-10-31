// dashboard logic: WS live feed + runs + compare + picker edit
const $ = (s) => document.querySelector(s);
const state = { runId: null, runMeta: null, runs: [], picked: null, armed: false, brief: null };

// ---------- websocket ----------
let ws;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connect, 1500);
}
connect();

async function catchup() {
  const res = await fetch("/api/events");
  const { meta, events } = await res.json();
  if (meta) setRun(meta);
  for (const ev of events) handle(ev);
  await loadRuns();
}
catchup();

function handle(ev) {
  const { type, data } = ev;
  switch (type) {
    case "step": upsertStep(data); break;
    case "log": addLog(data.level || "info", data.msg); break;
    case "tabs:found": addLog("info", `tabs: ${data.tabs.join(" | ").slice(0, 300)}`); break;
    case "assets:progress": updateStep("assets", `downloading assets… ${data.done}/${data.total}`, "running"); break;
    case "model:progress": updateStep(lastVisionStep || "vision", `model working… ${(data.chars / 1000).toFixed(1)}k chars`, "running"); break;
    case "transcript": if (data.transcript) addLog("info", "transcript: " + data.transcript.slice(0, 400)); break;
    case "brief": showBrief(data.brief); break;
    case "run:done":
      setDone();
      loadRuns().then(() => data.outDir && openRun(basename(data.outDir)));
      break;
    case "run:error": addLog("err", "run failed: " + data.error); break;
    case "edit:done": setEditStatus("✔ edit applied", "ok"); break;
    case "edit:fail": setEditStatus("✖ " + data.error, "err"); break;
    case "preview:reload": if (data.run === state.runId) reloadPreview(); break;
    case "catchup": /* handled via /api/events */ break;
  }
}
let lastVisionStep = null;
function basename(p) { return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop(); }

// ---------- steps ----------
const stepOrder = [];
function upsertStep(s) {
  if (!stepOrder.includes(s.id)) stepOrder.push(s.id);
  renderStep(s.id, s.status, s.msg);
  if (["vision", "video", "asr", "polish"].includes(s.id)) lastVisionStep = s.id;
}
function updateStep(id, msg, status) { renderStep(id, status, msg); }
function renderStep(id, status, msg) {
  let el = document.getElementById("step-" + id);
  if (!el) {
    el = document.createElement("div");
    el.id = "step-" + id;
    el.className = "step";
    $("#steps").appendChild(el);
  }
  const icon = { start: "◔", done: "✔", skip: "—", warn: "▲", running: "◔" }[status] || "•";
  el.className = "step " + (status === "skip" ? "skip" : status === "done" ? "done" : status === "warn" ? "warn" : "running");
  el.innerHTML = `<span class="st">${icon}</span><span class="msg">${esc(msg || id)}</span>`;
}
function setDone() {
  document.querySelectorAll(".step.running").forEach((el) => el.classList.replace("running", "done"));
  $("#runInfo").textContent += " — ✔ done";
}
function addLog(level, msg) {
  const line = document.createElement("div");
  if (level !== "info") line.className = level;
  line.textContent = msg;
  $("#log").appendChild(line);
  $("#log").scrollTop = 1e9;
}
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

// ---------- runs ----------
async function loadRuns() {
  const runs = await (await fetch("/api/runs")).json();
  state.runs = runs;
  $("#runsCount").textContent = `${runs.length} run${runs.length === 1 ? "" : "s"}`;
  if (!state.runId && runs.length) openRun(runs[0].id);
  return runs;
}

function openRun(runId) {
  state.runId = runId;
  const meta = state.runs.find((r) => r.id === runId);
  if (!meta) return;
  setRun({ runId, ...meta });
  // clone iframe — rendered at desktop width (1440) and scaled to fit the panel
  $("#cloneFrame").src = `/preview/${runId}/index.html`;
  const openTab = $("#openTab");
  if (openTab) openTab.href = `/preview/${runId}/index.html`;
  requestAnimationFrame(fitPreview);
  setTimeout(fitPreview, 600); // re-fit once content settles
  // screenshots
  const shotUrls = [];
  for (const p of meta.pages || []) {
    if (p.screenshot) shotUrls.push(`/preview/${runId}/${p.screenshot}`);
  }
  const shotsHtml = shotUrls.map((u) => `<img src="${u}" loading="lazy" />`).join("") || `<div class="empty-state">no reference screenshots for this run</div>`;
  $("#shots").innerHTML = shotsHtml;
  $("#shotsC1").innerHTML = shotsHtml;
  $("#shotsC2").innerHTML = `<iframe src="/preview/${runId}/index.html" style="width:100%;height:70vh;border:1px solid var(--line);border-radius:6px;background:#fff"></iframe>`;
  // brief for video mode
  if (meta.mode === "video") fetch(`/preview/${runId}/brief.md`).then((r) => r.text()).then(showBrief).catch(() => {});
}

function setRun(meta) {
  state.runMeta = meta;
  const label = meta.source || meta.finalUrl || meta.runId;
  $("#runInfo").textContent = `${meta.mode || ""} → ${label}`;
  $("#modelChip").textContent = meta.model || "model: auto";
}

function showBrief(text) {
  if (!text) return;
  $("#briefBox").hidden = false;
  $("#briefBody").textContent = text;
}

// ---------- tabs ----------
document.querySelectorAll(".stage-tabs button[data-tab]").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".stage-tabs button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll(".pane").forEach((p) => p.classList.remove("active"));
    $("#pane-" + b.dataset.tab).classList.add("active");
    if (b.dataset.tab === "clone") requestAnimationFrame(fitPreview);
  };
});
$("#reloadPreview").onclick = reloadPreview;

// ---------- desktop-fit preview ----------
const DESKTOP_W = 1440;
function fitPreview() {
  const wrap = $("#frameWrap");
  const frame = $("#cloneFrame");
  if (!wrap || !frame || !$("#pane-clone").classList.contains("active")) return;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (!w || !h) return;
  const scale = w / DESKTOP_W;
  // render the page at a true 1440px desktop viewport, scaled down to the panel width
  frame.style.width = DESKTOP_W + "px";
  frame.style.height = h / scale + "px";
  frame.style.transform = `scale(${scale})`;
  const chip = $("#previewChip");
  if (chip) chip.textContent = `desktop 1440px · ${Math.round(scale * 100)}%`;
}
window.addEventListener("resize", fitPreview);

// ---------- fullscreen ----------
const fsBtn = $("#fsBtn");
if (fsBtn) {
  fsBtn.onclick = () => {
    $("#stage").classList.toggle("fullscreen");
    requestAnimationFrame(fitPreview);
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#stage").classList.contains("fullscreen")) {
      $("#stage").classList.remove("fullscreen");
      requestAnimationFrame(fitPreview);
    }
  });
}
window.addEventListener("load", () => setTimeout(fitPreview, 300));
function reloadPreview() {
  if (state.runId) $("#cloneFrame").src = `/preview/${state.runId}/index.html?r=${Date.now()}`;
}

// ---------- picker + edit ----------
$("#armBtn").onclick = () => {
  state.armed = !state.armed;
  $("#armBtn").classList.toggle("armed", state.armed);
  $("#armBtn").textContent = state.armed ? "⊗ Click element in preview…" : "⊕ Select element";
  $("#cloneFrame").contentWindow.postMessage({ type: "cloner:arm", armed: state.armed }, "*");
};
window.addEventListener("message", (e) => {
  const d = e.data;
  if (d?.type === "cloner:pick") {
    state.picked = d;
    const el = $("#picked");
    el.classList.remove("empty");
    el.innerHTML = `<strong>${esc(d.info.tag)}</strong> ${esc(d.info.classes)}<br/>${esc(d.selector)}<br/><em>${esc((d.info.text || "").slice(0, 120))}</em>`;
    $("#armBtn").classList.remove("armed");
    $("#armBtn").textContent = "⊕ Select element";
    state.armed = false;
  }
});
$("#applyBtn").onclick = async () => {
  const instruction = $("#instruction").value.trim();
  if (!state.runId) return setEditStatus("no run loaded", "err");
  if (!state.picked) return setEditStatus("select an element first (⊕ Select element)", "err");
  if (!instruction) return setEditStatus("describe the change first", "err");
  $("#applyBtn").disabled = true;
  setEditStatus("model editing…", "busy");
  try {
    const res = await fetch("/api/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run: state.runId,
        file: "index.html",
        selector: state.picked.selector,
        info: state.picked.info,
        instruction,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    setEditStatus("✔ applied — preview reloading", "ok");
    $("#instruction").value = "";
  } catch (e) {
    setEditStatus("✖ " + e.message, "err");
  } finally {
    $("#applyBtn").disabled = false;
  }
};
function setEditStatus(msg, cls) {
  const el = $("#editStatus");
  el.textContent = msg;
  el.className = cls;
}
