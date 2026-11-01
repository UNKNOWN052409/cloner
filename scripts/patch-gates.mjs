// One-shot patcher: parallelize regression-gate loops in the 5 workflow scripts
// (batches of 3 instead of sequential), + add TURN EFFICIENCY mandate to CTX.
import fs from "node:fs";

const files = [
  [".zcode/phase35-workflow.dwf.ts", "suites35", false],
  [".zcode/phase40-workflow.dwf.ts", "suites40", false],
  [".zcode/phase41-workflow.dwf.ts", "suites41", true],
  [".zcode/phase42-workflow.dwf.ts", "suites42", true],
  [".zcode/final-gate-workflow.dwf.ts", "finalgate", true],
];

for (const [f, tag, addTurn] of files) {
  let t = fs.readFileSync(f, "utf8");
  if (t.includes("const batch = SUITES.slice")) {
    console.log(f, "— already parallel");
    continue;
  }

  // locate the sequential gate loop by its stable opening line
  const open = "  for (const suite of SUITES) {";
  const openIdx = t.indexOf(open);
  if (openIdx < 0) {
    console.log(f, "— gate loop NOT found");
    continue;
  }
  // find the matching closing "\n  }\n" after the loop start
  const closeIdx = t.indexOf("\n  }\n", openIdx);
  if (closeIdx < 0) {
    console.log(f, "— loop close NOT found");
    continue;
  }
  const loopBody = t.slice(openIdx, closeIdx + 4);

  // extract the report tag actually used inside this loop
  const tagMatch = loopBody.match(/report\(res, "([A-Za-z0-9]+)"\)/);
  const actualTag = tagMatch ? tagMatch[1] : tag;
  // preserve the tail size (4096 in gates, 2048 in post-QA reruns)
  const tailSize = loopBody.includes("tail: 2048") ? "2048" : "4096";

  const parallelLoop = `  for (let i = 0; i < SUITES.length; i += 3) {
    const batch = SUITES.slice(i, i + 3);
    const batchResults = await Promise.all(batch.map((suite) =>
      world.run("node", [suite], { timeoutMs: 420_000, output: { tail: ${tailSize} } }).then((r) => {
        const lines = (r.stdout || "").trim().split("\\n");
        const tail = lines[lines.length - 1] || r.stderr.slice(-200);
        return { suite, exitCode: r.exitCode, tail };
      }),
    ));
    for (const res of batchResults) {
      results.push(res);
      report(res, "${actualTag}");
      if (res.exitCode !== 0) failed.push(res);
    }
  }`;

  t = t.slice(0, openIdx) + parallelLoop.trimEnd() + "\n" + t.slice(closeIdx + 4);

  // TURN EFFICIENCY mandate: append to the CTX array (before its closing ].join)
  if (addTurn && !t.includes("TURN EFFICIENCY")) {
    const ctxClose = t.indexOf('].join("\\n");');
    if (ctxClose >= 0) {
      const mandate =
        '  "TURN EFFICIENCY: complete your ENTIRE task in ONE long turn — implement, write tests, run them, fix failures, re-verify, and only then return. Every extra round-trip costs minutes; if your plan needs many check-ins, you are doing it wrong. Batch all your file edits and test runs.",\n';
      t = t.slice(0, ctxClose) + mandate + t.slice(ctxClose);
      console.log(f, "— turn-efficiency mandate added");
    }
  }

  fs.writeFileSync(f, t);
  console.log(f, "— gate parallelized (batches of 3, tag:", actualTag + ")");
}
console.log("patch complete");
