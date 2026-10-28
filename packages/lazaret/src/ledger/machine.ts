import type { LedgerEvent } from "./events";
import type { BatchState, BatchStatus, EntryState, EntryStatus, LedgerState } from "./types";

// Pure state machine for the Ledger. No I/O, no clock, no randomness: given the same
// events it always produces the same state, which is what makes crash recovery by
// replay trustworthy (principle 3). The Durable Object is a thin shell around this.
//
// `applyEvent` checks every guard *before* mutating anything, so a rejected event
// leaves the state untouched. Mutation (rather than returning copies) keeps replay of
// long logs cheap.

export class IllegalTransition extends Error {
  constructor(
    readonly event: LedgerEvent,
    reason: string,
  ) {
    super(`Illegal ${event.type}: ${reason}`);
    this.name = "IllegalTransition";
  }
}

export function initialState(): LedgerState {
  return { seq: 0, openBatchId: null, nextBatchNumber: 1, batches: {}, entries: {} };
}

/** Batch ids are sequential so they're readable in logs and stable under replay. */
export function nextBatchId(state: LedgerState): string {
  return `batch-${state.nextBatchNumber}`;
}

export function replay(events: Iterable<LedgerEvent>): LedgerState {
  const state = initialState();
  for (const event of events) applyEvent(state, event);
  return state;
}

const verdictToStatus = {
  allow: "APPROVED",
  drop: "DROPPED",
  quarantine: "QUARANTINED",
} as const satisfies Record<string, EntryStatus>;

export function applyEvent(state: LedgerState, event: LedgerEvent): void {
  const fail = (reason: string): never => {
    throw new IllegalTransition(event, reason);
  };
  const batchIn = (batchId: string, allowed: BatchStatus[]): BatchState => {
    const batch = state.batches[batchId] ?? fail(`unknown batch ${batchId}`);
    if (!allowed.includes(batch.status)) {
      fail(`batch ${batchId} is ${batch.status}, expected ${allowed.join(" | ")}`);
    }
    return batch;
  };
  const entryOf = (entryId: string): EntryState =>
    state.entries[entryId] ?? fail(`unknown entry ${entryId}`);
  const entriesOf = (batch: BatchState): EntryState[] => batch.entryIds.map(entryOf);

  switch (event.type) {
    case "BATCH_OPENED": {
      if (state.openBatchId !== null) fail(`batch ${state.openBatchId} is still open`);
      if (event.batchId !== nextBatchId(state)) {
        fail(`expected id ${nextBatchId(state)}, got ${event.batchId}`);
      }
      state.batches[event.batchId] = {
        id: event.batchId,
        status: "OPEN",
        openedAt: event.at,
        entryIds: [],
        reviewAttempts: 0,
      };
      state.openBatchId = event.batchId;
      state.nextBatchNumber += 1;
      break;
    }

    case "ENTRY_APPENDED": {
      const batch = batchIn(event.batchId, ["OPEN"]);
      if (state.entries[event.entryId]) fail(`entry ${event.entryId} already exists`);
      state.entries[event.entryId] = {
        ...event.entry,
        id: event.entryId,
        batchId: batch.id,
        status: "PENDING",
        receivedAt: event.at,
      };
      batch.entryIds.push(event.entryId);
      break;
    }

    case "BATCH_SEALED": {
      const batch = batchIn(event.batchId, ["OPEN"]);
      // An empty batch has nothing to review; sealing it would waste a model call.
      if (batch.entryIds.length === 0) fail(`batch ${batch.id} is empty`);
      batch.status = "SEALED";
      batch.sealedAt = event.at;
      batch.sealReason = event.reason;
      state.openBatchId = null;
      break;
    }

    case "REVIEW_STARTED": {
      const batch = batchIn(event.batchId, ["SEALED", "REVIEW_FAILED"]);
      // Attempt numbers must be contiguous so retries are countable and a stale
      // worker replaying an old "start" can't silently restart a review.
      if (event.attempt !== batch.reviewAttempts + 1) {
        fail(`expected attempt ${batch.reviewAttempts + 1}, got ${event.attempt}`);
      }
      batch.status = "REVIEWING";
      batch.reviewAttempts = event.attempt;
      break;
    }

    case "REVIEW_FAILED": {
      const batch = batchIn(event.batchId, ["REVIEWING"]);
      if (event.attempt !== batch.reviewAttempts) {
        fail(`attempt ${event.attempt} is not the current attempt ${batch.reviewAttempts}`);
      }
      batch.status = "REVIEW_FAILED";
      batch.lastError = event.error;
      break;
    }

    case "ENTRY_VERDICT": {
      const entry = entryOf(event.entryId);
      batchIn(entry.batchId, ["REVIEWING"]);
      if (entry.status !== "PENDING") fail(`entry ${entry.id} is ${entry.status}`);
      entry.status = verdictToStatus[event.verdict.verdict];
      entry.verdict = event.verdict;
      break;
    }

    case "COMMIT_STARTED": {
      const batch = batchIn(event.batchId, ["REVIEWING"]);
      const pending = entriesOf(batch).filter((e) => e.status === "PENDING");
      if (pending.length > 0) fail(`${pending.length} entries still lack a verdict`);
      batch.status = "COMMITTING";
      break;
    }

    case "ENTRY_COMMITTED": {
      const entry = entryOf(event.entryId);
      batchIn(entry.batchId, ["COMMITTING"]);
      // Rejecting a second commit is what makes double-commits detectable; the
      // Durable Object turns this into an idempotent no-op before it gets here.
      if (entry.status !== "APPROVED") fail(`entry ${entry.id} is ${entry.status}`);
      entry.status = "COMMITTED";
      break;
    }

    case "BATCH_SETTLED": {
      const batch = batchIn(event.batchId, ["COMMITTING"]);
      const uncommitted = entriesOf(batch).filter((e) => e.status === "APPROVED");
      if (uncommitted.length > 0) fail(`${uncommitted.length} approved entries not committed`);
      batch.status = "SETTLED";
      batch.settledAt = event.at;
      break;
    }

    case "BATCH_QUARANTINED": {
      const batch = batchIn(event.batchId, ["SEALED", "REVIEWING", "REVIEW_FAILED"]);
      batch.status = "QUARANTINED";
      batch.quarantineReason = event.reason;
      for (const entry of entriesOf(batch)) {
        if (entry.status === "PENDING" || entry.status === "APPROVED") entry.status = "QUARANTINED";
      }
      break;
    }

    default: {
      const unreachable: never = event;
      throw new Error(`Unknown event ${JSON.stringify(unreachable)}`);
    }
  }

  state.seq += 1;
}
