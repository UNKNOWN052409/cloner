#!/usr/bin/env node
// Offline a11y auto-repair test — proves the repair loop end to end on a real
// generated project (file:// clone pages, no network, no exploration needed):
//
//   checkA11y (verify-a11y.js) scans the project pages → violations carry fix
//   descriptors → a11yFixActions turns them into repair-executor actions →
//   executeRepairs applies each aria-label/alt fix to the project files and
//   keeps it only when the re-measured violation count drops → a fresh
//   checkA11y re-run shows the counts down, with the honest residue (an unnamed
//   icon-only button has no text to derive a label from) reported, not swept.
//
// Fixture project (OS temp dir, two pages — mirrors a real clone layout):
//   index.html
//     <button id="btn-save"><span aria-hidden="true">Save changes</span></button>
//       → has visible text, but aria-hidden text names nothing to assistive
//         tech: unnamed violation, fix = aria-label from the visible text
//     <img src="assets/hero-banner.png">  → descriptive filename → alt="hero banner"
//   settings.html
//     <button id="btn-icon" class="icon-btn"><svg …></svg></button>
//       → unnamed, NO text context at all → NO fix, honest unfixed bug entry
//     <img src="assets/brand-mark.png">   → assetMap records the original alt
//     <img src="assets/1.png">            → non-descriptive filename → alt="" decorative
//
// No package.json script here — runs via `node scripts/test-a11y-repair.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../src/browser.js";
import { checkA11y, a11yFixActions, unfixedBugs } from "../src/reconstruction/verify-a11y.js";
import { executeRepairs } from "../src/reconstruction/repair-executor.js";
import { readHistory } from "../src/reconstruction/repair-history.js";
import { solidPng } from "./fixtures/server.mjs";

let passCount = 0;
let failCount = 0;
const failures = [];

function check(label, ok, detail = "") {
  if (ok) { passCount++; console.log(`  PASS  ${label}`); }
  else { failCount++; failures.push(`${label}${detail ? " — " + detail : ""}`); console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
}

const INDEX_HTML = `<!doctype html>
<html><head><title>A11y Repair Fixture</title></head>
<body>
<main>
  <button data-cloner-trigger="t-save" id="btn-save"><span aria-hidden="true">Save changes</span></button>
  <img src="assets/hero-banner.png">
</main>
</body></html>`;

const SETTINGS_HTML = `<!doctype html>
<html><head><title>Settings — A11y Repair Fixture</title></head>
<body>
<main>
  <button data-cloner-trigger="t-menu" id="btn-icon" class="icon-btn"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 2l12 12M14 2L2 14"></path></svg></button>
  <img src="assets/brand-mark.png">
  <img src="assets/1.png">
</main>
</body></html>`;

// the exploration side can record the ORIGINAL alt per asset path — the most
// trusted alt source (plain string values are remap paths, not alts)
const ASSET_MAP = { "assets/brand-mark.png": { alt: "Company brand mark" } };

function writeProject(dir) {
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), INDEX_HTML);
  fs.writeFileSync(path.join(dir, "settings.html"), SETTINGS_HTML);
  fs.writeFileSync(path.join(dir, "assets", "hero-banner.png"), solidPng(9, 105, 201));
  fs.writeFileSync(path.join(dir, "assets", "brand-mark.png"), solidPng(40, 40, 40));
  fs.writeFileSync(path.join(dir, "assets", "1.png"), solidPng(200, 200, 200));
}

const fileUrl = (dir, file) => "file:///" + path.join(dir, file).replace(/\\/g, "/");

