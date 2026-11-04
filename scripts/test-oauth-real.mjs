#!/usr/bin/env node
// SUPERSEDED (task 4.5.1 google-only-oauth).
//
// This suite covered the earlier dual-provider (GitHub + Google) OAuth build.
// The owner directive for 4.5.1 removed GitHub OAuth from every product path:
// the /api/auth/oauth/github/* routes now answer 410 Gone, the provider
// catalog in src/platform/oauth-real.js is google-only, and migration
// 043-oauth-google-only.sql unlinked any github account rows. Testing the
// removed GitHub sign-in flow here would be testing deleted behavior, so the
// body of this file was replaced by a pointer to the Google-only suite.
//
// Run the real suite:  node scripts/test-oauth-google-only.mjs
console.log("SKIP  test-oauth-real.mjs is superseded — OAuth is GOOGLE-ONLY (task 4.5.1).");
console.log("SKIP  Run the Google-only suite instead: node scripts/test-oauth-google-only.mjs");
process.exit(0);
