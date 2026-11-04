// Static hosting export targets (task 4.1.9).
//
// Emit a DEPLOY-READY folder per target shape from a version snapshot (or any
// project tree):
//   static   → plain static site (copy as-is, index.html at root)
//   netlify  → adds _redirects (SPA fallback + 404)
//   vercel   → adds vercel.json (cleanUrls, rewrites, headers)
// Optional content-hash filenames: every emitted asset file gets a
// content-addressed name (sha256 prefix) and all references inside HTML/CSS
// are rewritten to match — deterministic per input bytes.
//
// Determinism: same input tree → byte-identical output tree (sorted file
// list, fixed redirect/JSON content, no timestamps in emitted files).
//
// Surface:
//   exportStaticTarget({ sourceDir, target, outDir, hashAssets })
//        → { ok, target, files, entry }
//   verifyLinks(outDir)         → { ok, broken: [] } — href/src targets resolve
//   staticExportRouter({ guard }) — INTEGRATOR MOUNT LINE:
//       import { staticExportRouter } from "./static-export.js";
//       app.use("/api/static-export", staticExportRouter({ guard: localOrAuthed("export:task") }));
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Router } from "express";
import { isSensitiveName } from "./exporter.js";

export const TARGETS = new Set(["static", "netlify", "vercel"]);

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const ASSET_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".css", ".js", ".mjs", ".woff", ".woff2", ".ttf", ".mp4", ".webm"]);

function walkFiles(dir, rel = "") {
  const out = [];
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (ent.name === "private" || ent.name === "export-staging" || ent.name === "node_modules") continue;
    const r = rel ? rel + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...walkFiles(dir, r));
    else if (ent.isFile()) out.push(r);
  }
  return out.sort();
}

// Content-hash filenames: rename asset files to <stem>-<sha8>.<ext> and
// rewrite every reference to them inside .html/.css/.js text files.
function emitWithHashes(sourceDir, outDir) {
  const files = walkFiles(sourceDir);
  const rename = new Map(); // old rel → new rel
  const buffers = new Map(); // old rel → Buffer
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(sourceDir, rel));
    buffers.set(rel, buf);
    const ext = path.extname(rel);
    if (ASSET_EXT.has(ext.toLowerCase())) {
      const stem = path.basename(rel, ext);
      const dirPart = path.dirname(rel);
      const newName = (dirPart === "." ? "" : dirPart + "/") + `${stem}-${sha256(buf).slice(0, 8)}${ext}`;
      rename.set(rel, newName);
    } else {
      rename.set(rel, rel);
    }
  }
  // rewrite references in text files FIRST (old name → new name)
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (![".html", ".css", ".js"].includes(ext)) continue;
    let text = buffers.get(rel).toString("utf8");
    for (const [oldRel, newRel] of rename) {
      if (oldRel === newRel) continue;
      const oldBase = path.basename(oldRel);
      const newBase = path.basename(newRel);
      if (oldBase === newBase) continue;
      // same-basename references (href="old.png") — safe because newBase embeds the hash
      while (text.includes(oldBase)) text = text.replace(oldBase, newBase);
    }
    buffers.set(rel, Buffer.from(text, "utf8"));
  }
  for (const rel of files) {
    const dst = path.join(outDir, rename.get(rel));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buffers.get(rel));
  }
  return files.map((rel) => rename.get(rel));
}

function emitPlain(sourceDir, outDir) {
  const files = walkFiles(sourceDir);
  for (const rel of files) {
    for (const segment of rel.split("/")) {
      if (isSensitiveName(segment)) throw new Error(`refusing credential-named entry in static export: ${rel}`);
    }
    const dst = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(sourceDir, rel), dst);
  }
  return files;
}

const NETLIFY_REDIRECTS = [
  "/*    /index.html   200",
  "/404  /index.html   200",
].join("\n") + "\n";

function vercelConfig(entry) {
  return JSON.stringify({
    $schema: "https://openapi.vercel.sh/vercel.json",
    cleanUrls: true,
    rewrites: [{ source: "/(.*)", destination: `/${entry}` }],
    headers: [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ],
  }, null, 2) + "\n";
}

export async function exportStaticTarget({ sourceDir, target = "static", outDir, hashAssets = false } = {}) {
  if (!TARGETS.has(target)) {
    const e = new Error(`unknown static target "${target}" (valid: ${[...TARGETS].join(", ")})`);
    e.status = 400;
    throw e;
  }
  if (!sourceDir || !fs.existsSync(sourceDir)) throw new Error(`source dir not found: ${sourceDir}`);
  const idx = fs.existsSync(path.join(sourceDir, "index.html"));
  if (!idx) throw new Error("source dir has no index.html — not a static site root");
  if (outDir && fs.existsSync(outDir) && fs.readdirSync(outDir).length) {
    throw new Error(`output dir must be empty or absent: ${outDir}`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  let files = hashAssets ? emitWithHashes(sourceDir, outDir) : emitPlain(sourceDir, outDir);
  const entry = "index.html";

  if (target === "netlify") {
    fs.writeFileSync(path.join(outDir, "_redirects"), NETLIFY_REDIRECTS);
    files.push("_redirects");
  } else if (target === "vercel") {
    fs.writeFileSync(path.join(outDir, "vercel.json"), vercelConfig(entry));
    files.push("vercel.json");
  }
  files = [...new Set(files)].sort();
  return { ok: true, target, entry, files, fileCount: files.length };
}

// Link check: every local href/src in emitted .html files must resolve to an
// emitted file (or be an external/anchor/mailto URL). Non-200 references are
// the human-visible breakage this checker exists to catch.
export function verifyLinks(outDir) {
  const emitted = new Set(walkFiles(outDir));
  const broken = [];
  for (const rel of emitted) {
    if (!rel.toLowerCase().endsWith(".html")) continue;
    const html = fs.readFileSync(path.join(outDir, rel), "utf8");
    const refRe = /(?:href|src)\s*=\s*"([^"]+)"/gi;
    let m;
    while ((m = refRe.exec(html))) {
      const ref = m[1];
      if (/^(https?:|data:|mailto:|#|javascript:)/i.test(ref)) continue;
      const clean = ref.split("#")[0].split("?")[0];
      if (!clean) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), clean));
      if (!emitted.has(resolved)) broken.push(`${rel} → ${ref}`);
    }
  }
  return { ok: broken.length === 0, broken };
}

export function staticExportRouter({ guard } = {}) {
  const router = Router();
  const g = guard || ((req, res, next) => {
    if (req.userRole === "admin") return next();
    res.status(403).json({ ok: false, error: "guard required" });
  });
  router.use(g);
  router.use(express.json({ limit: "64kb" }));

  router.post("/", async (req, res) => {
    try {
      const { sourceDir, target, outDir, hashAssets } = req.body || {};
      if (!sourceDir || !outDir) return res.status(400).json({ ok: false, error: "sourceDir and outDir are required" });
      const r = await exportStaticTarget({ sourceDir, target: target || "static", outDir, hashAssets: hashAssets === true });
      res.json({ ok: true, ...r, links: verifyLinks(outDir) });
    } catch (e) {
      res.status(e.status || 400).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  });

  return router;
}
import express from "express";
