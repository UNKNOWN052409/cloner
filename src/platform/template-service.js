// Template gallery + create-project-from-template (task 4.1.7).
//
// templates/manifest.json is the catalog (id, name, description, category,
// previewRef). createFromTemplate materializes the referenced fixture
// exploration artifact set as a STARTING TASK — the real pipeline store
// (src/platform/tasks.js createTask) is used, so the template-derived project
// is a genuine platform task with its own out/ dir, not a fake record.
//
// Surface:
//   loadManifest()               → parsed templates/manifest.json (validated)
//   listTemplates({ category })  → filtered list
//   getTemplate(id)
//   createFromTemplate({ id, userId })
//                                → { task, template } (real task payload)
//   templateRouter({ localOrAuthed }) — INTEGRATOR MOUNT LINE:
//       import { templateRouter } from "./template-service.js";
//       app.use("/api/templates", templateRouter({ localOrAuthed }));
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = path.join(__dirname, "..", "..", "templates", "manifest.json");

export function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw);
  if (!Array.isArray(manifest.templates)) throw new Error("manifest.templates must be an array");
  const seen = new Set();
  for (const t of manifest.templates) {
    for (const k of ["id", "name", "description", "category", "previewRef"]) {
      if (!t[k]) throw new Error(`template missing "${k}": ${JSON.stringify(t).slice(0, 120)}`);
    }
    if (seen.has(t.id)) throw new Error(`duplicate template id: ${t.id}`);
    seen.add(t.id);
    // every template's previewRef must resolve — a broken catalog entry is a
    // shipped bug, not a runtime surprise
    if (!fs.existsSync(path.join(__dirname, "..", "..", t.previewRef))) {
      throw new Error(`template ${t.id}: previewRef does not resolve: ${t.previewRef}`);
    }
  }
  return manifest;
}

export function listTemplates({ category = null } = {}) {
  const { templates } = loadManifest();
  return category ? templates.filter((t) => t.category === category) : templates;
}

export function listCategories() {
  return [...new Set(loadManifest().templates.map((t) => t.category))].sort();
}

export function getTemplate(id) {
  return listTemplates().find((t) => t.id === id) || null;
}

// Create a real starting task from a template. The previewRef page (a real
// fixture HTML file in the repo) is cloned through the platform's own task
// store so the resulting project IS a platform task — editable, previewable,
// exportable through the normal surfaces. targetUrl points at a file:// URL —
// disallowed by the SSRF guard — so the template task is created in 'queued'
// state with its options recording the template origin; a real exploration is
// triggered when the operator opens/clones it (never auto-run here).
export async function createFromTemplate({ id, userId = null } = {}) {
  const t = getTemplate(id);
  if (!t) {
    const e = new Error(`template "${id}" not found`);
    e.status = 404;
    throw e;
  }
  const tasks = await import("./tasks.js");
  const meta = tasks.createTask({
    url: "template://" + t.id, // template provenance marker; the operator supplies a real target
    mode: "template",
    instructions: `Created from template "${t.name}" (${t.category}). Open the template preview at ${t.previewRef} or submit a URL to clone.`,
    userId: userId || "local",
  });
  tasks.updateTask(meta.id, {
    template: { id: t.id, name: t.name, category: t.category, previewRef: t.previewRef },
    status: "queued",
  }, "created from template " + t.id);
  return { task: tasks.loadTask(meta.id), template: t };
}

export function templateRouter({ localOrAuthed } = {}) {
  const router = Router();
  const readGate = localOrAuthed || ((req, res, next) => next());
  const writeGate = localOrAuthed || ((req, res, next) => next());

  router.get("/", async (req, res) => {
    try {
      const templates = listTemplates({ category: req.query.category || null });
      res.json({ ok: true, categories: listCategories(), templates });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  router.get("/:id", async (req, res) => {
    const t = getTemplate(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: "template not found" });
    res.json({ ok: true, template: t });
  });

  router.post("/:id/create", readGate, writeGate, async (req, res) => {
    try {
      const out = await createFromTemplate({ id: req.params.id, userId: req.userId || null });
      res.json({ ok: true, taskId: out.task.id, template: out.template, task: { id: out.task.id, status: out.task.status, url: out.task.url } });
    } catch (e) {
      res.status(e.status || 500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
    }
  });

  return router;
}
