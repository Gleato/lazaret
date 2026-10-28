import { describe, expect, it } from "vitest";
import { applyEvent, IllegalTransition, type LedgerEvent, type LedgerState, replay } from "../src";
import { allow, drop, entry } from "./fixtures";

// Pure state-machine tests: no Durable Object, just events in → state out.

const opened: LedgerEvent = { type: "BATCH_OPENED", batchId: "batch-1", at: 1 };
const appended = (entryId: string): LedgerEvent => ({
  type: "ENTRY_APPENDED",
  entryId,
  batchId: "batch-1",
  entry: entry(),
  at: 2,
});
const sealed: LedgerEvent = { type: "BATCH_SEALED", batchId: "batch-1", reason: "size", at: 3 };
const reviewing: LedgerEvent = { type: "REVIEW_STARTED", batchId: "batch-1", attempt: 1, at: 4 };

/** A full, legal lifecycle: e1 allowed + committed, e2 dropped. */
const lifecycle: LedgerEvent[] = [
  opened,
  appended("e1"),
  appended("e2"),
  sealed,
  reviewing,
  { type: "REVIEW_FAILED", batchId: "batch-1", attempt: 1, error: "model timeout", at: 5 },
  { type: "REVIEW_STARTED", batchId: "batch-1", attempt: 2, at: 6 },
  { type: "ENTRY_VERDICT", entryId: "e1", verdict: allow, at: 7 },
  { type: "ENTRY_VERDICT", entryId: "e2", verdict: drop, at: 7 },
  { type: "COMMIT_STARTED", batchId: "batch-1", at: 8 },
  { type: "ENTRY_COMMITTED", entryId: "e1", at: 9 },
  { type: "BATCH_SETTLED", batchId: "batch-1", at: 10 },
];

function stateAfter(events: LedgerEvent[]): LedgerState {
  return replay(events);
}

describe("ledger state machine", () => {
  it("walks a batch through review retry, verdicts, commit and settle", () => {
    const state = stateAfter(lifecycle);
    expect(state.seq).toBe(lifecycle.length);
    expect(state.openBatchId).toBeNull();
    expect(state.batches["batch-1"]).toMatchObject({
      status: "SETTLED",
      reviewAttempts: 2,
      lastError: "model timeout",
      sealReason: "size",
      settledAt: 10,
    });
    expect(state.entries.e1?.status).toBe("COMMITTED");
    expect(state.entries.e2).toMatchObject({ status: "DROPPED", verdict: drop });
  });

  it("is deterministic: replaying the same log gives an identical state", () => {
    const incremental = replay([]);
    for (const event of lifecycle) applyEvent(incremental, event);
    expect(replay(lifecycle)).toEqual(incremental);
  });

  it("quarantine holds pending entries and fails the batch closed", () => {
    const state = stateAfter([
      opened,
      appended("e1"),
      sealed,
      reviewing,
      { type: "BATCH_QUARANTINED", batchId: "batch-1", reason: "reviewer output malformed", at: 5 },
    ]);
    expect(state.batches["batch-1"]?.status).toBe("QUARANTINED");
    expect(state.entries.e1?.status).toBe("QUARANTINED");
  });

  it("lets a human release a held entry after its batch is done, and commit it alone", () => {
    const held: LedgerEvent[] = [
      opened,
      appended("e1"),
      sealed,
      reviewing,
      { type: "BATCH_QUARANTINED", batchId: "batch-1", reason: "reviewer output malformed", at: 5 },
    ];
    const resolve: LedgerEvent = {
      type: "ENTRY_RESOLVED",
      entryId: "e1",
      decision: "release",
      operator: "ridge",
      note: "",
      at: 6,
    };
    const state = stateAfter([...held, resolve, { type: "ENTRY_COMMITTED", entryId: "e1", at: 7 }]);
    expect(state.entries.e1).toMatchObject({
      status: "COMMITTED",
      resolution: { decision: "release", operator: "ridge" },
    });
    // Not while the batch is still under review: a human never races the pipeline.
    const midReview = stateAfter([opened, appended("e1"), sealed, reviewing]);
    expect(() => applyEvent(midReview, resolve)).toThrow(IllegalTransition);
    // And a committed write can't be "released" or "dropped"; it can only be reported.
    const done = stateAfter(lifecycle);
    expect(() => applyEvent(done, { ...resolve, decision: "drop" })).toThrow(/not held/);
  });

  // Each case: a legal prefix, then an event that must be rejected.
  const illegal: [string, LedgerEvent[], LedgerEvent, RegExp][] = [
    [
      "opening a second batch while one is open",
      [opened],
      { ...opened, batchId: "batch-2" },
      /still open/,
    ],
    [
      "opening a batch with a non-sequential id",
      [],
      { ...opened, batchId: "batch-7" },
      /expected id batch-1/,
    ],
    ["appending to a sealed batch", [opened, appended("e1"), sealed], appended("e2"), /is SEALED/],
    ["appending a duplicate entry id", [opened, appended("e1")], appended("e1"), /already exists/],
    ["sealing an empty batch", [opened], sealed, /is empty/],
    [
      "skipping a review attempt number",
      [opened, appended("e1"), sealed],
      { ...reviewing, attempt: 2 },
      /expected attempt 1/,
    ],
    [
      "recording a verdict before review starts",
      [opened, appended("e1"), sealed],
      { type: "ENTRY_VERDICT", entryId: "e1", verdict: allow, at: 5 },
      /is SEALED/,
    ],
    [
      "committing before every entry has a verdict",
      [opened, appended("e1"), sealed, reviewing],
      { type: "COMMIT_STARTED", batchId: "batch-1", at: 5 },
      /lack a verdict/,
    ],
    [
      "committing a dropped entry",
      lifecycle.slice(0, 10),
      { type: "ENTRY_COMMITTED", entryId: "e2", at: 9 },
      /e2 is DROPPED/,
    ],
    [
      "committing the same entry twice",
      lifecycle.slice(0, 11),
      { type: "ENTRY_COMMITTED", entryId: "e1", at: 9 },
      /e1 is COMMITTED/,
    ],
    [
      "settling with approved entries uncommitted",
      lifecycle.slice(0, 10),
      { type: "BATCH_SETTLED", batchId: "batch-1", at: 9 },
      /not committed/,
    ],
    [
      "quarantining a settled batch",
      lifecycle,
      { type: "BATCH_QUARANTINED", batchId: "batch-1", reason: "x", at: 11 },
      /is SETTLED/,
    ],
    ["touching an unknown batch", [], reviewing, /unknown batch/],
  ];

  it.each(illegal)("rejects %s without changing state", (_name, prefix, event, message) => {
    const state = stateAfter(prefix);
    const before = structuredClone(state);
    expect(() => applyEvent(state, event)).toThrow(IllegalTransition);
    expect(() => applyEvent(state, event)).toThrow(message);
    expect(state).toEqual(before);
  });
});
