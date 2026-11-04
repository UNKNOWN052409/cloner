// Fixture consumer: wires the exports that MUST count as wired.
import { chargeCard, getBalance } from "./billing-stub.js";
import { wiredHelper } from "./hooks.js";
import router from "./routes.js";

function runApp() {
  chargeCard(1);
  getBalance();
  wiredHelper();
  return router;
}

runApp();
