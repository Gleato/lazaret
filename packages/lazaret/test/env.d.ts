declare namespace Cloudflare {
  interface Env {
    LEDGER: DurableObjectNamespace<import("./worker").Ledger>;
    AUTO_LEDGER: DurableObjectNamespace<import("./worker").AutoLedger>;
    LAZARET_REVIEW: Workflow<import("../src").ReviewDispatch>;
    LAZARET_SIGNING_SECRET: string;
  }
}
