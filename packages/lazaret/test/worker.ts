import {
  type CompactionConfig,
  type CycleConfig,
  DEFAULT_MEMORY_THRESHOLDS,
  defineLazaret,
  LazaretBehaviour,
  LazaretLedger,
  LazaretMemory,
  LazaretReviewWorkflow,
  type MemoryThresholds,
} from "../src";
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

// Compacts after a few events and prunes batches settled a minute ago (M8), with a
// clock tests can move, so retention is testable without waiting.
export const TEST_COMPACTION: CompactionConfig = {
  minEvents: 20,
  keepEvents: 5,
  retainSettledMs: 60_000,
};

export class CompactLedger extends Ledger {
  #offset = 0;
  protected override compactionConfig(): CompactionConfig {
    return TEST_COMPACTION;
  }
  protected override now(): number {
    return Date.now() + this.#offset;
  }
  advanceClock(ms: number): void {
    this.#offset += ms;
  }
}

/** Behaviour samples per key (M8), for the durable behaviour store tests. */
export class Behaviour extends LazaretBehaviour {}

/** Seals dispatch the real Review Workflow below. */
export class AutoLedger extends LazaretLedger {
  protected override cycleConfig(): CycleConfig {
    return { ...TEST_CYCLE, maxEntries: 50 };
  }
}

// Small thresholds so the full learning loop fits in a test.
export const TEST_MEMORY_THRESHOLDS: MemoryThresholds = {
  ...DEFAULT_MEMORY_THRESHOLDS,
  minSupport: 2,
  minCleanSamples: 3,
  promoteToFlagAfter: 2,
  promoteToBlockAfter: 4,
};

export class Memory extends LazaretMemory {
  #offset = 0;
  protected override thresholds(): MemoryThresholds {
    return TEST_MEMORY_THRESHOLDS;
  }
  protected override now(): number {
    return Date.now() + this.#offset;
  }
  /** Moves this instance's clock forward, for the time-based rules (trust, expiry). */
  advanceClock(ms: number): void {
    this.#offset += ms;
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
