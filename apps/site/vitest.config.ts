import { defineConfig } from "vitest/config";

// The site's pure logic (the ledger view reducer, formatting) runs in plain Node.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
