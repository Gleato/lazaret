declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    LAZARET_LEDGER: DurableObjectNamespace<import("./worker").TestLedger>;
    LAZARET_MEMORY: DurableObjectNamespace<import("../src").TidewaterMemory>;
    LAZARET_REVIEW: Workflow<import("@gleator/lazaret").ReviewDispatch>;
    LAZARET_SIGNING_SECRET: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
