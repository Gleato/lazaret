import { applyD1Migrations, env } from "cloudflare:test";

// Runs before each test file. Already-applied migrations are skipped.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
