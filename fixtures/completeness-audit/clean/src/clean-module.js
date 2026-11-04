// Fixture (clean): a REAL product module that must produce ZERO findings.
// Specificity probes below deliberately walk near every detector:
//   • the word "mock" appears only in prose comments and string contents
//   • the word "TODO" appears only inside a string (a to-do-list feature name)
//   • statuses are 200/503, never 501
//   • every function has a real body and every export a real consumer (index.js)

// This module fakes nothing: it calls the real delivery endpoint configured by
// the environment, and there is no placeholder anywhere below.
import fs from "node:fs";

export function deliver(raw) {
  const endpoint = process.env.DELIVERY_ENDPOINT || "https://real-endpoint.example/send";
  if (!raw) throw new Error("nothing to deliver");
  return { endpoint, bytes: Buffer.byteLength(String(raw)) };
}

export function readState(file) {
  // No shortcuts here: the file must exist or we fail loudly.
  if (!fs.existsSync(file)) throw new Error(`state file missing: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function labelFor(task) {
  // UI copy for the to-do list surface of the cloned app.
  return `TODO items: ${task.count}`;
}

export function report(res, payload) {
  res.status(200).json({ ok: true, payload });
}

export function degraded(res) {
  res.status(503).json({ ok: false, reason: "upstream unavailable" });
}
