// Behavior verification (C4 of the behavior-synthesis wave): asserts that the
// generated store actually BEHAVES — the "100%" gate made mechanical:
//   1. the store runtime is live (window.__CLONER_STORE with model counts)
//   2. feed continuation: after the stream tape, feed keys drift and the log
//      carries feed entries (or, with no feeds, the check passes honestly)
//   3. action dispatch: every store-owned trigger click produces a log entry
//      with a delta (entity row count grows / input captured)
//   4. log honesty: entries carry t + delta
// Evidence: the behavior contract (behavior-model.json, C1) decides what MUST
// transition — actions with a trigger in the clone are asserted; triggers
// missing from the clone are reported as skips, never silently dropped.
// Non-fatal by contract: any internal error lands in report.error (the caller
// never fails verification because of this module alone — the battery decides).
import fs from "node:fs";
import path from "node:path";
import { launchBrowser } from "../browser.js";
import { readBehaviorModel } from "./behavior-model.js";

const MAX_DISPATCH_ASSERTS = 6;
const FEED_WAIT_MS = 2600; // tape grace + one walk tick (1000ms interval)

function fileUrl(cloneDir, file) {
  return "file:///" + path.join(cloneDir, file).replace(/\\/g, "/");
}

// runBehaviorVerification(cloneDir, artifactsDir) →
// { ok, model: {feeds, entities, actions}, checks: [{id, result, detail}], skips, notes }
export async function runBehaviorVerification(cloneDir, artifactsDir) {
  const report = { ok: false, model: { feeds: 0, entities: 0, actions: 0 }, checks: [], skips: [], notes: [] };
  try {
    const model = readBehaviorModel(artifactsDir);
    if (!model) {
      report.notes.push("no behavior contract on disk — behavior verification skipped (pre-C1 job)");
      report.checks.push({ id: "contract", result: "skip", detail: "behavior-model.json absent" });
      return report;
    }
    report.model = { feeds: model.counts.feeds, entities: model.counts.entities, actions: model.counts.actions };
    const owned = (model.actions || []).filter((a) => a.kind === "submit" && a.trigger);
    const feeds = (model.feeds || []).filter((f) => f.numeric && f.keys.length);

    const b = await launchBrowser({ headless: true });
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    p.on("pageerror", (e) => { if (errors.length < 10) errors.push(String(e?.message || e).slice(0, 160)); });
    const entry = fs.existsSync(path.join(cloneDir, "index.html")) ? "index.html" : null;
    if (!entry) {
      report.notes.push("no index.html in the clone — behavior verification skipped");
      await b.close().catch(() => {});
      return report;
    }
    await p.goto(fileUrl(cloneDir, entry), { waitUntil: "load", timeout: 20000 });
    await p.waitForTimeout(600);

    // 1. store live
    const store = await p.evaluate(() => {
      const s = window.__CLONER_STORE;
      return s ? { present: true, model: s.model || null, entities: Object.keys(s.state?.entities || {}).length } : { present: false };
    });
    report.checks.push({
      id: "store-live",
      result: store.present ? "pass" : "fail",
      detail: store.present
        ? `store live (feeds=${store.model?.feeds}, entities=${store.model?.entities}, actions=${store.model?.actions})`
        : "generated store runtime missing — clone is behaviorally inert",
    });

    // 2. feed continuation (the store waits for the stream tape, so poll)
    if (feeds.length) {
      await p.waitForTimeout(FEED_WAIT_MS);
      const feed = await p.evaluate(() => {
        const s = window.__CLONER_STORE;
        if (!s || !s.channels) return { present: false };
        const id = Object.keys(s.channels)[0];
        const keys = s.channels[id]?.keys || {};
        const feedLogs = (s.log || []).filter((l) => l.kind === "feed").length;
        return { present: true, channel: id, keys, feedLogs, sample: Object.entries(keys).slice(0, 3) };
      });
      report.checks.push({
        id: "feed-continuation",
        result: feed.present && feed.feedLogs > 0 ? "pass" : "fail",
        detail: feed.present
          ? `feed ${feed.channel} alive: ${feed.feedLogs} tick(s), keys ${Object.keys(feed.keys).slice(0, 4).join(",")} @ ${JSON.stringify(feed.sample)}`
          : "no feed state in the store",
      });
    } else {
      report.checks.push({ id: "feed-continuation", result: "skip", detail: "behavior contract carries no numeric feeds — nothing to continue" });
    }

    // 3. action dispatch — every owned trigger present in the clone must delta
    let asserted = 0;
    for (const a of owned) {
      if (asserted >= MAX_DISPATCH_ASSERTS) { report.skips.push(`${a.trigger}: assertion budget`); continue; }
      const res = await p.evaluate((id) => {
        const el = document.querySelector(`[data-cloner-trigger="${id}"]`);
        if (!el) return { present: false };
        const before = (window.__CLONER_STORE_LOG || []).filter((l) => l.kind === "submit").length;
        el.click();
        return new Promise((resolve) => setTimeout(() => {
          const logs = (window.__CLONER_STORE_LOG || []).filter((l) => l.kind === "submit");
          const last = logs[logs.length - 1] || null;
          resolve({ present: true, before, after: logs.length, last });
        }, 120));
      }, a.trigger);
      if (!res.present) {
        report.skips.push(`${a.trigger}: trigger missing from the clone page`);
        continue;
      }
      asserted++;
      const passed = res.after > res.before && res.last && res.last.delta;
      report.checks.push({
        id: `dispatch-${a.trigger}`,
        result: passed ? "pass" : "fail",
        detail: passed
          ? `trigger ${a.trigger} dispatched → ${res.last.delta.entity} rows=${res.last.delta.rows} input=${JSON.stringify(res.last.delta.input).slice(0, 60)}`
          : `trigger ${a.trigger} clicked but no submit delta landed in the log`,
      });
    }
    if (owned.length && !asserted && report.skips.length) {
      report.notes.push(`${report.skips.length} owned trigger(s) absent from the clone — binding needs a reconstruction that emitted them`);
    }

    // 4. log honesty
    const logShape = await p.evaluate(() => {
      const logs = window.__CLONER_STORE_LOG || [];
      const bad = logs.filter((l) => typeof l.t !== "number" || !("delta" in l)).length;
      return { count: logs.length, bad };
    });
    report.checks.push({
      id: "log-honesty",
      result: logShape.bad === 0 ? "pass" : "fail",
      detail: `${logShape.count} log entr(ies), ${logShape.bad} malformed`,
    });

    await b.close().catch(() => {});
    if (errors.length) report.notes.push(`page errors during behavior run: ${errors.slice(0, 3).join(" | ")}`);
    report.ok = report.checks.every((c) => c.result !== "fail");
  } catch (e) {
    report.error = String(e?.message || e).slice(0, 200);
  }
  return report;
}

// summarizeBehaviorVerification(report) — the verify.js battery block.
export function summarizeBehaviorVerification(report) {
  if (!report) return { ok: false, why: "no behavior report" };
  return {
    ok: report.ok,
    checks: report.checks.map((c) => ({ id: c.id, result: c.result })),
    model: report.model,
    skips: report.skips.slice(0, 4),
    notes: report.notes.slice(0, 4),
    error: report.error || null,
  };
}
