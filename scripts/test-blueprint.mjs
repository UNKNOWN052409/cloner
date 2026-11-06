// Blueprint module tests (ADR-0003): fixture artifacts → blueprint.json contract.
// Deterministic, offline: builds a synthetic artifacts dir in the OS temp dir and
// asserts the fidelity-contract fields (scope, stack, regions, interaction model,
// acceptance evidence, ambiguities).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBlueprint, parseInstructions, detectStack } from "../src/reconstruction/blueprint.js";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (detail ? " — " + detail : "")); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bp-test-"));
fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({
  schemaVersion: 2, jobId: "bp-fixture", status: "completed",
  originalUrl: "https://demo.example.com/",
  discoveredRoutes: 3, discoveredStates: 2, discoveredInteractions: 0,
  assets: 12,
  coverage: { routesExplored: 3, routesDiscovered: 4, statesRecorded: 2 },
  pages: [
    { pageId: "page-001", url: "https://demo.example.com/", route: { url: "https://demo.example.com/", source: "seed", reasons: ["seed"] }, records: 2, domSampled: 5 },
    { pageId: "page-002", url: "https://demo.example.com/pricing", records: 0, domSampled: 3 },
  ],
}));
fs.mkdirSync(path.join(tmp, "pages", "page-001"), { recursive: true });
fs.writeFileSync(path.join(tmp, "pages", "page-001", "dom.json"), JSON.stringify({
  pageId: "page-001", url: "https://demo.example.com/", total: 6, sampled: 6,
  elements: [
    { i: 0, tag: "header", cls: "site-header", rect: { x: 0, y: 0, w: 1440, h: 60 }, layout: { display: "flex", position: "sticky" } },
    { i: 1, tag: "h1", cls: "hero-title", text: "Demo", rect: { x: 0, y: 80, w: 800, h: 48 }, layout: { display: "block", position: "static" } },
    { i: 2, tag: "footer", cls: "site-footer", rect: { x: 0, y: 900, w: 1440, h: 120 }, layout: { display: "block", position: "static" } },
    { i: 3, tag: "div", cls: "card", src: "/wp-content/themes/demo/style.css", rect: { x: 0, y: 200, w: 600, h: 200 }, layout: { display: "block", position: "static" } },
  ],
  repeated: [{ signature: "div|card", count: 4 }],
  typography: [{ font: "Georgia", size: "16px", weight: "w400", occurrences: 9 }],
}));
fs.mkdirSync(path.join(tmp, "graph"), { recursive: true });
fs.writeFileSync(path.join(tmp, "graph", "routes.json"), JSON.stringify({ routes: [{ url: "/", via: "seed", reasons: ["seed"] }], policy: {} }));
fs.writeFileSync(path.join(tmp, "graph", "states.json"), JSON.stringify({ nodes: [{ id: "s0" }, { id: "s1" }], edges: [], stats: {} }));

// 1) instruction parsing
const p1 = parseInstructions("only clone the pricing page; exclude the blog and careers page");
check("parse: include captured", p1.scope.include.some((s) => /pricing/i.test(s)));
check("parse: exclude captured", p1.scope.exclude.some((s) => /blog/i.test(s)));
check("parse: applied flag true", p1.applied === true);
const p2 = parseInstructions("");
check("parse: empty → not applied", p2.applied === false && p2.scope.include.length === 0);

// 2) stack detection
const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "manifest.json"), "utf8"));
const st = detectStack(tmp, manifest);
check("stack: wordpress detected via wp-content", st.detected.includes("wordpress"), JSON.stringify(st.detected));

// 3) full blueprint with instructions + framework preference
const res = buildBlueprint(tmp, { instructions: "only clone the pricing page; exclude the blog and careers page", frameworkPreference: "react" });
check("blueprint: ok", res.ok === true, res.why || "");
check("blueprint.json written", fs.existsSync(path.join(tmp, "blueprint.json")));
const bp = JSON.parse(fs.readFileSync(path.join(tmp, "blueprint.json"), "utf8"));
check("blueprint: version 1", bp.version === 1);
check("blueprint: raw instructions preserved", bp.instructions.raw.includes("pricing"));
check("blueprint: scope include recorded", bp.instructions.scope.include.length > 0);
check("blueprint: scope exclude recorded", bp.instructions.scope.exclude.length > 0);
check("blueprint: framework preference honored", bp.stack.output.framework === "react");
check("blueprint: engine output honesty (static + note)", bp.stack.output.engineOutput === "static" && Boolean(bp.stack.output.note));
check("blueprint: header region observed", bp.pages[0].regions.some((r) => r.region === "header"));
check("blueprint: footer region observed", bp.pages[0].regions.some((r) => r.region === "footer"));
check("blueprint: hero region observed", bp.pages[0].regions.some((r) => r.region === "hero"));
check("blueprint: region evidence observed", bp.pages[0].regions.every((r) => r.evidence === "observed"));
check("blueprint: components from repeated signatures", bp.pages[0].components.some((c) => c.includes("card")));
check("blueprint: interaction model recorded", typeof bp.interactions.model === "string" && bp.interactions.model !== "");
check("blueprint: acceptance evidence populated", bp.acceptanceEvidence.length >= 3);
check("blueprint: unexplored-route ambiguity", bp.ambiguities.some((a) => /unexplored/.test(a)));
check("blueprint: framework preference flagged as ambiguity", bp.ambiguities.some((a) => /framework preference/.test(a)));
check("blueprint: coverage echoed", bp.coverage && bp.coverage.routesExplored === 3);
check("blueprint: assets reuse-local observed", bp.assets.strategy === "reuse-local" && bp.assets.count === 12);

// 4) no preference → recommendation path, no framework ambiguity
const bp2 = buildBlueprint(tmp, {}).blueprint;
check("blueprint: default framework from detected stack", bp2.stack.output.reason.includes("recommended from detected stack"));
check("blueprint: no-preference → no framework ambiguity", !bp2.ambiguities.some((a) => /framework preference/.test(a)));

// 5) not an artifacts dir → honest refusal
const res3 = buildBlueprint(path.join(tmp, "does-not-exist"));
check("blueprint: missing manifest → ok:false", res3.ok === false && /manifest/.test(res3.why));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
