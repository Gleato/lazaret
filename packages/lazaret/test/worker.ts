import { type CycleConfig, defineLazaret, LazaretLedger, LazaretReviewWorkflow } from "../src";
import { fakeOrigin, fakeReviewer, looksMalicious, verdict } from "./fakes";

// Short, small cycle so trigger behaviour is easy to exercise in tests.
export const TEST_CYCLE: CycleConfig = { intervalSec: 30, maxEntries: 3, riskSpikeThreshold: 0.8 };

// Drives the review protocol by hand in tests, so automatic dispatch is off.
export class Ledger extends LazaretLedger {
  protected override cycleConfig(): CycleConfig {
    return TEST_CYCLE;
  }
  protected override reviewWorkflowBinding(): string | null {
    return null;
  }
}

/** Seals dispatch the real Review Workflow below. */
export class AutoLedger extends LazaretLedger {
  protected override cycleConfig(): CycleConfig {
    return { ...TEST_CYCLE, maxEntries: 50 };
  }
}

const e2eConfig = defineLazaret({
  origin: "https://origin.test",
  routes: [],
  ledger: { binding: "AUTO_LEDGER" },
  cycle: TEST_CYCLE,
});

export class ReviewWorkflow extends LazaretReviewWorkflow {
  protected override lazaretConfig() {
    return e2eConfig;
  }
  protected override reviewer() {
    return fakeReviewer((e) => (looksMalicious(e.body) ? verdict("drop") : verdict("allow")))
      .reviewer;
  }
  protected override fetchOrigin() {
    return fakeOrigin(201).fetchOrigin;
  }
}

export default {
  fetch: () => new Response("lazaret test worker", { status: 404 }),
} satisfies ExportedHandler;
