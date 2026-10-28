import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// One workerd holds the whole stack: the Tidewater gateway, Ledger, Memory and the
// real Review Workflow, plus the real Tidewater origin Worker on a local D1 that is
// migrated from the origin's own migrations. Only the reviewer is scripted.
const migrations = await readD1Migrations("../demo-origin/migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
