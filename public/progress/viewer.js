// Swarm build viewer — OUR OWN scratch-built animation (no external code, no
// dependencies, no CDNs). While a clone runs, labeled cursor-agents fly to
// build-unit slots and draw them layer-by-layer as the job's REAL workflow
// events stream in over SSE from src/platform/progress-routes.js.
//
// EVENT CONTRACT (bus-shaped { type, data } records — see src/events.js):
//   workflow.stage      { stage }             exploration → reconstruction → verification → export
//   workflow.todo.add   { id, label, route }  one build unit enters the plan
//   workflow.todo.done  { id, agent? }        an agent finishes that unit and draws it
//   workflow.agent      { id, name }          an agent announces itself
//
// TESTABLE CORE: STAGES / createModel / applyEvent / hudText / layoutSlot are
// pure and exported — scripts/test-progress-viewer.mjs drives the fixture
// through them in Node without a browser. The browser-only block at the bottom
// wires SSE + demo mode (?demo=1 plays fixtures/progress-events.json, served at
// /progress/demo-events.json; &interval=<ms> speeds the playback up).

export const STAGES = ["exploration", "reconstruction", "verification", "export"];
export const AGENT_COLORS = ["#4ade80", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa", "#f87171"];
export const CANVAS = { w: 960, h: 560 };

// Deterministic slot layout: a 3-wide grid so six units fill two rows.
export function layoutSlot(index) {
  const w = 272, h = 132, gx = 24, gy = 44, x0 = 24, y0 = 88;
  const col = index % 3;
  const row = Math.floor(index / 3);
  const x = x0 + col * (w + gx);
  const y = y0 + row * (h + gy);
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

export function createModel() {
  return { stage: null, stageIndex: -1, units: [], agents: [], doneCount: 0, seen: 0 };
}

// HUD line: "N agents · X/Y units · <stage>"
export function hudText(model) {
  return `${model.agents.length} agents · ${model.doneCount}/${model.units.length} units · ${model.stage || "—"}`;
}

function findUnit(model, id) {
  return (id != null && model.units.find((u) => u.id === id)) || null;
}

// The agent that gets credit for a finished unit: the event's agent when it
// names a known one, otherwise the least-loaded known agent (ties broken by
// announcement order). With no agents announced yet, one is spawned so a
// todo.done always produces a visible drawer.
function pickAgent(model, wanted) {
  if (wanted) {
    const known = model.agents.find((a) => a.id === wanted);
    if (known) return known;
  }
  if (model.agents.length === 0) {
    model.agents.push({ id: "agent-auto-1", name: "auto", color: AGENT_COLORS[0], completed: 0, target: null });
  }
  let best = model.agents[0];
  for (const a of model.agents) if (a.completed < best.completed) best = a;
  return best;
}

// Apply one bus-shaped event. Mutates the model, returns it. Unknown types and
// out-of-order events (done before add, duplicate ids, backwards stages) are
// counted as seen but change nothing.
export function applyEvent(model, evt) {
  const data = (evt && evt.data) || {};
  switch (evt && evt.type) {
    case "workflow.stage": {
      const i = STAGES.indexOf(String(data.stage || "").toLowerCase());
      if (i > model.stageIndex) {
        model.stage = STAGES[i];
        model.stageIndex = i;
      }
      break;
    }
    case "workflow.agent": {
      const id = data.id || data.agentId;
      if (id && !model.agents.some((a) => a.id === id)) {
        model.agents.push({
          id,
          name: String(data.name || data.agent || id),
          color: AGENT_COLORS[model.agents.length % AGENT_COLORS.length],
          completed: 0,
          target: null,
        });
      }
      break;
    }
    case "workflow.todo.add": {
      const id = data.id || data.todoId;
      if (id && !findUnit(model, id)) {
        model.units.push({
          id,
          label: String(data.label || data.title || id),
          route: data.route || data.routePath || null,
          status: "pending",
          agent: null,
          slot: layoutSlot(model.units.length),
        });
      }
      break;
    }
    case "workflow.todo.done": {
      const unit = findUnit(model, data.id || data.todoId);
      if (unit && unit.status !== "done") {
        const agent = pickAgent(model, data.agent);
        unit.status = "done";
        unit.agent = agent.id;
        agent.completed += 1;
        agent.target = unit.id; // the renderer flies this agent to unit.slot
        model.doneCount += 1;
      }
      break;
    }
  }
  model.seen += 1;
  return model;
}

// ============================ browser-only wiring ============================
if (typeof document !== "undefined") {
  const $ = (sel) => document.querySelector(sel);
  const WORKFLOW_TYPES = ["workflow.stage", "workflow.todo.add", "workflow.todo.done", "workflow.agent"];
  const model = createModel();
  // Renderer-only state (pixel positions, painted flags, flight queues) —
  // never part of the model. Each agent works its done units FIFO: it flies to
  // the oldest one it was credited, paints it, then takes the next, so a unit
  // finished earlier by a reassigned agent is still visibly drawn.
  const view = { pos: new Map(), painted: new Set(), queues: new Map(), queued: new Set() };
  window.__swarm = { model, view }; // test hook (scripts/test-progress-viewer.mjs section C)

  const banner = $("#banner");
  for (const s of STAGES) {
    const el = document.createElement("span");
    el.textContent = s;
    banner.append(el);
  }

  function renderDom() {
    $("#hud").textContent = hudText(model);
    banner.querySelectorAll("span").forEach((el, i) => {
      el.classList.toggle("active", i === model.stageIndex);
      el.classList.toggle("done", i < model.stageIndex);
    });
    const ul = $("#todos");
    ul.innerHTML = "";
    for (const u of model.units) {
      const li = document.createElement("li");
      if (u.status === "done") li.className = "done";
      const check = document.createElement("span");
      check.className = "check";
      check.textContent = u.status === "done" ? "✓" : "○";
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = u.label;
      const route = document.createElement("span");
      route.className = "route";
      route.textContent = u.route || "";
      li.append(check, lbl, route);
      ul.append(li);
    }
  }

  function onEvent(evt) {
    applyEvent(model, evt);
    ensureAgents();
    queueFlights();
    renderDom();
  }

  // Hand every newly-done unit to its credited agent's FIFO flight queue.
  function queueFlights() {
    for (const u of model.units) {
      if (u.status === "done" && u.agent && !view.queued.has(u.id)) {
        view.queued.add(u.id);
        if (!view.queues.has(u.agent)) view.queues.set(u.agent, []);
        view.queues.get(u.agent).push(u.id);
      }
    }
  }

  function ensureAgents() {
    model.agents.forEach((a, i) => {
      if (!view.pos.has(a.id)) {
        view.pos.set(a.id, { x: 300 + i * 120, y: CANVAS.h - 30, dir: -Math.PI / 2 });
      }
    });
  }

  // ---- event source: live SSE, or the fixture player in demo mode ----
  const m = location.pathname.match(/^\/progress\/([^/]+)\/?$/);
  const jobId = m ? decodeURIComponent(m[1]) : "local";
  const params = new URLSearchParams(location.search);
  const conn = $("#conn");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function playDemo(intervalMs) {
    conn.textContent = "demo · fixture";
    conn.className = "demo";
    try {
      const payload = await (await fetch("/progress/demo-events.json")).json();
      // Accept either a bare event array or a { job, events: [...] } envelope.
      const events = Array.isArray(payload) ? payload : payload.events || [];
      for (const evt of events) {
        onEvent(evt);
        await sleep(intervalMs);
      }
      conn.textContent = "demo · complete";
    } catch {
      conn.textContent = "demo unavailable";
    }
  }

  function startSSE() {
    const es = new EventSource(`/progress/${encodeURIComponent(jobId)}/events`);
    let got = false;
    for (const type of WORKFLOW_TYPES) {
      es.addEventListener(type, (e) => {
        got = true;
        onEvent(JSON.parse(e.data));
      });
    }
    es.addEventListener("hello", () => {
      conn.textContent = "live · sse";
      conn.className = "live";
    });
    // One-shot fallback: no fixture events arrived over SSE (bridge not wired
    // yet) → switch to the fixture demo so the page is never a dead canvas.
    es.onerror = () => {
      if (!got && !params.has("demo")) {
        es.close();
        playDemo(600);
      }
    };
  }

  // ---- canvas render loop ----
  const ctx = $("#swarm").getContext("2d");
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  function agentColor(id) {
    const a = id && model.agents.find((x) => x.id === id);
    return a ? a.color : "#94a3b8";
  }

  function frameRect(x, y, w, h) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 10);
    else ctx.rect(x, y, w, h);
  }

  function moveAgents() {
    for (const a of model.agents) {
      const p = view.pos.get(a.id);
      if (!p) continue;
      const queue = view.queues.get(a.id) || [];
      const unit = queue.length ? findUnit(model, queue[0]) : null;
      // Draw point: the slot's top-right corner — where the checkmark lands.
      const tx = unit ? unit.slot.x + unit.slot.w - 18 : p.x;
      const ty = unit ? unit.slot.y + 18 : p.y;
      const dx = tx - p.x;
      const dy = ty - p.y;
      const d = Math.hypot(dx, dy);
      if (unit && d < 6) {
        view.painted.add(unit.id);
        queue.shift(); // unit drawn — take the next one this agent owes
      }
      if (d > 1) {
        p.dir = Math.atan2(dy, dx);
        p.x += dx * 0.07;
        p.y += dy * 0.07;
      }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, CANVAS.w, CANVAS.h);
    for (const u of model.units) {
      const s = u.slot;
      const painted = u.status === "done" && view.painted.has(u.id);
      if (painted) {
        const color = agentColor(u.agent);
        frameRect(s.x, s.y, s.w, s.h);
        ctx.fillStyle = "rgba(17,26,46,.94)";
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "600 15px system-ui, sans-serif";
        ctx.fillText(clip(u.label, 30), s.x + 14, s.y + 34);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText(clip(u.route || "", 34), s.x + 14, s.y + 58);
        ctx.fillStyle = color;
        ctx.font = "700 16px system-ui, sans-serif";
        ctx.fillText("✓", s.x + s.w - 32, s.y + 24);
      } else {
        frameRect(s.x, s.y, s.w, s.h);
        ctx.setLineDash([6, 6]);
        ctx.strokeStyle = u.status === "done" ? "#64748b" : "#334155";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#475569";
        ctx.font = "13px system-ui, sans-serif";
        ctx.fillText(clip(u.label, 30), s.x + 14, s.y + 30);
      }
    }
    for (const a of model.agents) {
      const p = view.pos.get(a.id);
      if (!p) continue;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.dir);
      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.moveTo(11, 0);
      ctx.lineTo(-7, 6);
      ctx.lineTo(-3, 0);
      ctx.lineTo(-7, -6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  (function loop() {
    moveAgents();
    draw();
    requestAnimationFrame(loop);
  })();

  ensureAgents();
  renderDom();
  if (params.get("demo") === "1") playDemo(Math.max(20, Number(params.get("interval")) || 600));
  else startSSE();
}
