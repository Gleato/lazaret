import { type CycleConfig, LazaretLedger } from "@gleator/lazaret";
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

export default {
  fetch: () => new Response("lazaret evals", { status: 404 }),
} satisfies ExportedHandler;
