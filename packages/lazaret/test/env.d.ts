declare namespace Cloudflare {
  interface Env {
    LEDGER: DurableObjectNamespace<import("./worker").Ledger>;
  }
}
