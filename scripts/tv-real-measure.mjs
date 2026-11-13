// One-shot REAL Tradovate measurement: login once, then measure chart/module caps,
// tab behaviour and the Tradovate Assistant panel close/End-Chat behaviour.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const EVID = path.join(ROOT, "artifacts", "tradovate-live-capture", "evidence");
const SHOTS = path.join(ROOT, "artifacts", "tradovate-live-capture", "shots");
const env = {};
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) { const m = line.match(/^(TV_USER|TV_PASS)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const out = { startedAt: new Date().toISOString() };

const browser = await chromium.launch({ headless: false, channel: "chrome", args: ["--window-size=1620,950"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: "en-US" });
const page = await ctx.newPage();
page.setDefaultTimeout(25000);

const counts = () => page.evaluate(() => ({
  lmItems: document.querySelectorAll(".lm_item").length,
  stacks: document.querySelectorAll(".lm_item_container").length,
  tabs: document.querySelectorAll(".lm_tab").length,
  canvases: document.querySelectorAll("canvas").length,
  charts: document.querySelectorAll('[class*="chart"][class*="module"], [class*="module"][class*="chart"]').length,
}));

await page.goto("https://trader.tradovate.com/", { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(4000);
if (await page.locator('input[type="password"]').count()) {
  log("login");
  await page.locator('input[type="text"], input[type="email"], input[name="username"]').first().fill(env.TV_USER);
  await page.locator('input[type="password"]').first().fill(env.TV_PASS);
  await page.getByRole("button", { name: "Login", exact: true }).first().click();
  await page.waitForURL(/trading-mode|\/$/, { timeout: 60000 }).catch(() => {});
}
await page.waitForTimeout(3000);
log("post-login:", page.url());
// trading-mode gate
for (let i = 0; i < 12; i++) {
  const start = page.locator('button:has-text("Start Simulated Trading")');
  if (await start.count().catch(() => 0)) {
    log("start simulation");
    await start.first().click().catch(() => {});
  }
  await page.locator('button:has-text("Accept Cookies")').first().click({ timeout: 1200 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (await page.evaluate(() => document.querySelectorAll("canvas").length > 0).catch(() => false)) break;
}
await page.waitForTimeout(5000);
log("workspace:", page.url(), JSON.stringify(await counts()));
await page.screenshot({ path: path.join(SHOTS, "measure-00-workspace.png") });
fs.writeFileSync(path.join(EVID, "live-session2.json"), JSON.stringify(await ctx.storageState(), null, 2));
const ss = await page.evaluate(() => { const grab = (s) => Object.fromEntries(Object.entries({ ...s }).map(([k, v]) => [k, String(v)])); return { ls: grab(localStorage), ss: grab(sessionStorage) }; });
fs.writeFileSync(path.join(EVID, "live-session2-storage.json"), JSON.stringify(ss, null, 2));

/* ---------------- assistant behaviour ---------------- */
const assistantProbe = async () => page.evaluate(() => {
  const iframe = document.querySelector("iframe");
  const rig = iframe ? iframe.getBoundingClientRect() : null;
  const buttons = [];
  for (const el of document.querySelectorAll("button, [role=button], a, i[class*=icon], div[class*=close], span[class*=close]")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const aria = el.getAttribute("title") || el.getAttribute("aria-label") || "";
    const txt = (el.innerText || "").trim().slice(0, 20);
    if (r.x > 1000 && r.width < 60 && r.height < 60) buttons.push({ tag: el.tagName, cls: (el.className || "").toString().slice(0, 60), txt, aria, x: Math.round(r.x), y: Math.round(r.y) });
  }
  return { iframeRect: rig ? { x: Math.round(rig.x), y: Math.round(rig.y), w: Math.round(rig.width), h: Math.round(rig.height) } : null, rightRailButtons: buttons };
});
out.assistant = { before: await assistantProbe() };
log("assistant iframe:", JSON.stringify(out.assistant.before.iframeRect), "right buttons:", out.assistant.before.rightRailButtons.length);

// click the top-right X of the assistant panel (live UI: close icon in panel header)
const closeCandidates = out.assistant.before.rightRailButtons.filter((b) => /close/i.test(b.cls) || /close|✕|×/i.test(b.aria + b.txt));
out.assistant.closeCandidates = closeCandidates;
if (closeCandidates.length) {
  await page.mouse.click(closeCandidates[0].x + 8, closeCandidates[0].y + 8);
  await page.waitForTimeout(1800);
  out.assistant.afterClose = await assistantProbe();
  await page.screenshot({ path: path.join(SHOTS, "measure-01-assistant-close.png") });
  log("after close click iframe:", JSON.stringify(out.assistant.afterClose.iframeRect));
}
// End Chat inside the Ada iframe
try {
  const frame = page.frames().find((f) => /ada|chat/i.test(f.url()));
  if (frame) {
    const end = frame.locator('button:has-text("End Chat")').first();
    out.assistant.endChatVisible = await end.count().catch(() => 0);
    if (out.assistant.endChatVisible) {
      await end.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1800);
      out.assistant.afterEndChat = await page.evaluate(() => ({ iframe: !!document.querySelector("iframe"), hasEndChat: /End Chat/i.test(document.body.innerText) }));
      await page.screenshot({ path: path.join(SHOTS, "measure-02-assistant-endchat.png") });
    }
  } else out.assistant.frameNotFound = true;
} catch (e) { out.assistant.endChatError = e.message.slice(0, 120); }
log("assistant result:", JSON.stringify({ close: out.assistant.afterClose?.iframeRect, end: out.assistant.afterEndChat }));

/* ---------------- charts limit ---------------- */
const addChart = async (i) => {
  await page.locator(".icon-plus").first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(800);
  const tile = page.locator("li").filter({ hasText: /^Chart$/ }).first();
  if (!(await tile.count().catch(() => 0))) { await page.keyboard.press("Escape"); return { ok: false, why: "palette-chart-tile-missing" }; }
  const box = await tile.boundingBox();
  if (!box) { await page.keyboard.press("Escape"); return { ok: false, why: "tile-box-missing" }; }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(820, 420, { steps: 8 });
  await page.mouse.move(900, 480, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(2500);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);
  const txt = await page.evaluate(() => [...document.querySelectorAll('[class*="toast"],[class*="notification"],[class*="alert"],[role="alert"]')].map((e) => (e.innerText || "").trim()).filter(Boolean).slice(0, 4).join(" | "));
  return { ok: true, toast: txt.slice(0, 200) };
};

out.chartAttempts = [];
let prevItems = (await counts()).lmItems;
let prevTabs = (await counts()).tabs;
for (let i = 1; i <= 12; i++) {
  const attempt = await addChart(i);
  const c = await counts();
  out.chartAttempts.push({ i, ...attempt, ...c });
  log(`chart add ${i}: lmItems ${c.lmItems} tabs ${c.tabs} canvases ${c.canvases}`, attempt.toast ? "| toast: " + attempt.toast : "");
  if (c.lmItems <= prevItems && c.tabs <= prevTabs) {
    out.chartLimitReachedAt = i;
    out.chartLimitEvidence = attempt;
    break;
  }
  prevItems = Math.max(prevItems, c.lmItems);
  prevTabs = Math.max(prevTabs, c.tabs);
}
await page.screenshot({ path: path.join(SHOTS, "measure-03-charts-limit.png") });

/* ---------------- module / tab counts ---------------- */
out.finalCounts = await counts();
out.tabsPerStack = await page.evaluate(() => [...document.querySelectorAll(".lm_stack")].map((s) => ({ tabs: s.querySelectorAll(".lm_tab").length, titles: [...s.querySelectorAll(".lm_tab")].map((t) => (t.innerText || "").trim().slice(0, 24)) })));

fs.writeFileSync(path.join(EVID, "limits.json"), JSON.stringify(out, null, 2));
log("RESULT", JSON.stringify({
  assistantBefore: out.assistant.before.iframeRect,
  assistantAfterClose: out.assistant.afterClose?.iframeRect,
  endChat: out.assistant.afterEndChat,
  chartAttempts: out.chartAttempts.map((a) => `${a.i}:${a.lmItems}/${a.tabs}`).join(" "),
  limitAt: out.chartLimitReachedAt || "not reached (12)",
  final: out.finalCounts,
}));
await browser.close();
