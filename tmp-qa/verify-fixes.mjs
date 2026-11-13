import { chromium } from "playwright";
const b = await chromium.launch({ headless: false, channel: "chrome" });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
const log = (...a) => console.log(...a);
await p.goto("http://127.0.0.1:5199/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".tv-app"); await p.waitForTimeout(1200);
await p.screenshot({ path: "artifacts/tradovate-live-capture/shots/fix-01-baseline.png" });
const mods = () => p.locator(".tv-module").count();
const tabs = () => p.locator(".tv-module-tab").count();
log("baseline modules:", await mods(), "tabs:", await tabs());

// 1) + toggles palette open/close/open
await p.click(".tv-plus"); await p.waitForTimeout(400);
log("palette open:", await p.locator(".tv-palette").count());
await p.locator(".tv-palette-close").click(); await p.waitForTimeout(400);
log("palette closed:", await p.locator(".tv-palette").count());
await p.click(".tv-plus"); await p.waitForTimeout(400);
log("palette reopened:", await p.locator(".tv-palette").count());
await p.locator(".tv-palette-close").click(); await p.waitForTimeout(300);

// 2) adding Accounts again should add a TAB, not a duplicate pane
const before = await mods(), beforeTabs = await tabs();
await p.click(".tv-plus"); await p.waitForTimeout(250);
await p.locator(".tv-palette-tile").filter({ hasText: "Accounts" }).first().click();
await p.waitForTimeout(600);
log("after adding Accounts: modules", await mods(), "(was", before + ") tabs", await tabs(), "(was", beforeTabs + ")");
await p.screenshot({ path: "artifacts/tradovate-live-capture/shots/fix-02-accounts-tab.png" });

// 3) chart tab "+" opens symbol picker; pick a symbol -> new tab
const chartAdd = p.locator(".tv-module").nth(2).locator(".tv-module-tabs > .tv-icon-btn").first();
await chartAdd.click(); await p.waitForTimeout(400);
const menuItems = p.locator(".tv-menu .tv-menu-item");
log("symbol add-tab menu items:", await menuItems.count());
await p.screenshot({ path: "artifacts/tradovate-live-capture/shots/fix-03-addtab-menu.png" });
if (await menuItems.count()) { await menuItems.first().click(); await p.waitForTimeout(600); }
log("after add-tab: modules", await mods(), "tabs", await tabs());

// 4) chart symbol picker (searchable)
await p.locator(".tv-symbol-picker-btn").first().click(); await p.waitForTimeout(500);
const rows = await p.locator(".tv-symbol-picker-row").count();
const groupCount = await p.locator(".tv-symbol-picker-list .tv-menu-heading").count();
log("symbol picker rows:", rows, "groups:", groupCount);
await p.screenshot({ path: "artifacts/tradovate-live-capture/shots/fix-04-symbol-picker.png" });
await p.keyboard.type("gold"); await p.waitForTimeout(400);
log("filtered rows for 'gold':", await p.locator(".tv-symbol-picker-row").count());
await p.screenshot({ path: "artifacts/tradovate-live-capture/shots/fix-05-symbol-search.png" });
await p.keyboard.press("Escape"); await p.waitForTimeout(300);

// 5) Market Analyzer shows the captured popular list
await p.click(".tv-plus"); await p.waitForTimeout(250);
await p.locator(".tv-palette-tile").filter({ hasText: "Market Analyzer" }).first().click();
await p.waitForTimeout(700);
const maText = await p.locator(".tv-module").last().innerText();
log("MA module text sample:", maText.replace(/\s+/g, " ").slice(0, 260));
await p.screenshot({ path: "artifacts/tradovate-live-capture/shots/fix-06-market-analyzer.png" });
log("errors:", errs.slice(0, 5));
await b.close();
