import { defineConfig } from "@playwright/test";
import { DEMO_ORIGIN } from "./lib/env";

// The production E2E suite (M8). It fires the console's canned exhibits at the real,
// deployed demo with live models and checks the origin's D1 directly: attacks never
// reach it, honest writes do. Each run costs about $0.10–0.15 of model calls and
// counts against the runner's per-IP share ($0.25/day), so it is run by hand
// (`npm run e2e:prod`), never in `npm test`.
export default defineConfig({
  testDir: "./tests",
  // One review cycle is 30 s; a write can wait for the next one plus review.
  timeout: 240_000,
  expect: { timeout: 10_000 },
  // One client, in order: the exhibits share one IP's rate limits, and the
  // credential-stuffing burst must come last (it locks this IP's logins for a while).
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: DEMO_ORIGIN, trace: "retain-on-failure" },
});
