// Swarm build viewer routes — the page the user watches while a clone builds.
//
//   GET /progress/viewer.css        — viewer stylesheet (static asset)
//   GET /progress/viewer.js         — viewer script (static asset, ES module)
//   GET /progress/demo-events.json  — fixture event stream (viewer demo mode)
//   GET /progress/:jobId/events     — SSE stream of the job's bus events:
//                                     already-recorded events replay first,
//                                     then live traffic until the client leaves
//   GET /progress/:jobId            — the viewer page itself
//
// EVENT CONTRACT (emitted on the shared bus by the observability bridge, as
// bus-shaped { type, data, t, job } records — see src/events.js):
//   workflow.stage      { stage }            exploration → reconstruction → verification → export
//   workflow.todo.add   { id, label, route } one build unit enters the plan
//   workflow.todo.done  { id, agent? }       an agent finishes that build unit
//   workflow.agent      { id, name }         an agent announces itself
//
// Data source is the in-memory bus ONLY — no database, no Redis. Replay comes
// from bus.catchUp() (ring buffer), live traffic from bus.on(type)
// subscriptions. An event belongs to the viewer's job when evt.job equals the
// URL jobId; untagged events (job === null — emitted outside withJobScope) are
// global and shown to every viewer, mirroring how the per-job WS bridges treat
// untagged traffic. Tighten to strict equality by dropping the null branch.
//
// INTEGRATOR MOUNT LINE (server.js is integrator-owned — do not edit here):
//   import { progressRoutes } from "./progress-routes.js";
//   app.use(progressRoutes());            // bus defaults to the shared singleton
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { bus as sharedBus } from "../events.js";

const PLATFORM_DIR = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = path.join(PLATFORM_DIR, "..", "..", "public", "progress");
const FIXTURE = path.join(PLATFORM_DIR, "..", "..", "fixtures", "progress-events.json");

export const WORKFLOW_EVENT_TYPES = [
  "workflow.stage",
  "workflow.todo.add",
  "workflow.todo.done",
  "workflow.agent",
];

const JOB_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

// The platform mounts no static middleware, so the viewer ships its own three
// small assets here. Read + send keeps the Content-Type exact and avoids
// sendFile's extension-based overrides.
function sendAsset(res, file, type) {
  try {
    res.status(200).type(type).set("cache-control", "no-store").send(fs.readFileSync(file));
  } catch {
    res.status(404).json({ error: "viewer asset unavailable" });
  }
}

export function progressRoutes({ bus = sharedBus } = {}) {
  const router = express.Router();

  // ---- static viewer assets — registered BEFORE /:jobId so "viewer.js" and
  // "viewer.css" are not swallowed as job ids ----
  router.get("/progress/viewer.css", (_req, res) => sendAsset(res, path.join(VIEWER_DIR, "viewer.css"), "text/css"));
  router.get("/progress/viewer.js", (_req, res) => sendAsset(res, path.join(VIEWER_DIR, "viewer.js"), "text/javascript"));
  router.get("/progress/demo-events.json", (_req, res) => sendAsset(res, FIXTURE, "application/json"));

  // ---- SSE: recorded events first, then live ----
  router.get("/progress/:jobId/events", (req, res) => {
    const jobId = String(req.params.jobId || "");
    if (!JOB_ID_RE.test(jobId)) return res.status(400).json({ error: "invalid job id" });

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // never buffer behind a reverse proxy
    });
    res.write("retry: 3000\n\n");
    const write = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    write("hello", { jobId });

    const matches = (evt) => !evt || evt.job === jobId || evt.job == null;
    for (const evt of bus.catchUp().events || []) {
      if (matches(evt)) write(evt.type, evt);
    }

    const handlers = WORKFLOW_EVENT_TYPES.map((type) => {
      const handler = (evt) => {
        if (matches(evt)) write(evt.type, evt);
      };
      bus.on(type, handler);
      return [type, handler];
    });
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      for (const [type, handler] of handlers) bus.off(type, handler);
    });
  });

  // ---- the viewer page ----
  router.get("/progress/:jobId", (req, res) => {
    if (!JOB_ID_RE.test(String(req.params.jobId || ""))) {
      return res.status(400).json({ error: "invalid job id" });
    }
    sendAsset(res, path.join(VIEWER_DIR, "index.html"), "text/html; charset=utf-8");
  });

  return router;
}
