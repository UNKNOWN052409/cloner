// Page 2 — New Clone. POST /api/tasks with pipeline:"v2"; on success link the
// live surfaces: page 3 (#/projects/:id/exploration) and the swarm build
// viewer (/progress/:jobId — progress-routes.js). Scope is composed into the
// instructions text (blueprint.js parseInstructions is the wired channel);
// frameworkPreference is sent for the pipeline's buildBlueprint contract.
import { api, esc } from "../app.js";

export default async function render(root) {
  window.__project = null;
  const form = root.querySelector("#clone-form");
  const result = root.querySelector("#nc-result");
  const urlIn = root.querySelector("#nc-url");
  const urlErr = root.querySelector("#nc-url-err");
  const formErr = root.querySelector("#nc-form-err");
  const scopeSel = root.querySelector("#nc-scope");
  const fwSel = root.querySelector("#nc-fw");
  const inst = root.querySelector("#nc-instructions");
  const count = root.querySelector("#nc-count");
  const effective = root.querySelector("#nc-effective");
  const startBtn = root.querySelector("#nc-start");
  const busy = root.querySelector("#nc-busy");

  // The exact sentences the pipeline's scope parser will see — composed from
  // the scope select + the user's own text, shown verbatim.
  function composeInstructions(userText) {
    const parts = [];
    const scope = scopeSel.value;
    if (scope === "single-page") parts.push("limit to this page only; do not follow other routes.");
    const mine = String(userText || "").trim();
    if (mine) parts.push(mine);
    return parts.join(" ");
  }

  function refreshDerived() {
    count.textContent = String(inst.value.length);
    const composed = composeInstructions(inst.value);
    effective.textContent = composed ? "effective instructions: " + composed : "no instructions — full visible scope by defaults";
  }
  inst.addEventListener("input", refreshDerived);
  scopeSel.addEventListener("change", refreshDerived);
  refreshDerived();

  function showResult(r) {
    const id = r.id || r.jobId || "";
    result.hidden = false;
    result.innerHTML =
      '<div class="panel" style="border-color:var(--status-ok)">' +
      '<div class="statline"><span>task queued: <b class="mono">' + esc(id) + "</b></span>" +
      "<span>status: <b>" + esc(r.status || "queued") + "</b></span>" +
      '<span>pipeline: <b>' + esc(r.pipeline || "v2") + "</b></span></div>" +
      '<div class="actions" style="justify-content:flex-start;display:flex;gap:12px;flex-wrap:wrap">' +
      '<a class="btn primary" href="#/projects/' + encodeURIComponent(id) + '/exploration">Open live exploration workspace</a>' +
      '<a class="btn" href="/progress/' + encodeURIComponent(id) + '" target="_blank" rel="noopener">Swarm progress viewer</a>' +
      '<a class="btn ghost" href="#/projects/' + encodeURIComponent(id) + '/intelligence">Intelligence</a>' +
      "</div>" +
      '<p class="hint" style="margin-bottom:0">With a free slot the job starts exploring immediately; the live workspace above joins the job\'s event stream.</p>' +
      "</div>";
    result.scrollIntoView({ block: "nearest" });
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    urlErr.hidden = true;
    formErr.hidden = true;
    const url = urlIn.value.trim();
    if (!/^https?:\/\//i.test(url)) {
      urlErr.textContent = "url must start with http:// or https:// (the platform enforces the same check)";
      urlErr.hidden = false;
      urlIn.focus();
      return;
    }
    const body = {
      url,
      pipeline: "v2",
      instructions: composeInstructions(inst.value),
      scope: scopeSel.value,
      frameworkPreference: fwSel.value === "auto" ? null : fwSel.value,
    };
    const user = root.querySelector("#nc-user").value.trim();
    const pass = root.querySelector("#nc-pass").value;
    if (user) body.username = user;
    if (pass) body.password = pass;

    startBtn.disabled = true;
    busy.hidden = false;
    try {
      const res = await api("/api/tasks", { method: "POST", body });
      form.hidden = true;
      showResult(res);
    } catch (e) {
      formErr.textContent = String(e.message || "task creation failed").slice(0, 200) +
        (e.status === 401 ? " — this origin refuses anonymous submissions; sign in from the top bar." : "") +
        (e.status === 429 ? " — concurrency quota reached; wait for a running job to finish." : "");
      formErr.hidden = false;
    } finally {
      startBtn.disabled = false;
      busy.hidden = true;
    }
  });

  return () => { /* form listeners die with the fragment */ };
}
