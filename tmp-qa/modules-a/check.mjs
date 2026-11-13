// QA-only Playwright check for the modules-a deliverable.
// Run from D:\project 2\cloner :  node tmp-qa/modules-a/check.mjs
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, "shots");
fs.mkdirSync(shots, { recursive: true });

const results = [];
const failures = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  if (!ok) failures.push(name + (detail ? ` — ${detail}` : ""));
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));

const url = pathToFileURL(path.join(here, "harness.html")).href;
await page.goto(url);
await page.waitForSelector(".mod", { timeout: 15000 });
await page.waitForFunction(() => {
  const el = document.querySelector('[data-harness="counts"]');
  return el && /positions=3/.test(el.textContent);
}, null, { timeout: 15000 });

const nav = async (type) => {
  await page.click(`[data-module="${type}"]`);
  await page.waitForSelector(`.mod.mod-${type}`, { timeout: 5000 });
  await page.waitForTimeout(250);
};
const shot = async (name) => page.screenshot({ path: path.join(shots, name + ".png"), fullPage: false });
const text = async (sel) => (await page.locator(sel).first().innerText()).trim();
const counts = async () => (await page.locator('[data-harness="counts"]').innerText()).trim();
const parseCount = (s, key) => Number((s.match(new RegExp(key + "=(\\d+)")) || [])[1] || 0);

/* ---------------- screenshots of every module ---------------- */
for (const type of ["marketAnalyzer", "stocksHotList", "orders", "positions", "orderTicket", "timeSales", "tradePerformance", "pulse", "spreadMatrix", "optionsChain"]) {
  await nav(type);
  check(`render:${type}`, (await page.locator(`.mod.mod-${type}`).count()) === 1);
  await shot(`wide-${type}`);
}

/* ---------------- narrow module width (trading-terminal columns are tight) ---------------- */
await page.selectOption('[data-harness="width"]', "620");
for (const type of ["orderTicket", "pulse", "tradePerformance", "optionsChain", "spreadMatrix", "marketAnalyzer"]) {
  await nav(type);
  await shot(`narrow-${type}`);
}
await page.selectOption('[data-harness="width"]', "1000");

/* ---------------- Market Analyzer ---------------- */
await nav("marketAnalyzer");
const maRows = await page.locator(".ma-ma-table tbody tr").count();
check("ma:default rows", maRows >= 10, `rows=${maRows}`);
await page.fill('input[placeholder="Filter symbols…"]', "NVDA");
await page.waitForTimeout(120);
check("ma:filter narrows", (await page.locator(".ma-ma-table tbody tr").count()) === 1);
await page.fill('input[placeholder="Filter symbols…"]', "");
check("ma:sort last price", await (async () => {
  await page.click('.ma-ma-table th:has-text("LAST PRICE")');
  await page.waitForTimeout(80);
  const first = await text(".ma-ma-table tbody tr:first-child td:first-child");
  await page.click('.ma-ma-table th:has-text("LAST PRICE")');
  return first.length > 0;
})());
await page.click('button[title="Add symbol"]');
await page.waitForSelector(".tv-menu", { timeout: 3000 });
check("ma:add-symbol menu", (await page.locator(".tv-menu .tv-menu-item").count()) > 0);
await page.click('.tv-menu .tv-menu-item:has-text("MBTX6")');
await page.waitForTimeout(150);
check("ma:add-symbol toast", (await page.locator(".harness-toast").allInnerTexts()).some((t) => t.includes("Symbol added")));
await page.click('button[title="Reset symbol list"]');
await page.waitForTimeout(150);
check("ma:reset list toast", (await page.locator(".harness-toast").allInnerTexts()).some((t) => t.includes("Watch list reset")));
await shot("ma-after-interactions");

