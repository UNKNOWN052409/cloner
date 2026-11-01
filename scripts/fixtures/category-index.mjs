// Aggregates the three Phase-3.5 category fixture sites (task 3.5.1) for
// scripts/test-website-coverage.mjs. Kept as a separate index file so the
// Phase-1 `scripts/fixtures/index.mjs` sites list (consumed by
// test-exploration-fixtures.mjs) is untouched — additive only.
//
// Each site is a plain { name, category, entry, handle } object; the extra
// `category` field is metadata for the coverage runner, not an engine input —
// the engine itself never sees it (no target-specific code paths).
import { ecommerceCategorySite } from "./category-ecommerce.mjs";
import { docsCategorySite } from "./category-docs.mjs";
import { portalCategorySite } from "./category-portal.mjs";

export { ecommerceCategorySite, docsCategorySite, portalCategorySite };

export const categorySites = [ecommerceCategorySite, docsCategorySite, portalCategorySite];
