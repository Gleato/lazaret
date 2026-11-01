import type { LiveFrame, PublicEntry } from "@gleator/lazaret/public";
import { describe, expect, it } from "vitest";
import {
  applyFrame,
  batchesNewestFirst,
  emptyView,
  MAX_BATCHES,
  trackIndex,
} from "../src/lib/ledger-view";

// The visualiser's fold over public Ledger frames (src/lib/ledger-view.ts).

const entry = (id: string, over: Partial<PublicEntry> = {}): PublicEntry => ({
  entryId: id,
  batchId: "batch-1",
  route: "POST /api/tickets",
  method: "POST",
  path: "/api/tickets",
  session: "aaaa1111",
  risk: 0.1,
  signals: [],
  resources: [`ticket:${id}`],
  body: "{}",
  bodyTruncated: false,
  ...over,
});

function play(frames: LiveFrame[]) {
  const view = emptyView();
  for (const f of frames) applyFrame(view, f);
  return view;
}

describe("ledger view", () => {
  it("follows a batch from open to settled and its entries to committed or dropped", () => {
    const v = play([
      { type: "HELLO", shard: "s", head: 0, previewChars: 280 },
      { seq: 1, at: 1, type: "BATCH_OPENED", batchId: "batch-1" },
      { seq: 2, at: 2, type: "ENTRY_APPENDED", entry: entry("good") },
      { seq: 3, at: 3, type: "ENTRY_APPENDED", entry: entry("bad", { risk: 0.9 }) },
      { seq: 4, at: 4, type: "BATCH_SEALED", batchId: "batch-1", reason: "risk" },
      { seq: 5, at: 5, type: "REVIEW_STARTED", batchId: "batch-1", attempt: 1 },
      {
        seq: 6,
        at: 6,
        type: "ENTRY_VERDICT",
        entryId: "good",
        verdict: { verdict: "allow", category: "benign", confidence: 0.95, rationale: "ok" },
      },
      {
        seq: 7,
        at: 7,
        type: "ENTRY_VERDICT",
        entryId: "bad",
        verdict: { verdict: "drop", category: "xss", confidence: 0.97, rationale: "script" },
      },
      { seq: 8, at: 8, type: "COMMIT_STARTED", batchId: "batch-1" },
      { seq: 9, at: 9, type: "ENTRY_COMMITTED", entryId: "good", originStatus: 201 },
      { seq: 10, at: 10, type: "BATCH_SETTLED", batchId: "batch-1" },
    ]);
    expect(v.batches.get("batch-1")).toMatchObject({ status: "SETTLED", sealReason: "risk" });
    expect(v.entries.get("good")).toMatchObject({ status: "COMMITTED", originStatus: 201 });
    expect(v.entries.get("bad")?.status).toBe("DROPPED");
    expect(v.head).toBe(10);
  });

  it("ignores duplicates after a reconnect", () => {
    const v = play([
      { seq: 1, at: 1, type: "BATCH_OPENED", batchId: "batch-1" },
      { seq: 2, at: 2, type: "ENTRY_APPENDED", entry: entry("a") },
    ]);
    expect(applyFrame(v, { seq: 2, at: 2, type: "ENTRY_APPENDED", entry: entry("a") })).toBe(false);
    expect(v.batches.get("batch-1")?.entryIds).toEqual(["a"]);
  });

  it("draws taint back to the dropped parent", () => {
    const v = play([
      { seq: 1, at: 1, type: "BATCH_OPENED", batchId: "batch-1" },
      {
        seq: 2,
        at: 2,
        type: "ENTRY_APPENDED",
        entry: entry("ticket", { resources: ["ticket:t1"] }),
      },
      {
        seq: 3,
        at: 3,
        type: "ENTRY_APPENDED",
        entry: entry("reply", { resources: ["ticket:t1"] }),
      },
      {
        seq: 4,
        at: 4,
        type: "ENTRY_VERDICT",
        entryId: "ticket",
        verdict: { verdict: "drop", category: "xss", confidence: 0.9, rationale: "x" },
      },
      {
        seq: 5,
        at: 5,
        type: "ENTRY_VERDICT",
        entryId: "reply",
        verdict: { verdict: "drop", category: "tainted", confidence: 1, rationale: "parent" },
      },
    ]);
    expect(v.entries.get("reply")?.taintedBy).toBe("ticket");
  });

  it("holds a quarantined batch's pending entries, and lets a human release one", () => {
    const v = play([
      { seq: 1, at: 1, type: "BATCH_OPENED", batchId: "batch-1" },
      { seq: 2, at: 2, type: "ENTRY_APPENDED", entry: entry("a") },
      { seq: 3, at: 3, type: "BATCH_QUARANTINED", batchId: "batch-1", reason: "malformed" },
    ]);
    expect(v.entries.get("a")?.status).toBe("QUARANTINED");
    expect(trackIndex("QUARANTINED")).toBe(2);
    applyFrame(v, { seq: 4, at: 4, type: "ENTRY_RESOLVED", entryId: "a", decision: "release" });
    expect(v.entries.get("a")).toMatchObject({ status: "APPROVED", resolution: "release" });
  });

  it("starts over on RESET and keeps only recent batches", () => {
    const frames: LiveFrame[] = [];
    for (let i = 1; i <= MAX_BATCHES + 3; i++) {
      frames.push({ seq: i, at: i, type: "BATCH_OPENED", batchId: `batch-${i}` });
    }
    const v = play(frames);
    expect(v.batches.size).toBe(MAX_BATCHES);
    expect(batchesNewestFirst(v)[0]?.id).toBe(`batch-${MAX_BATCHES + 3}`);
    applyFrame(v, { type: "RESET" });
    expect(v.batches.size).toBe(0);
    expect(v.head).toBe(0);
  });
  it("loads a SNAPSHOT in place of compacted events, then continues live after its seq", () => {
    const verdict = (v: "allow" | "drop", category: string) => ({
      verdict: v,
      category,
      confidence: 0.9,
      rationale: "r",
    });
    const v = play([
      { type: "HELLO", shard: "s", head: 900, previewChars: 280 },
      // Stale state from before the reconnect is replaced, not merged.
      { seq: 1, at: 1, type: "BATCH_OPENED", batchId: "batch-old" },
      {
        type: "SNAPSHOT",
        seq: 900,
        batches: [
          {
            batchId: "batch-7",
            status: "SETTLED",
            sealReason: "size",
            attempt: 1,
            openedAt: 10,
            updatedAt: 20,
            note: null,
          },
          {
            batchId: "batch-8",
            status: "OPEN",
            sealReason: null,
            attempt: 0,
            openedAt: 30,
            updatedAt: 30,
            note: null,
          },
        ],
        entries: [
          {
            ...entry("parent", { batchId: "batch-7", resources: ["ticket:9"] }),
            status: "DROPPED",
            verdict: verdict("drop", "xss"),
            at: 11,
            originStatus: null,
            resolution: null,
          },
          {
            ...entry("child", { batchId: "batch-7", resources: ["ticket:9"] }),
            status: "DROPPED",
            verdict: verdict("drop", "tainted"),
            at: 12,
            originStatus: null,
            resolution: null,
          },
        ],
        flaggedSessions: ["aaaa1111"],
      },
      // Already covered by the snapshot: skipped.
      { seq: 900, at: 31, type: "BATCH_SEALED", batchId: "batch-8", reason: "timer" },
      { seq: 901, at: 32, type: "ENTRY_APPENDED", entry: entry("live", { batchId: "batch-8" }) },
    ]);
    expect([...v.batches.keys()]).toEqual(["batch-7", "batch-8"]);
    expect(v.batches.get("batch-8")?.status).toBe("OPEN");
    expect(v.batches.get("batch-8")?.entryIds).toEqual(["live"]);
    expect(v.entries.get("child")?.taintedBy).toBe("parent");
    expect(v.flaggedSessions.has("aaaa1111")).toBe(true);
    expect(v.head).toBe(901);
  });
});
