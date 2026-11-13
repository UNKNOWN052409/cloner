import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(1000);
// chart studies + drawing via context menu
const chart = p.locator(".mod-chart").first();
const box = await chart.boundingBox();
const rightClick = async () => { await p.mouse.click(box.x + 160, box.y + 90, { button: "right" }); await p.waitForTimeout(250); };
await rightClick();
const items = await p.locator(".tv-menu .tv-menu-item").allInnerTexts();
console.log("chart menu items:", JSON.stringify(items));
const clickItem = async (label) => { await rightClick(); const it = p.locator(".tv-menu .tv-menu-item").filter({ hasText: label }).first(); if (await it.count()) await it.click(); await p.waitForTimeout(300); };
await clickItem("Volume");
await clickItem("VWAP");
await clickItem("Bollinger Bands");
await clickItem("Add horizontal line");
await p.waitForTimeout(500);
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/f1-chart-studies.png" });
const studiesState = await p.evaluate(() => document.querySelector(".mod-chart canvas")?.width > 0);
console.log("chart rendered after studies:", studiesState, "errors:", errs.slice(0,3));
// options chain empty state
await p.click(".tv-plus"); await p.waitForTimeout(250);
await p.locator(".tv-palette-tile").nth(12).click(); await p.waitForTimeout(700);
const ocText = await p.locator(".mod-optionsChain").last().innerText().catch(() => "");
console.log("options chain empty-state text:", JSON.stringify(ocText.replace(/\s+/g, " ").slice(0, 140)));
const rows = await p.locator(".mod-optionsChain .ma-symbol-row").count();
console.log("instrument rows:", rows);
if (rows) { await p.locator(".mod-optionsChain .ma-symbol-row").first().click(); await p.waitForTimeout(600); }
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/f2-options-chain.png" });
console.log("after pick has table:", await p.locator(".mod-optionsChain table").count());
// assistant handoff test
await p.locator(".tv-rail-btn").nth(0).click(); await p.waitForTimeout(400);
await p.locator(".tv-assistant-composer input").fill("talk to an agent");
await p.keyboard.press("Enter"); await p.waitForTimeout(2600);
const msgs = await p.locator(".tv-msg-bubble").allInnerTexts();
console.log("assistant handoff messages:", JSON.stringify(msgs.slice(-2).map((m) => m.slice(0, 90))));
await p.screenshot({ path: "artifacts/tradovate-live-capture/qa-full/f3-assistant-handoff.png" });
console.log("errors:", errs.slice(0, 5));
await b.close();
