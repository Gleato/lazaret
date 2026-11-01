declare namespace Cloudflare {
  interface Env {
    LEDGER: DurableObjectNamespace<import("./worker").Ledger>;
    AUTO_LEDGER: DurableObjectNamespace<import("./worker").AutoLedger>;
    MEMORY: DurableObjectNamespace<import("./worker").Memory>;
    COMPACT_LEDGER: DurableObjectNamespace<import("./worker").CompactLedger>;
    LAZARET_BEHAVIOUR: DurableObjectNamespace<import("./worker").Behaviour>;
    LAZARET_REVIEW: Workflow<import("../src").ReviewDispatch>;
    LAZARET_SIGNING_SECRET: string;
  }
}
