// Aggregates the four exploration fixture sites for the test runner.
import { multiRouteSite } from "./multi-route.mjs";
import { spaHashSite } from "./spa-hash.mjs";
import { widgetsSite } from "./widgets.mjs";
import { lazyScrollSite } from "./lazy-scroll.mjs";

export { multiRouteSite, spaHashSite, widgetsSite, lazyScrollSite };

export const sites = [multiRouteSite, spaHashSite, widgetsSite, lazyScrollSite];