/* ---------------- Stocks Hot List ---------------- */
await nav("stocksHotList");
const hotFirst = async () => text(".ma-hot-table tbody tr:first-child td:first-child");
check("hot:most active sort", (await hotFirst()) === "NVDA", await hotFirst());
await page.click('.ma-tab:has-text("% Change")');
await page.waitForTimeout(120);
check("hot:% change sort", (await hotFirst()) === "AMD", await hotFirst());
await page.click(".ma-hot-table tbody tr:nth-child(3)");
await page.waitForTimeout(100);
check("hot:row detail", (await text(".ma-foot")).length > 10);
const hotSelected = await text(".ma-foot");
check("hot:detail symbol shown", /[A-Z]{2,5}/.test(hotSelected), hotSelected);
await page.click('.ma-hot-table th:has-text("VOLUME")');
await page.waitForTimeout(100);
await page.click('.ma-hot-units button:has-text("%")');
await page.waitForTimeout(100);
check("hot:turnover % toggle", (await page.locator(".ma-hot-table th").nth(3).innerText()).includes("TURNOVER (%)"));
await page.click('.ma-hot-units button:has-text("$")');
await page.waitForTimeout(100);
check("hot:turnover $ toggle", (await page.locator(".ma-hot-table th").nth(3).innerText()).includes("TURNOVER (USD)"));
await shot("hot-sorted");

/* ---------------- Orders ---------------- */
await nav("orders");
let c = await counts();
const ordersBefore = parseCount(c, "orders");
await page.click('[data-harness="spawn-orders"]');
await page.waitForTimeout(150);
check("orders:working rows", (await page.locator(".ma-badge--gold").count()) >= 1);
await page.locator(".ma-orders-table tbody tr").first().click({ button: "right" });
await page.waitForSelector(".tv-menu", { timeout: 3000 });
check("orders:context menu", (await page.locator(".tv-menu .tv-menu-item").count()) >= 3);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
await shot("orders-working");
await page.click('button:has-text("Cancel all")');
await page.waitForTimeout(150);
check("orders:cancel all", (await page.locator(".ma-badge--gold").count()) === 0);
check("orders:cancel all toast", (await page.locator(".harness-toast").allInnerTexts()).some((t) => t.includes("Cancel all")));
await page.fill('input[placeholder="Type to filter…"]', "MNQ");
await page.waitForTimeout(100);
const filteredRows = await page.locator(".ma-orders-table tbody tr").count();
check("orders:filter", filteredRows >= 1, `rows=${filteredRows}`);
await page.fill('input[placeholder="Type to filter…"]', "");
await page.click('.ma-toolbar .tv-seg button:has-text("Filled")');
await page.waitForTimeout(120);
const filledBadges = await page.locator(".ma-orders-table .ma-badge").allInnerTexts();
check("orders:status filter", filledBadges.length > 0 && filledBadges.every((s) => s.toLowerCase() === "filled"));
await page.click('.ma-toolbar .tv-seg button:has-text("All")');
await page.waitForTimeout(1600); // let staged orders fill
check("orders:fills applied", parseCount(await counts(), "orders") === ordersBefore + 2, await counts());
await shot("orders-filled");

/* ---------------- Order Ticket ---------------- */
await nav("orderTicket");
await page.click('.ma-ticket-tab:has-text("Sell")');
check("ticket:sell tab", (await page.locator(".ma-ticket-tab.is-sell").count()) === 1);
const ticketSelects = page.locator(".ma-ticket-left select");
await ticketSelects.nth(1).selectOption("LIMIT");
await page.waitForTimeout(150);
check("ticket:limit price field", (await page.locator(".ma-price-input").count()) === 1);
await ticketSelects.nth(1).selectOption("STOP");
await page.waitForTimeout(120);
check("ticket:stop price label", (await page.locator('.ma-field:has-text("STOP PRICE")').count()) === 1);
await ticketSelects.nth(1).selectOption("LIMIT");
await page.waitForTimeout(120);
await page.fill(".ma-price-input", "27200");
const ordersBeforeTicket = parseCount(await counts(), "orders");
await page.click(".ma-send");
await page.waitForTimeout(100);
check("ticket:confirm step", (await text(".ma-send")).startsWith("Confirm"));
await page.click(".ma-send");
await page.waitForTimeout(200);
check("ticket:order submitted", parseCount(await counts(), "orders") === ordersBeforeTicket + 1, await counts());
check("ticket:submit toast", (await page.locator(".harness-toast").allInnerTexts()).some((t) => t.includes("Sell 1 MNQZ6")));
// release = Off stages the order instead of routing it
await page.click('.ma-field:has-text("RELEASE") button:has-text("Off")');
await page.waitForTimeout(100);
await page.click(".ma-send");
await page.waitForTimeout(150);
check("ticket:staged for release", (await page.locator(".ma-staged-row").count()) === 1);
const ordersBeforeRelease = parseCount(await counts(), "orders");
await page.click('.ma-staged-row button:has-text("Release")');
await page.waitForTimeout(200);
check("ticket:released", parseCount(await counts(), "orders") === ordersBeforeRelease + 1, await counts());
await page.click(".ma-ticket-actions .tv-btn:has-text(\"Reset\")");
await shot("ticket-limit");

