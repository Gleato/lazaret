import {
  type CycleConfig,
  DEFAULT_MEMORY_THRESHOLDS,
  LazaretLedger,
  LazaretMemory,
  type MemoryThresholds,
} from "@gleator/lazaret";
import { config } from "@gleator/tidewater-lazaret/config";

/** Tidewater's Ledger with automatic dispatch off: the eval drives review itself. */
export class EvalLedger extends LazaretLedger {
  protected override cycleConfig(): CycleConfig {
    return config.cycle;
  }
  protected override reviewWorkflowBinding(): string | null {
    return null;
  }
}

/**
 * Memory thresholds for the two-phase Memory eval (src/memory-eval.ts). An eval choice,
 * not a recommendation: production uses DEFAULT_MEMORY_THRESHOLDS (20 clean samples,
 * 3 live hits to flag, 10 to block), sized for thousands of writes a day. The training
 * split is ~72 cases, with 2-5 per attack class, so at those numbers nothing could ever
 * promote and the eval would only ever say "nothing learned". These keep every safety
 * property and shrink only the evidence counts:
 *   - minSupport 2: unchanged; a rule must explain two different drops.
 *   - minCleanSamples 10: the training split archives ~25 allowed writes, so a rule is
 *     still backtested against real clean traffic, just less of it.
 *   - promote at 1 / 2 confirmed live hits (vs 3 / 10), still with zero false positives:
 *     any hit on a write the reviewer allowed retires the rule, as in production.
 * The test worker (packages/lazaret/test/worker.ts) uses 2 / 3 / 2 / 4 for the same reason.
 */
export const EVAL_MEMORY_THRESHOLDS: MemoryThresholds = {
  ...DEFAULT_MEMORY_THRESHOLDS,
  minSupport: 2,
  minCleanSamples: 10,
  promoteToFlagAfter: 1,
  promoteToBlockAfter: 2,
};

export class EvalMemory extends LazaretMemory {
  protected override thresholds(): MemoryThresholds {
    return EVAL_MEMORY_THRESHOLDS;
  }
}

export default {
  fetch: () => new Response("lazaret evals", { status: 404 }),
} satisfies ExportedHandler;
