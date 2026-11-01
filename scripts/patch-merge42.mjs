// Merge the 4.2 TASKS array into the grand-final workflow as Group 0 (distributed completion)
import fs from "node:fs";

const t42 = fs.readFileSync(".zcode/phase42-workflow.dwf.ts", "utf8");
let tG = fs.readFileSync(".zcode/grand-final-workflow.dwf.ts", "utf8");

if (tG.includes("4.2.1")) { console.log("grand-final already has 4.2 tasks"); process.exit(0); }

const start42 = t42.indexOf("const TASKS: TaskSpec[] = [");
const end42 = t42.indexOf("\n];", start42);
if (start42 < 0 || end42 < 0) { console.log("phase42 TASKS not found"); process.exit(1); }
const tasks42 = t42.slice(start42, end42 + 3).replace("const TASKS: TaskSpec[] = [", "[").trimEnd();

const groupDef = `  {
    phaseName: "Group 0: distributed scale completion (4.2)",
    tasks: ${tasks42},
  },
`;

const allGroupsAnchor = "const ALL_GROUPS: { phaseName: string; tasks: TaskSpec[] }[] = [";
const anchorIdx = tG.indexOf(allGroupsAnchor);
if (anchorIdx < 0) { console.log("ALL_GROUPS anchor missing"); process.exit(1); }
const anchorEnd = tG.indexOf("\n", anchorIdx) + 1;
tG = tG.slice(0, anchorEnd) + groupDef + tG.slice(anchorEnd);

// pre-report board items for the 16 4.2 tasks
let boardAdds = "";
for (let i = 1; i <= 16; i++) boardAdds += `report({ task: "4.2.${i}", status: "running" }, "grand-tasks");\n`;
const boardAnchor = tG.indexOf('artifact.table("grand-suites"');
const boardEnd = tG.indexOf("});", boardAnchor) + 3;
tG = tG.slice(0, boardEnd) + "\n" + boardAdds + tG.slice(boardEnd);

fs.writeFileSync(".zcode/grand-final-workflow.dwf.ts", tG);
console.log("merged 4.2 tasks into grand-final; len:", tG.length);