/* ---------------- T&S ---------------- */
await nav("timeSales");
check("ts:tabs", (await text(".ma-tape-head .ma-tab")) === "Ticks");
const tapeRows = await page.locator(".ma-tape-table tbody tr").count();
check("ts:tape seeded", tapeRows > 20, `rows=${tapeRows}`);
await page.click('button[title="Pause tape"]');
await page.waitForTimeout(300);
const pausedCount = await page.locator(".ma-tape-table tbody tr").count();
await page.waitForTimeout(1500);
check("ts:pause stops tape", (await page.locator(".ma-tape-table tbody tr").count()) === pausedCount);
check("ts:aggressor colors", (await page.locator(".ma-tape-row--buy, .ma-tape-row--sell").count()) > 10);
await shot("ts-paused");
await page.click('button[title="Resume tape"]');
await page.waitForTimeout(1200);
check("ts:resume appends", (await page.locator(".ma-tape-table tbody tr").count()) > pausedCount);
await page.click('button[title="Clear tape"]');
await page.waitForTimeout(120);
check("ts:clear", (await page.locator(".ma-tape-table tbody tr").count()) <= 2);

/* ---------------- Trade Performance ---------------- */
await nav("tradePerformance");
check("perf:title", (await page.locator(".ma-perf-title").innerText()).includes("Performance Center"));
const allText = await page.locator(".ma-grp").first().innerText();
const grossMatch = allText.match(/Gross P\/L\s+\$([\d,]+\.\d\d)/);
check("perf:computed gross", !!grossMatch && Number(grossMatch[1].replace(/,/g, "")) > 0, allText.replace(/\n/g, " | "));
check("perf:session label", (await page.locator(".ma-perf-sub").innerText()).includes("CURRENT TRADING SESSION DATA"));
await page.click('.ma-perf-head .tv-seg button:has-text("SHORT")');
await page.waitForTimeout(150);
check("perf:short scope", (await page.locator(".ma-grp").first().innerText()).includes("$0.00"));
await page.click('.ma-perf-head .tv-seg button:has-text("ALL")');
await shot("perf-all");

/* ---------------- Pulse ---------------- */
await nav("pulse");
check("pulse:10 instruments", (await page.locator(".ma-pulse-card").count()) === 10);
const pulseHead = await text(".ma-pulse-head");
const pulseTotals = (pulseHead.match(/(\d+) LONG\s+(\d+) SHORT\s+(\d+) NEUTRAL/) || []).slice(1).map(Number);
check(
  "pulse:sentiment counts",
  pulseTotals.length === 3 && pulseTotals[0] + pulseTotals[1] + pulseTotals[2] === 10 && pulseTotals[0] >= 1 && pulseTotals[1] >= 1,
  pulseHead.replace(/\n/g, " "),
);
check("pulse:gauges", (await page.locator(".ma-gauge svg").count()) === 10);
await page.click('.ma-pulse-head .tv-seg button:has-text("LONG")');
await page.waitForTimeout(120);
check("pulse:filter long", (await page.locator(".ma-pulse-card").count()) === pulseTotals[0]);
await page.click('.ma-pulse-card .tv-icon-btn');
await page.waitForSelector(".tv-menu", { timeout: 3000 });
check("pulse:kebab menu", (await page.locator(".tv-menu .tv-menu-item").count()) >= 3);
await page.click('.tv-menu .tv-menu-item:has-text("Set as active symbol")');
await page.waitForTimeout(150);
check("pulse:menu action toast", (await page.locator(".harness-toast").allInnerTexts()).some((t) => t.includes("Module symbol set")));
await page.click('.ma-pulse-head .tv-seg button:has-text("ALL")');
await shot("pulse-long");

