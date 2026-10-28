declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    LAZARET_SIGNING_SECRET: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
