import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { allow, drop, entry, rejectionOf } from "./fixtures";
import { TEST_CYCLE } from "./worker";

// Integration tests against a real Durable Object in workerd: real SQLite, real
// alarms, real eviction. Each test gets its own object via a unique name.

let counter = 0;
function ledger() {
  return env.LEDGER.get(env.LEDGER.idFromName(`ledger-${++counter}`));
}

describe("Ledger Durable Object", () => {
  it("opens a batch on first write and schedules the timer at its deadline", async () => {
    const stub = ledger();
    const { batchId, sealed } = await stub.append(entry());
    expect(batchId).toBe("batch-1");
    expect(sealed).toBeNull();

    const state = await stub.getState();
    const alarm = await runInDurableObject(stub, (_i, ctx) => ctx.storage.getAlarm());
    expect(alarm).toBe((state.batches["batch-1"]?.openedAt ?? 0) + TEST_CYCLE.intervalSec * 1000);
  });

  it("seals on size, clears the alarm, and keeps accepting writes in a new batch", async () => {
    const stub = ledger();
    await stub.append(entry());
    await stub.append(entry());
    const third = await stub.append(entry());
    expect(third.sealed).toBe("size");
    expect(await runInDurableObject(stub, (_i, ctx) => ctx.storage.getAlarm())).toBeNull();

    // Writes never block on review: the next one lands in batch-2.
    const fourth = await stub.append(entry());
    expect(fourth.batchId).toBe("batch-2");
    const state = await stub.getState();
    expect(state.batches["batch-1"]?.status).toBe("SEALED");
    expect(state.openBatchId).toBe("batch-2");
  });

  it("seals immediately on a risk spike, in the same transaction as the append", async () => {
    const stub = ledger();
    const { sealed } = await stub.append(entry({ riskScore: 0.93 }));
    expect(sealed).toBe("risk");
    const types = (await stub.getEvents()).map((e) => e.event.type);
    expect(types).toEqual(["BATCH_OPENED", "ENTRY_APPENDED", "BATCH_SEALED"]);
  });

  it("seals on the timer when the alarm fires", async () => {
    const stub = ledger();
    await stub.append(entry());
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const state = await stub.getState();
    expect(state.batches["batch-1"]).toMatchObject({ status: "SEALED", sealReason: "timer" });
    expect(state.openBatchId).toBeNull();
  });

  it("runs the full review → commit → settle protocol", async () => {
    const stub = ledger();
    const a = await stub.append(entry());
    const b = await stub.append(entry({ sessionId: "attacker" }));
    const batchId = (await stub.seal()) ?? "";

    expect(await stub.startReview(batchId)).toBe(1);
    await stub.recordVerdicts(batchId, { [a.entryId]: allow, [b.entryId]: drop });
    await stub.startCommit(batchId);
    await stub.markCommitted(a.entryId);
    await stub.settle(batchId);

    const state = await stub.getState();
    expect(state.batches[batchId]?.status).toBe("SETTLED");
    expect(state.entries[a.entryId]?.status).toBe("COMMITTED");
    expect(state.entries[b.entryId]?.status).toBe("DROPPED");
  });

  it("retries a failed review from a clean checkpoint", async () => {
    const stub = ledger();
    const a = await stub.append(entry());
    const batchId = (await stub.seal()) ?? "";
    await stub.failReview(batchId, await stub.startReview(batchId), "429 from model");
    expect(await stub.startReview(batchId)).toBe(2);
    await stub.recordVerdicts(batchId, { [a.entryId]: allow });
    const state = await stub.getState();
    expect(state.batches[batchId]).toMatchObject({
      reviewAttempts: 2,
      lastError: "429 from model",
    });
  });

  it("refuses partial verdicts so a review is never half-applied", async () => {
    const stub = ledger();
    const a = await stub.append(entry());
    await stub.append(entry());
    const batchId = (await stub.seal()) ?? "";
    await stub.startReview(batchId);
    const before = await stub.getEvents();

    expect(
      (await rejectionOf(stub.recordVerdicts(batchId, { [a.entryId]: allow }))).message,
    ).toMatch(/missing: 1/);
    const extra = { [a.entryId]: allow, bogus: allow };
    expect((await rejectionOf(stub.recordVerdicts(batchId, extra))).message).toMatch(
      /unexpected: 1/,
    );
    expect(await stub.getEvents()).toEqual(before);
  });

  it("rolls back every event of an operation if one is illegal", async () => {
    const stub = ledger();
    await stub.append(entry());
    const batchId = (await stub.seal()) ?? "";
    const before = await stub.getState();

    // COMMIT_STARTED is illegal from SEALED; nothing may be written.
    expect((await rejectionOf(stub.startCommit(batchId))).message).toMatch(
      /Illegal COMMIT_STARTED/,
    );
    expect(await stub.getState()).toEqual(before);
    expect((await stub.getEvents()).length).toBe(before.seq);
  });

  it("rejects malformed input at the boundary", async () => {
    const stub = ledger();
    expect((await rejectionOf(stub.append(entry({ riskScore: 7 })))).message).toMatch(/riskScore/);
    expect((await rejectionOf(stub.append(entry({ sessionId: "" })))).message).toMatch(/sessionId/);
    expect(await stub.getEvents()).toEqual([]);
  });

  describe("crash recovery (principle 3)", () => {
    it("rebuilds identical state from the event log after eviction mid-review", async () => {
      const stub = ledger();
      const a = await stub.append(entry());
      await stub.append(entry());
      await stub.append(entry()); // size seal → batch-1
      await stub.append(entry()); // opens batch-2
      await stub.startReview("batch-1");
      await stub.recordVerdicts("batch-1", {
        [a.entryId]: allow,
        ...Object.fromEntries(
          (await stub.getState()).batches["batch-1"]?.entryIds
            .filter((id) => id !== a.entryId)
            .map((id) => [id, drop]) ?? [],
        ),
      });
      const before = await stub.getState();

      await evictDurableObject(stub);

      expect(await stub.getState()).toEqual(before);
      // And the rebuilt object carries on where it left off.
      await stub.startCommit("batch-1");
      await stub.markCommitted(a.entryId);
      await stub.settle("batch-1");
      expect((await stub.getState()).batches["batch-1"]?.status).toBe("SETTLED");
    });

    it("never double-commits when the Committer replays after a crash (principle 4)", async () => {
      const stub = ledger();
      const a = await stub.append(entry());
      const b = await stub.append(entry());
      const batchId = (await stub.seal()) ?? "";
      await stub.startReview(batchId);
      await stub.recordVerdicts(batchId, { [a.entryId]: allow, [b.entryId]: allow });
      await stub.startCommit(batchId);
      await stub.markCommitted(a.entryId);

      await evictDurableObject(stub); // crash between the two commits

      // The Committer doesn't know what landed, so it replays both.
      expect(await stub.markCommitted(a.entryId)).toEqual({ duplicate: true });
      expect(await stub.markCommitted(b.entryId)).toEqual({ duplicate: false });
      await stub.settle(batchId);

      const commits = (await stub.getEvents()).filter((e) => e.event.type === "ENTRY_COMMITTED");
      expect(commits.map((c) => c.event)).toEqual([
        expect.objectContaining({ entryId: a.entryId }),
        expect.objectContaining({ entryId: b.entryId }),
      ]);
    });

    it("still fires the timer after eviction because the alarm is durable", async () => {
      const stub = ledger();
      await stub.append(entry());
      await evictDurableObject(stub);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect((await stub.getState()).batches["batch-1"]?.sealReason).toBe("timer");
    });

    it("repairs a missing alarm on startup so an open batch can't be stranded", async () => {
      const stub = ledger();
      await stub.append(entry());
      await runInDurableObject(stub, (_i, ctx) => ctx.storage.deleteAlarm());
      await evictDurableObject(stub);
      await stub.getState(); // wake it up
      expect(await runInDurableObject(stub, (_i, ctx) => ctx.storage.getAlarm())).not.toBeNull();
    });
  });

  it("pages through the event log for the visualiser", async () => {
    const stub = ledger();
    await stub.append(entry());
    await stub.append(entry());
    const page = await stub.getEvents(1, 1);
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({ seq: 2, event: { type: "ENTRY_APPENDED" } });
  });
});
