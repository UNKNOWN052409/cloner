// Hash router for the 8-page product shell. No framework, no CDN.
//
// Fragment pages (1-4) live in pages/<name>.html + pages/<name>.js — the
// router fetches the fragment into #view, dynamic-imports the page module and
// calls its default (root, ctx) render. A page may return a cleanup function;
// the router calls it before the next render. Pages 5-8 are standalone
// documents owned by the later-increment page task; their nav anchors carry
// data-ext and the router probes the document, falling back to an honest
// "ships later" state instead of a raw 404.

let ROUTES = [];
let outlet = null;
let currentCleanup = null;
let currentKey = null;

// Resolve a UI-relative path against app.js's own URL so the shell works at
// any static mount point (/, /app/, …). API/artifact/progress paths stay
// origin-absolute by contract.
const UI_BASE = new URL("./", import.meta.url).pathname;
export function uiPath(rel) {
  return UI_BASE + rel;
}

export function registerRoutes(routes) {
  ROUTES = routes;
}

export function start(el) {
  outlet = el;
  window.addEventListener("hashchange", () => render());
  interceptExtClicks();
  return render();
}

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// match "#/projects/abc/intelligence" against "/projects/:id/intelligence"
function matchRoute(path) {
  for (const route of ROUTES) {
    if (route.ext) continue;
    const pat = route.pattern.split("/").filter(Boolean);
    const seg = path.split("/").filter(Boolean);
    if (pat.length !== seg.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      if (pat[i].startsWith(":")) params[pat[i].slice(1)] = decodeURIComponent(seg[i]);
      else if (pat[i] !== seg[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

function markNav(route) {
  for (const a of document.querySelectorAll(".topnav nav a")) {
    if (route && a.dataset.page === String(route.page)) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

function setStatus(route, params) {
  const sb = document.getElementById("sb-route");
  if (sb) sb.textContent = "route: " + (route ? route.pattern.replace(":id", params.id || "…") : location.hash || "/");
}

function errorState(html) {
  outlet.innerHTML =
    '<div class="state error"><div class="big">This page did not load</div><div>' + html + "</div>" +
    '<div class="actions"><button class="btn" id="retry-render">Retry</button><a class="btn ghost" href="#/">Back to Projects</a></div></div>';
  const retry = document.getElementById("retry-render");
  if (retry) retry.addEventListener("click", () => render());
}

async function render() {
  const path = (location.hash || "#/").replace(/^#/, "") || "/";
  const found = matchRoute(path);
  if (currentCleanup) { try { currentCleanup(); } catch { /* page cleanup must not break routing */ } }
  currentCleanup = null;
  if (!found) {
    markNav(null); setStatus(null, {});
    document.title = "Cloner — Projects";
    outlet.innerHTML =
      '<div class="state"><div class="big">No page at ' + esc(path) + '</div>' +
      '<div class="actions"><a class="btn primary" href="#/">1 Projects</a><a class="btn" href="#/new">2 New Clone</a></div></div>';
    return;
  }
  const { route, params } = found;
  markNav(route); setStatus(route, params);
  if (route.title) document.title = "Cloner — " + route.title;
  currentKey = path;
  outlet.innerHTML = '<div class="state"><div class="big">Loading ' + esc(route.title || "page") + '…</div></div>';
  try {
    const fragRes = await fetch(uiPath("pages/" + route.fragment));
    if (!fragRes.ok) throw new Error("fragment HTTP " + fragRes.status);
    outlet.innerHTML = await fragRes.text();
  } catch (e) {
    return errorState("The page document could not be fetched — " + esc(String(e?.message || e)) + ".");
  }
  if (currentKey !== path) return; // navigation happened while loading
  try {
    const mod = await import(uiPath("pages/" + route.module));
    const result = await mod.default(outlet, { params, uiPath });
    currentCleanup = typeof result === "function" ? result : null;
  } catch (e) {
    errorState("The page script failed — " + esc(String(e?.message || e)) + ".");
  }
}

// ---- pages 5-8: standalone documents. Probe once, then either navigate with
// the current project id or render the deferred-increment state. ----
const extProbe = new Map();
function projectRef() {
  return window.__project?.id ? (window.__project.query || "") : "";
}

function interceptExtClicks() {
  document.querySelector(".topnav nav")?.addEventListener("click", async (ev) => {
    const a = ev.target.closest("a[data-ext]");
    if (!a) return;
    ev.preventDefault();
    const href = a.getAttribute("href") || "";
    const probe = extProbe.get(href);
    if (probe === false) return deferredState(a.textContent.trim());
    const go = () => location.assign(href + (projectRef() ? (href.includes("?") ? "&" : "?") + projectRef() : ""));
    if (probe === true) return go();
    a.style.opacity = "0.6";
    let ok = false;
    try { ok = (await fetch(uiPath(href), { method: "HEAD" })).ok; } catch { ok = false; }
    a.style.opacity = "";
    extProbe.set(href, ok);
    if (ok) go();
    else deferredState(a.textContent.trim());
  });
}

function deferredState(label) {
  markNav(null);
  outlet.innerHTML =
    '<div class="state defer-note"><div class="big">' + esc(label) + ' — ships in a later increment</div>' +
    '<p>This workspace is part of the 8-page product plan; the increment in front of you built the shell and pages 1-4.</p>' +
    '<p>Everything the page will read already lands in the job artifacts' +
    ' (e.g. <code>artifacts/&lt;jobId&gt;/blueprint.json</code>), so the page switches on when its increment merges.</p>' +
    '<div class="actions"><a class="btn primary" href="#/">Back to Projects</a></div></div>';
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
