// Artifact loader + validator (spec §2): reads a Phase-1 artifact directory,
// validates the §15 contract, resolves references safely inside the job dir,
// distinguishes missing vs empty evidence, produces a reconstruction input report.
import fs from "node:fs";
import path from "node:path";

export function loadArtifacts(artifactsDir) {
  const dir = path.resolve(artifactsDir);
  const report = { dir, ok: false, missing: [], malformed: [], pages: [], warnings: [] };
  const readJson = (rel) => {
    const file = path.join(dir, rel);
    if (!file.startsWith(dir)) return { missing: "path-escape" };
    if (!fs.existsSync(file)) return { missing: true };
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return { malformed: e.message.slice(0, 100) }; }
  };

  const manifest = readJson("manifest.json");
  if (manifest.missing !== undefined || manifest.malformed) {
    report.missing.push("manifest.json");
    return report; // no manifest = not a phase-1 job dir
  }
  report.ok = true;

  // pages: per-page evidence, never assume identical coverage
  const pageIds = manifest.pages?.map((p) => p.pageId) || [];
  for (const pageId of pageIds) {
    const base = `pages/${pageId}`;
    const page = {
      pageId,
      url: manifest.pages.find((p) => p.pageId === pageId)?.url || null,
      dom: readJson(`${base}/dom.json`),
      styles: readJson(`${base}/styles.json`),
      geometry: readJson(`${base}/geometry.json`),
      network: readJson(`${base}/network.json`),
      screenshotRef: fs.existsSync(path.join(dir, base, "screenshot-viewport.png")) ? `${base}/screenshot-viewport.png` : null,
    };
    for (const key of ["dom", "styles", "geometry", "network"]) {
      if (page[key].missing !== undefined) report.missing.push(`${base}/${key}.json`);
      else if (page[key].malformed) report.malformed.push(`${base}/${key}.json (${page[key].malformed})`);
    }
    // distinguish genuinely empty from missing
    if (page.dom && !page.dom.missing && !page.dom.malformed) {
      page.elements = page.dom.elements || [];
      page.emptyEvidence = page.elements.length === 0;
    }
    report.pages.push(page);
  }

  const graph = readJson("graph/states.json");
  if (graph.missing !== undefined) report.missing.push("graph/states.json");
  report.graph = graph.missing !== undefined ? { nodes: [], edges: [] } : graph;
  if (fs.existsSync(path.join(dir, "graph/states.json")) && !fs.existsSync(path.join(dir, "graph/transitions.json"))) {
    report.warnings.push("graph/states.json present but transitions.json missing");
  }

  report.assetManifest = readJson("assets/manifest.json");
  if (report.assetManifest.missing !== undefined) report.missing.push("assets/manifest.json");

  // asset-capture url→local mapping (from capture stage entries)
  report.capturedAssets = (report.assetManifest.capturedFromNetwork?.entries || []).filter((e) => e.localPath);

  report.warnings.push(...(manifest.warnings || []).map((w) => w.message));
  return report;
}
