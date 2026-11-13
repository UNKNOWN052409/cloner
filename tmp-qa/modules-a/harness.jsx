// Harness (QA only, outside the deliverable project) — mounts each modules-a
// component inside the real shell chrome + TradingProvider so Playwright can
// verify rendering and interactions against the live simulated store.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TradingProvider, useTrading, moduleTitle } from "../../artifacts/tradovate-frontend-clone/src/state/store.jsx";
import MarketAnalyzerModule from "../../artifacts/tradovate-frontend-clone/src/modules/MarketAnalyzer.jsx";
import StocksHotListModule from "../../artifacts/tradovate-frontend-clone/src/modules/StocksHotList.jsx";
import OrdersModule from "../../artifacts/tradovate-frontend-clone/src/modules/Orders.jsx";
import PositionsModule from "../../artifacts/tradovate-frontend-clone/src/modules/Positions.jsx";
import OrderTicketModule from "../../artifacts/tradovate-frontend-clone/src/modules/OrderTicket.jsx";
import TimeSalesModule from "../../artifacts/tradovate-frontend-clone/src/modules/TimeSales.jsx";
import TradePerformanceModule from "../../artifacts/tradovate-frontend-clone/src/modules/TradePerformance.jsx";
import PulseModule from "../../artifacts/tradovate-frontend-clone/src/modules/Pulse.jsx";
import SpreadMatrixModule from "../../artifacts/tradovate-frontend-clone/src/modules/SpreadMatrix.jsx";
import OptionsChainModule from "../../artifacts/tradovate-frontend-clone/src/modules/OptionsChain.jsx";

const COMPONENTS = {
  marketAnalyzer: MarketAnalyzerModule,
  stocksHotList: StocksHotListModule,
  orders: OrdersModule,
  positions: PositionsModule,
  orderTicket: OrderTicketModule,
  timeSales: TimeSalesModule,
  tradePerformance: TradePerformanceModule,
  pulse: PulseModule,
  spreadMatrix: SpreadMatrixModule,
  optionsChain: OptionsChainModule,
};

const TYPES = Object.keys(COMPONENTS);

function Toasts() {
  const { toasts } = useTrading();
  return (
    <div className="harness-toasts">
      {toasts.map((t) => (
        <div className="harness-toast" key={t.id}>
          <b>{t.title}</b>
          <span>{t.body}</span>
        </div>
      ))}
    </div>
  );
}

function Harness() {
  const { placeOrder, orders, fills, positions, account, quotes, alerts } = useTrading();
  const [active, setActive] = useState("marketAnalyzer");
  const [symbol, setSymbol] = useState("MNQZ6");
  const [width, setWidth] = useState(1000);
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const timer = setTimeout(() => {
      placeOrder({ symbol: "MNQZ6", side: "Buy", qty: 2, orderType: "MARKET" });
      placeOrder({ symbol: "MGCZ6", side: "Buy", qty: 1, orderType: "MARKET" });
      placeOrder({ symbol: "ESM6", side: "Sell", qty: 1, orderType: "LIMIT", price: 6450.25 });
    }, 300);
    return () => clearTimeout(timer);
  }, [placeOrder]);

  const Comp = COMPONENTS[active];
  const module = { id: `harness-${active}`, type: active, props: { symbol, timeframe: "5m" } };

  const spawnOrders = () => {
    placeOrder({ symbol: "MNQZ6", side: "Buy", qty: 1, orderType: "MARKET" });
    placeOrder({ symbol: "CLN6", side: "Sell", qty: 2, orderType: "LIMIT", price: 63.5 });
  };

  return (
    <div className="harness">
      <aside className="harness-nav">
        <div className="harness-brand">modules-a harness</div>
        {TYPES.map((t) => (
          <button
            type="button"
            key={t}
            className={`harness-nav-btn ${active === t ? "is-active" : ""}`}
            onClick={() => setActive(t)}
            data-module={t}
          >
            {moduleTitle({ type: t })}
          </button>
        ))}
        <div className="harness-controls">
          <label>
            Symbol
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)} data-harness="symbol">
              {Object.keys(quotes).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>
            Width
            <select value={width} onChange={(e) => setWidth(Number(e.target.value))} data-harness="width">
              <option value={1000}>Wide 1000</option>
              <option value={620}>Narrow 620</option>
              <option value={460}>Tight 460</option>
            </select>
          </label>
          <button type="button" className="harness-btn" onClick={spawnOrders} data-harness="spawn-orders">
            Spawn 2 working orders
          </button>
          <div className="harness-counts" data-harness="counts">
            orders={orders.length} fills={fills.length} positions={positions.length} alerts={alerts.length} equity=${account.netLiq}
          </div>
        </div>
      </aside>

      <main className="harness-stage">
        <div className="tv-module harness-module" style={{ width }}>
          <header className="tv-module-header">
            <div className="tv-module-tabs">
              <button type="button" className="tv-module-tab is-active">
                <span className="tv-tab-dot" />
                <span>{moduleTitle(module)}</span>
              </button>
              <button type="button" className="tv-icon-btn" title="Add tab">＋</button>
            </div>
            <div className="tv-module-actions">
              <button type="button" className="tv-icon-btn" title="Search">⌕</button>
              <button type="button" className="tv-icon-btn" title="Settings">⚙</button>
            </div>
          </header>
          <div className="tv-module-body">
            <Comp module={module} />
          </div>
        </div>
      </main>
      <Toasts />
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <TradingProvider>
    <Harness />
  </TradingProvider>,
);
