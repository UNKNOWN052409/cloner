import { chromium } from "playwright";
const b = await chromium.launch({ headless: false, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 180)));
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.evaluate(() => localStorage.removeItem("tv-clone-workspaces"));
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(900);
const snap = () => p.evaluate(() => ({
  modules: document.querySelectorAll(".tv-module").length,
  columns: document.querySelectorAll(".tv-column").length,
  groups: document.querySelectorAll(".tv-group").length,
  workspaceChildren: document.querySelector(".tv-workspace")?.children.length,
  workspaceText: (document.querySelector(".tv-workspace")?.innerText || "").trim().slice(0, 80),
  topbar: !!document.querySelector(".tv-topbar"),
}));
console.log("start:", JSON.stringify(await snap()));
// close every module via close-all loop (click each module's close button until none left)
let guard = 0;
while ((await p.locator(".tv-module").count()) > 0 && guard++ < 60) {
  await p.locator('.tv-module button[title="Close module"]').first().click({ force: true }).catch(() => {});
  await p.waitForTimeout(120);
}
await p.waitForTimeout(500);
console.log("after closing everything:", JSON.stringify(await snap()));
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/bug-empty-workspace.png" });
// try adding a module from the palette
await p.click(".tv-plus"); await p.waitForTimeout(300);
const tiles = await p.locator(".tv-palette-tile").count();
await p.locator(".tv-palette-tile").nth(0).click(); await p.waitForTimeout(700);
console.log("after add attempt:", JSON.stringify(await snap()), "| palette tiles:", tiles);
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/bug-add-after-close.png" });
console.log("errors:", errs.slice(0, 5));
await b.close();
