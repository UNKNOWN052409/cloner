// Benchmark intelligence (plan §"Benchmark intelligence" — continuous
// multi-site benchmark evaluation and regression detection).
//
// Consumes the EXISTING benchmark outputs as data (never re-scores them):
//   • scripts/test-multisite-benchmark.mjs result JSON
//     (artifacts/benchmark-3-5-result.json): { aggregate, results: [ { site,
//     overall, dimensions: { name: score }, gateFailures, ... } ] }
//   • fixtures/benchmark/baseline.json: { rubricVersion, perSite: { site: {
//     overall, dimensions: { name: { score } } } } }
//
// Everything here is deterministic: same inputs → same outputs, no clocks, no
// model calls. The multisite benchmark suite itself stays untouched — this
// module is the additive intelligence layer (trend summaries, cross-run
// regression detection, weakest-dimension focus areas) that the adaptive
// explorer and the platform gate read.

import fs from "node:fs";

// normalizeResult(result) → uniform shape for both accepted input dialects.
export function normalizeResult(result) {
  if (!result || typeof result !== "object") return { aggregate: null, sites: [] };
  // dialect A: benchmark result JSON ({ results: [...] })
  if (Array.isArray(result.results)) {
    const sites = result.results.map((r) => ({
      site: r.site,
      overall: Number(r.overall) || 0,
      dimensions: Object.fromEntries(
        Object.entries(r.dimensions || {}).map(([k, v]) => [k, Number(typeof v === "object" ? v?.score : v) || 0]),
      ),
    }));
    return { aggregate: Number(result.aggregate) || 0, sites };
  }
  // dialect B: baseline.json ({ perSite: { site: {...} } })
  if (result.perSite && typeof result.perSite === "object") {
    const sites = Object.entries(result.perSite).map(([site, r]) => ({
      site,
      overall: Number(r.overall) || 0,
      dimensions: Object.fromEntries(
        Object.entries(r.dimensions || {}).map(([k, v]) => [k, Number(typeof v === "object" ? v?.score : v) || 0]),
      ),
    }));
    const aggregate = sites.length
      ? Math.round((sites.reduce((a, s) => a + s.overall, 0) / sites.length) * 100) / 100
      : 0;
    return { aggregate, sites };
  }
  return { aggregate: null, sites: [] };
}

// loadBenchmarkResult(path) / loadBenchmarkBaseline(path) — file loaders.
export function loadBenchmarkResult(path) {
  return normalizeResult(JSON.parse(fs.readFileSync(path, "utf8")));
}

// detectRegressions(current, baseline, { tolerance = 0 }) → { flagged,
// regressions[], aggregateFrom, aggregateTo, aggregateDrop }.
// A regression is a per-site per-dimension DROP of more than `tolerance`
// points (baseline − current > tolerance), or the same on site overall /
// aggregate. Deterministic ordering: site name, then dimension name.
export function detectRegressions(current, baseline, { tolerance = 0 } = {}) {
  const cur = normalizeResult(current);
  const base = normalizeResult(baseline);
  const baseBySite = new Map(base.sites.map((s) => [s.site, s]));
  const regressions = [];
  for (const s of cur.sites) {
    const b = baseBySite.get(s.site);
    if (!b) continue; // new site — no history, no regression claim
    const drop = Math.round((b.overall - s.overall) * 100) / 100;
    if (drop > tolerance) {
      regressions.push({ site: s.site, dimension: "overall", from: b.overall, to: s.overall, drop });
    }
    for (const [dim, to] of Object.entries(s.dimensions)) {
      const from = b.dimensions[dim];
      if (from === undefined) continue;
      const d = Math.round((from - to) * 100) / 100;
      if (d > tolerance) regressions.push({ site: s.site, dimension: dim, from, to: Number(to), drop: d });
    }
  }
  const aggregateFrom = base.aggregate, aggregateTo = cur.aggregate;
  const aggregateDrop = Math.round(((aggregateFrom ?? 0) - (aggregateTo ?? 0)) * 100) / 100;
  regressions.sort((a, b) => a.site.localeCompare(b.site) || String(a.dimension).localeCompare(String(b.dimension)));
  return {
    flagged: regressions.length > 0 || aggregateDrop > tolerance,
    regressions,
    aggregateFrom,
    aggregateTo,
    aggregateDrop,
    tolerance,
  };
}

// summarizeTrend(results[]) → per-site and per-dimension series across runs
// (input order preserved — the caller owns chronology). Deterministic.
export function summarizeTrend(results) {
  const runs = (results || []).map((r) => normalizeResult(r));
  const sites = {};
  const dimensions = {};
  for (const run of runs) {
    for (const s of run.sites) {
      (sites[s.site] = sites[s.site] || { series: [] }).series.push(s.overall);
      for (const [dim, v] of Object.entries(s.dimensions)) {
        (dimensions[dim] = dimensions[dim] || { series: [] }).series.push(v);
      }
    }
  }
  const finish = (entry) => {
    const { series } = entry;
    const first = series[0], last = series[series.length - 1];
    const delta = Math.round((last - first) * 100) / 100;
    entry.first = first;
    entry.last = last;
    entry.delta = delta;
    entry.direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    entry.best = Math.max(...series);
    entry.worst = Math.min(...series);
    return entry;
  };
  for (const e of Object.values(sites)) finish(e);
  for (const e of Object.values(dimensions)) finish(e);
  return { runs: runs.length, sites, dimensions };
}

// weakestDimensions(result, n) → ascending-score dimension entries across all
// sites (the improvement backlog the adaptive explorer and repair loop read).
export function weakestDimensions(result, n = 3) {
  const norm = normalizeResult(result);
  const rows = [];
  for (const s of norm.sites) {
    for (const [dimension, score] of Object.entries(s.dimensions)) {
      rows.push({ site: s.site, dimension, score });
    }
  }
  rows.sort((a, b) => a.score - b.score || a.site.localeCompare(b.site) || a.dimension.localeCompare(b.dimension));
  return rows.slice(0, Math.max(0, n));
}

// focusAreas(result, n) → human-prioritized improvement areas consumed by
// adaptive exploration (a coverage gap on the weakest dimension is explored
// harder next run). Deterministic.
export function focusAreas(result, n = 3) {
  return weakestDimensions(result, n).map((r) =>
    `${r.site}/${r.dimension} (score ${r.score})`);
}
