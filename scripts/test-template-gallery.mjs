#!/usr/bin/env node
// Task 4.1.7 e2e — template gallery and project creation flows.
//
// Exercises template-service.js against the REAL catalog (templates/
// manifest.json, 5 seeded templates from existing repo fixtures) and the REAL
// task store (tasks.js createTask — a template-derived project IS a platform
// task):
//   • catalog lists 5 templates with name/description/category/previewRef
//   • every previewRef resolves to a real file (broken catalog = shipped bug)
//   • filter by category returns only that category
//   • unknown template id → 404 (service + HTTP)
//   • create-from-template produces a VALID task payload (real id, queued
//     status, template provenance recorded in the task meta)
//   • created task is loadable through the normal platform store
//
// No database required (the v1 task store is the file store) — runs anywhere.
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import express from "express";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(PROJECT); // tasks.js pins ROOT to cwd at import

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const T = await import("../src/platform/template-service.js");
const tasks = await import("../src/platform/tasks.js");
const rand = () => crypto.randomBytes(5).toString("hex");

// ---- catalog ----
{
  const manifest = T.loadManifest();
  check("T1  manifest parses with a templates array", Array.isArray(manifest.templates), `${manifest.templates?.length} entries`);
  check("T2  exactly 5 seeded templates", manifest.templates.length === 5, String(manifest.templates.length));

  const list = T.listTemplates();
  check("T3  every template carries id/name/description/category/previewRef",
    list.every((t) => t.id && t.name && t.description && t.category && t.previewRef), list.map((t) => t.id).join(","));

  const missingRefs = list.filter((t) => !fs.existsSync(path.join(PROJECT, t.previewRef)));
  check("T4  every previewRef resolves to a real repo file", missingRefs.length === 0, missingRefs.map((t) => t.id).join(",") || "all resolve");

  const dupes = list.map((t) => t.id).filter((id, i, a) => a.indexOf(id) !== i);
  check("T5  template ids unique", dupes.length === 0, dupes.join(",") || "unique");
}

// ---- filter by category ----
{
  const all = T.listTemplates();
  const cats = [...new Set(all.map((t) => t.category))].sort();
  check("T6  multiple categories seeded", cats.length >= 3, cats.join(","));
  for (const c of cats) {
    const filtered = T.listTemplates({ category: c });
    check(`T7  category filter "${c}" returns only that category`, filtered.length >= 1 && filtered.every((t) => t.category === c), `${filtered.length} rows`);
  }
  check("T8  unknown category filter → empty list, not an error", T.listTemplates({ category: "nope" }).length === 0, "0 rows");
}

// ---- create-from-template: a REAL task payload ----
{
  const before = tasks.listTasks().length;
  const { task, template } = await T.createFromTemplate({ id: "dashboard-toolbar", userId: "tpl-" + rand() });
  check("C1  creation returns the template record", template.id === "dashboard-toolbar", template.id);
  check("C2  created a REAL platform task (queued, real id shape)", !!task?.id && task.status === "queued", `${task.id} ${task.status}`);
  check("C3  task count grew by exactly 1 in the store", tasks.listTasks().length === before + 1, `${before} → ${tasks.listTasks().length}`);
  check("C4  template provenance recorded in the task meta", task.template?.id === "dashboard-toolbar" && task.template?.previewRef, JSON.stringify(task.template).slice(0, 100));
  check("C5  history records the template origin", (task.history || []).some((h) => /template dashboard-toolbar/.test(h.event || "")), JSON.stringify(task.history?.map((h) => h.event)));

  const reloaded = tasks.loadTask(task.id);
  check("C6  task loads through the normal store (same shape)", reloaded?.id === task.id && reloaded?.mode === "template", reloaded?.mode);
  tasks.deleteTask(task.id);
  check("C7  created task cleaned up via the normal store API", tasks.loadTask(task.id) === null, "gone");
}

// ---- unknown template ----
{
  let err = null;
  try { await T.createFromTemplate({ id: "definitely-not-a-template" }); } catch (e) { err = e; }
  check("C8  unknown template id → 404 (service)", !!err && err.status === 404 && /not found/.test(err.message), err?.message);
}

// ---- HTTP surface (router mounted as the integrator will) ----
{
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/templates", T.templateRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.on("listening", r));
  const port = server.address().port;
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/templates${p}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const list = await api("GET", "/");
  check("H1  GET /api/templates lists the catalog", list.status === 200 && list.json?.templates?.length === 5, String(list.json?.templates?.length));
  check("H2  categories exposed on the list endpoint", Array.isArray(list.json?.categories) && list.json.categories.length >= 3, (list.json?.categories || []).join(","));

  const filtered = await api("GET", "/?category=dashboard");
  check("H3  category filter works over HTTP", filtered.status === 200 && filtered.json?.templates?.every((t) => t.category === "dashboard"), `${filtered.json?.templates?.length} rows`);

  const one = await api("GET", "/dashboard-toolbar");
  check("H4  single template fetch", one.status === 200 && one.json?.template?.id === "dashboard-toolbar", one.json?.template?.name);

  const missing = await api("GET", "/nope");
  check("H5  unknown template → 404 over HTTP", missing.status === 404, String(missing.status));

  const created = await api("POST", "/lazy-gallery/create", {});
  check("H6  create-from-template over HTTP → valid task payload",
    created.status === 200 && created.json?.taskId && created.json?.task?.status === "queued", JSON.stringify(created.json?.task));
  const reloaded = tasks.loadTask(created.json.taskId);
  check("H7  HTTP-created task is real and loadable", reloaded?.id === created.json.taskId && reloaded?.template?.id === "lazy-gallery", reloaded?.template?.id);
  tasks.deleteTask(created.json.taskId);

  // Await the server close and drop the fetch keep-alive sockets BEFORE exit:
  // on Windows an exit while a TCP/socket handle is mid-close trips the libuv
  // assertion in src\win\async.c (exit code 0xC0000409 / 3221226505) even
  // though every check passed. Two sources of open sockets: this server's own
  // accepted sockets (closeAllConnections) and undici's GLOBAL keep-alive
  // pools created by fetch() on the client side (destroyGlobalDispatcher).
  await new Promise((resolve) => {
    server.closeIdleConnections?.();
    server.close(() => resolve());
    server.closeAllConnections?.();
    setTimeout(resolve, 2000).unref(); // never hang the suite on a stuck socket
  });
}

const pass = results.filter(Boolean).length;
const fail = results.length - pass;
console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"}  (${pass}/${results.length})`);
// Undici's global agent keeps pooled keep-alive sockets OPEN after the
// responses complete; process.exit() while undici is concurrently closing a
// pooled socket trips the Windows libuv assertion. Destroy the global
// dispatcher first, then exit via the drain path (no explicit exit unless
// failing — a clean event loop exits 0 by itself).
try { const { getGlobalDispatcher, Agent } = await import("undici"); await getGlobalDispatcher().destroy(); } catch { /* node without undici export */ }
if (fail) process.exit(1);
