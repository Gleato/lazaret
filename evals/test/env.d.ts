declare namespace Cloudflare {
  interface Env {
    EVAL_LEDGER: DurableObjectNamespace<import("../src/worker").EvalLedger>;
    EVAL_MEMORY: DurableObjectNamespace<import("../src/worker").EvalMemory>;
    EVAL_CORPUS: import("../src/types").EvalCase[];
    EVAL_LIVE?: string;
    /** Set for a subset run (vitest.config.ts): the full-corpus regression tests skip. */
    EVAL_ONLY?: string;
    EVAL_MAX_USD?: string;
    ANTHROPIC_API_KEY?: string;
  }
}