/* ---------------- Spread Matrix ---------------- */
await nav("spreadMatrix");
const cells = await page.locator(".ma-mx-cell").count();
check("matrix:64 cells", cells === 64, `cells=${cells}`);
check("matrix:sticky headers", (await page.locator(".ma-mx-rowh").count()) === 8);
await page.locator(".ma-mx-cell").nth(1).click();
await page.waitForTimeout(120);
const mxFoot = await text(".ma-foot");
check("matrix:cell footer", mxFoot.includes("ratio") && mxFoot.includes("−"), mxFoot);
await page.click('.ma-toolbar button:has-text("Swap legs")');
await page.waitForTimeout(120);
check("matrix:swap legs", (await text(".ma-foot")).includes("ratio"));
await shot("matrix-selected");

/* ---------------- Options Chain ---------------- */
await nav("optionsChain");
const chainRows = await page.locator(".ma-chain tbody tr").count();
check("chain:15 strikes", chainRows === 15, `rows=${chainRows}`);
check("chain:ITM tint", (await page.locator("td.ma-chain-itm").count()) > 0);
check("chain:ATM row", (await page.locator("tr.ma-chain-atm").count()) === 1);
check("chain:expirations", (await page.locator(".ma-exp-select option").count()) === 4);
const alertsBefore = parseCount(await counts(), "alerts");
await page.locator("td.ma-chain-cell").nth(0).click();
await page.waitForTimeout(120);
const chainFoot = await text(".ma-foot");
check("chain:contract footer", chainFoot.includes("BID") && chainFoot.includes("ASK"), chainFoot);
await page.click('button:has-text("Alert at strike")');
await page.waitForTimeout(200);
check("chain:alert created", parseCount(await counts(), "alerts") === alertsBefore + 1, await counts());
// switch expiration reprices the chain
const beforeExp = await text(".ma-chain tbody tr:first-child");
await page.locator(".ma-exp-select").selectOption("2");
await page.waitForTimeout(200);
check("chain:expiration reprices", beforeExp !== (await text(".ma-chain tbody tr:first-child")));
check("chain:expiration selected", (await page.locator(".ma-exp-select").inputValue()) === "2");
await shot("chain-contract");

/* ---------------- Positions (last: flatten mutates the book) ---------------- */
await nav("positions");
const posExpected = parseCount(await counts(), "positions");
const posRows = await page.locator(".ma-pos-table tbody tr").count();
check("pos:rows match store", posRows === posExpected, `rows=${posRows} store=${posExpected}`);
const posTable = await page.locator(".ma-pos-table tbody").innerText();
check("pos:live pnl", /[+-]?\$[\d,]/.test(posTable), posTable.replace(/\n/g, " | "));
await page.click('.ma-toolbar .tv-seg button:has-text("TICKS")');
await page.waitForTimeout(120);
check("pos:ticks mode", (await page.locator(".ma-pos-table th").nth(3).innerText()).includes("TICKS"));
await shot("positions-ticks");
await page.click('.ma-toolbar .tv-seg button:has-text("$")');
await page.click('button:has-text("Flatten all")');
await page.waitForTimeout(250);
check("pos:flatten all", (await page.locator(".ma-pos-table tbody tr").count()) <= 1 && (await text(".ma-pos-table tbody")).includes("No open positions"));
await shot("positions-flattened");

/* ---------------- result ---------------- */
const ignored = /(Download the React DevTools|favicon)/i;
const realErrors = consoleErrors.filter((e) => !ignored.test(e));
check("console:no errors", realErrors.length === 0, realErrors.slice(0, 4).join(" || "));

await browser.close();

const payload = {
  passed: results.filter((r) => r.ok).length,
  failed: failures,
  total: results.length,
  failures,
};
fs.writeFileSync(path.join(here, "check-result.json"), JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
if (failures.length) process.exitCode = 1;