async function main() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "a11y-repair-"));
  let browser = null;
  try {
    console.log(`a11y repair test — fixture project at ${projectDir} (file://, offline)\n`);
    writeProject(projectDir);
    browser = await launchBrowser({ headless: true });
    const openPage = async (file) => {
      const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await p.goto(fileUrl(projectDir, file), { waitUntil: "load", timeout: 20000 });
      return p;
    };

    // 1. baseline scan — the fixture carries exactly 5 violations (2 + 3)
    let p = await openPage("index.html");
    const baseIndex = await checkA11y(p, { file: "index.html", assetMap: ASSET_MAP });
    await p.close();
    p = await openPage("settings.html");
    const baseSettings = await checkA11y(p, { file: "settings.html", assetMap: ASSET_MAP });
    await p.close();
    const violations = [...baseIndex.violations, ...baseSettings.violations];
    check("baseline: 5 violations (2 unnamed + 3 images without alt)", violations.length === 5 && baseIndex.violations.length === 2 && baseSettings.violations.length === 3, violations.map((v) => v.rule + ":" + v.offender).join(" | "));
    check("violations carry the { severity, offender, fix } contract", violations.every((v) => "severity" in v && "offender" in v && "fix" in v), "");
    check("btn-save flagged unnamed (visible but aria-hidden text names nothing to AT)", baseIndex.offenders.unnamed.some((s) => s.includes("btn-save")), baseIndex.offenders.unnamed.join(" | "));
    check("btn-icon flagged unnamed (no text at all)", baseSettings.offenders.unnamed.some((s) => s.includes("btn-icon")), baseSettings.offenders.unnamed.join(" | "));

    // 2. plan — fixable violations → deterministic executor actions
    const actions = a11yFixActions(violations);
    check("plan: 4 fixable violations → 4 actions", actions.length === 4, actions.map((a) => `${a.id}:${a.kind}`).join(" | "));
    const nameFix = actions.find((a) => a.kind === "a11y-name");
    check("plan: a11y-name derives aria-label from the visible text", !!nameFix && nameFix.payload.value === "Save changes" && nameFix.payload.source === "text" && nameFix.payload.file === "index.html", JSON.stringify(nameFix || {}).slice(0, 160));
    const heroAlt = actions.find((a) => a.kind === "a11y-alt" && a.payload.locator?.value === "assets/hero-banner.png");
    check("plan: hero-banner.png → alt from its own filename", !!heroAlt && heroAlt.payload.value === "hero banner" && heroAlt.payload.source === "filename", heroAlt ? `${heroAlt.payload.value} (${heroAlt.payload.source})` : "missing");
    const brandAlt = actions.find((a) => a.kind === "a11y-alt" && a.payload.value === "Company brand mark");
    check("plan: brand-mark.png → alt from the assetMap original", !!brandAlt && brandAlt.payload.source === "assetmap" && brandAlt.payload.file === "settings.html", brandAlt ? brandAlt.payload.source : "missing");
    const deco = actions.find((a) => a.kind === "a11y-alt" && a.payload.source === "decorative");
    check("plan: 1.png → decorative alt=\"\" with an honest note", !!deco && deco.payload.value === "" && /no descriptive words/.test(deco.reason), deco ? deco.reason : "missing");
    const bugs = unfixedBugs(violations);
    check("plan: icon-only button stays as an honest unfixed bug entry", bugs.length === 1 && bugs[0].severity === "medium" && bugs[0].evidence.offender.includes("btn-icon") && /no visible text/.test(bugs[0].what), JSON.stringify(bugs));

    // 3. repair loop — executor applies the actions; score = −violation count
    const score = async (dir) => {
      let n = 0;
      for (const f of ["index.html", "settings.html"]) {
        const pg = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        try {
          await pg.goto(fileUrl(dir, f), { waitUntil: "load", timeout: 20000 });
          n += (await checkA11y(pg, { file: f })).violations.length;
        } finally { await pg.close().catch(() => {}); }
      }
      return -n;
    };
    const repair = await executeRepairs(projectDir, actions, { maxRounds: actions.length, checkFns: { a11y: (dir) => score(dir) } });
    check("repair: baseline measured at −5 violations", repair.baseline.a11y === -5, String(repair.baseline.a11y));
    check("repair: all 4 actions applied and kept", repair.applied.length === 4 && repair.reverted.length === 0 && repair.stopped === "exhausted", repair.rounds.map((r) => `${r.action.id}:${r.kept ? "kept" : "reverted"}`).join(" | "));
    check("repair: violations 5 → 1 (score −5 → −1, improved)", repair.final.a11y === -1 && repair.improved === true, `${repair.baseline.a11y} → ${repair.final.a11y}`);
    check("repair: history records 4 kept rounds", readHistory(repair.historyPath).filter((e) => e.kept).length === 4, repair.historyPath);

    // 4. the fixes landed in the generated project files
    const idx = fs.readFileSync(path.join(projectDir, "index.html"), "utf8");
    const st = fs.readFileSync(path.join(projectDir, "settings.html"), "utf8");
    check("file: btn-save carries aria-label=\"Save changes\"", /<button[^>]*id="btn-save"[^>]*aria-label="Save changes"/.test(idx), idx.match(/<button[^>]*btn-save[^>]*>/)?.[0] || "");
    check("file: hero-banner img carries alt=\"hero banner\"", /<img[^>]*src="assets\/hero-banner\.png"[^>]*alt="hero banner"/.test(idx), idx.match(/<img[^>]*hero-banner[^>]*>/)?.[0] || "");
    check("file: brand-mark img carries the recorded alt", /<img[^>]*src="assets\/brand-mark\.png"[^>]*alt="Company brand mark"/.test(st), st.match(/<img[^>]*brand-mark[^>]*>/)?.[0] || "");
    check("file: 1.png marked decorative (alt=\"\")", /<img[^>]*src="assets\/1\.png"[^>]*alt=""/.test(st), st.match(/<img[^>]*1\.png[^>]*>/)?.[0] || "");
    check("file: icon-only button left untouched (no invented label)", !/id="btn-icon"[^>]*aria-label/i.test(st) && !/aria-label[^>]*id="btn-icon"/i.test(st), st.match(/<button[^>]*btn-icon[^>]*>/)?.[0] || "");

    // 5. re-check on the repaired project — counts decreased, residue honest
    p = await openPage("index.html");
    const afterIndex = await checkA11y(p, { file: "index.html", assetMap: ASSET_MAP });
    await p.close();
    p = await openPage("settings.html");
    const afterSettings = await checkA11y(p, { file: "settings.html", assetMap: ASSET_MAP });
    await p.close();
    const after = [...afterIndex.violations, ...afterSettings.violations];
    check("re-check: index.html shows 0 violations", afterIndex.violations.length === 0, JSON.stringify(afterIndex.violations));
    check("re-check: settings.html keeps exactly the unfixable btn-icon", afterSettings.violations.length === 1 && afterSettings.violations[0].offender.includes("btn-icon") && afterSettings.violations[0].fix === null, JSON.stringify(afterSettings.violations).slice(0, 200));
    check("re-check: total violations decreased 5 → 1", after.length === 1 && after.length < violations.length, `${violations.length} → ${after.length}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (failCount === 0 && !process.env.CLONER_KEEP_FIXTURE) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    } else {
      console.log(`\n(temp fixture kept for debugging: ${projectDir})`);
    }
  }
  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount) { console.log("failures:\n  - " + failures.join("\n  - ")); process.exit(1); }
}

main().catch((e) => {
  console.error("test crashed:", e?.stack || e);
  process.exit(1);
});
