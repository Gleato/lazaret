declare namespace Cloudflare {
  interface Env {
    EVAL_LEDGER: DurableObjectNamespace<import("../src/worker").EvalLedger>;
    EVAL_CORPUS: import("../src/types").EvalCase[];
    EVAL_LIVE?: string;
    EVAL_MAX_USD?: string;
    ANTHROPIC_API_KEY?: string;
  }
}
