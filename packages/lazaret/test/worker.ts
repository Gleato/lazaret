import { type CycleConfig, LazaretLedger } from "../src";

// Short, small cycle so trigger behaviour is easy to exercise in tests.
export const TEST_CYCLE: CycleConfig = { intervalSec: 30, maxEntries: 3, riskSpikeThreshold: 0.8 };

export class Ledger extends LazaretLedger {
  protected override cycleConfig(): CycleConfig {
    return TEST_CYCLE;
  }
}

export default {
  fetch: () => new Response("lazaret test worker", { status: 404 }),
} satisfies ExportedHandler;
