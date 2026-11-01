import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPACTION,
  type LedgerEvent,
  type LedgerState,
  type LiveFrame,
  prunableBatches,
  pruneState,
  replay,
  type VerdictRecord,
} from "../src";
import { validateCompactionConfig } from "../src/ledger/compaction";
import { allow, drop, entry } from "./fixtures";
import { TEST_COMPACTION } from "./worker";

// Ledger log compaction (M8, src/ledger/compaction.ts). The claim to prove: compaction
// is invisible except for the batches it prunes, and it only prunes batches nothing
// can act on. The property test checks the real Durable Object against a reference
// projection built from every event the Ledger ever emitted, collected before
// compaction deleted them.

let counter = 0;
function ledger() {
  return env.COMPACT_LEDGER.get(env.COMPACT_LEDGER.idFromName(`compact-${++counter}`));
}
type Stub = ReturnType<typeof ledger>;

const hold: VerdictRecord = {
  verdict: "quarantine",
  category: "uncertain",
  confidence: 0.5,
  rationale: "Needs a human.",
};

/** Small seeded PRNG (mulberry32), so a failing seed reproduces. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Drives a Ledger through random but legal protocol traffic and keeps every event it
 * emits. Polls the log after each call: a call adds at most a handful of events and
 * compaction keeps the last 5, and compaction only runs inside settle/quarantine,
 * which add one event each, so nothing is deleted before it is collected.
 */
class Driver {
  readonly events: LedgerEvent[] = [];
  clockOffset = 0;
  constructor(
    readonly stub: Stub,
    readonly random: () => number,
  ) {}

  async collect(): Promise<void> {
    const page = await this.stub.getEvents(this.events.length, 1000);
    for (const e of page) {
      expect(e.seq).toBe(this.events.length + 1);
      this.events.push(e.event);
    }
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    const out = await fn();
    await this.collect();
    return out;
  }

  async round(): Promise<void> {
    const r = this.random;
    const sessions = ["s-a", "s-b", "s-c"];
    for (let i = 0, n = 1 + Math.floor(r() * 4); i < n; i++) {
      const sessionId = sessions[Math.floor(r() * sessions.length)] as string;
      const resource = `ticket:${Math.floor(r() * 3)}`;
      await this.call(() =>
        this.stub.append(entry({ sessionId, resources: [resource], riskScore: r() * 0.5 })),
      );
    }
    if (r() < 0.7) await this.call(() => this.stub.seal());

    const state = await this.stub.getState();
    for (const batch of Object.values(state.batches)) {
      if (batch.status !== "SEALED") continue;
      const roll = r();
      if (roll < 0.1) {
        await this.call(() => this.stub.quarantine(batch.id, "fail closed"));
        continue;
      }
      if (roll < 0.2) continue; // left waiting, like a review that hasn't started
      await this.call(() => this.stub.startReview(batch.id));
      const snapshot = await this.stub.getReviewSnapshot(batch.id);
      const verdicts = Object.fromEntries(
        snapshot.entries.map((e) => {
          const v = r();
          return [e.id, v < 0.6 ? allow : v < 0.85 ? drop : hold];
        }),
      );
      await this.call(() => this.stub.recordVerdicts(batch.id, verdicts));
      await this.call(() => this.stub.startCommit(batch.id));
      for (const e of await this.stub.getCommitPlan(batch.id)) {
        await this.call(() => this.stub.markCommitted(e.id, 201));
      }
      await this.call(() => this.stub.settle(batch.id));
    }
    if (r() < 0.25) {
      const ms = Math.floor(r() * 40_000);
      this.clockOffset += ms;
      await this.stub.advanceClock(ms);
    }
  }
}

/**
 * The compacted state must equal the full replay, except for pruned batches, and
 * every pruned batch must have been prunable.
 */
function expectEquivalent(actual: LedgerState, reference: LedgerState, now: number) {
  expect(actual.seq).toBe(reference.seq);
  expect(actual.openBatchId).toBe(reference.openBatchId);
  expect(actual.nextBatchNumber).toBe(reference.nextBatchNumber);
  const prunable = new Set(
    prunableBatches(reference, now, TEST_COMPACTION.retainSettledMs).map((b) => b.id),
  );
  for (const [id, batch] of Object.entries(reference.batches)) {
    if (actual.batches[id]) {
      expect(actual.batches[id]).toEqual(batch);
      for (const e of batch.entryIds) expect(actual.entries[e]).toEqual(reference.entries[e]);
    } else {
      expect(prunable.has(id), `${id} was pruned but isn't prunable`).toBe(true);
      for (const e of batch.entryIds) expect(actual.entries[e]).toBeUndefined();
    }
  }
  expect(Object.keys(actual.entries).length).toBe(
    Object.values(actual.batches).reduce((n, b) => n + b.entryIds.length, 0),
  );
  for (const [session, flag] of Object.entries(actual.flaggedSessions)) {
    expect(reference.flaggedSessions[session]).toEqual(flag);
  }
}

async function storedRows(stub: Stub) {
  return runInDurableObject(stub, (_i, ctx) => ({
    events: ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ledger_events").one().n,
    snapshots: ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM ledger_snapshot")
      .one().n,
  }));
}

describe("log compaction", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`replays to the same state, minus only prunable batches (seed ${seed})`, async () => {
      const driver = new Driver(ledger(), rng(seed));
      for (let i = 0; i < 30; i++) await driver.round();

      const before = await driver.stub.getState();
      const now = Date.now() + driver.clockOffset;
      const reference = replay(driver.events);
      expectEquivalent(before, reference, now);
      // Pruning really happened in this history, not just snapshotting.
      expect(Object.keys(before.batches).length).toBeLessThan(
        Object.keys(reference.batches).length,
      );

      // The log really was compacted, more than once, and stays bounded.
      const rows = await storedRows(driver.stub);
      expect(rows.snapshots).toBe(1);
      expect(driver.events.length).toBeGreaterThan(TEST_COMPACTION.minEvents * 2);
      expect(rows.events).toBeLessThanOrEqual(TEST_COMPACTION.minEvents + 40);

      // A crash or eviction rebuilds exactly the same state from snapshot + tail.
      await evictDurableObject(driver.stub);
      expect(await driver.stub.getState()).toEqual(before);

      // And it carries on: new traffic lands on top of the restored snapshot.
      for (let i = 0; i < 5; i++) await driver.round();
      await evictDurableObject(driver.stub);
      expectEquivalent(
        await driver.stub.getState(),
        replay(driver.events),
        Date.now() + driver.clockOffset,
      );
      // Several hundred Durable Object calls per seed: past vitest's 5 s default when
      // the whole suite runs in parallel.
    }, 30_000);
  }

  it("compacts on settle once the log passes minEvents, and not before", async () => {
    const stub = ledger();
    const cycle = async () => {
      const a = await stub.append(entry());
      const batchId = (await stub.seal()) ?? "";
      await stub.startReview(batchId);
      await stub.recordVerdicts(batchId, { [a.entryId]: allow });
      await stub.startCommit(batchId);
      await stub.markCommitted(a.entryId);
      await stub.settle(batchId);
    };
    // 8 events per cycle: 2 cycles = 16 ≤ 20, 3 cycles = 24 > 20.
    await cycle();
    await cycle();
    expect((await storedRows(stub)).snapshots).toBe(0);
    await cycle();
    expect(await storedRows(stub)).toEqual({ events: TEST_COMPACTION.keepEvents, snapshots: 1 });
    expect((await stub.getEvents()).map((e) => e.seq)).toEqual([20, 21, 22, 23, 24]);
  });

  it("prunes a settled batch only after retention, and never one with a held entry", async () => {
    const stub = ledger();
    const ok = await stub.append(entry());
    const held = await stub.append(entry({ sessionId: "s-held" }));
    const batchId = (await stub.seal()) ?? "";
    await stub.startReview(batchId);
    await stub.recordVerdicts(batchId, { [ok.entryId]: allow, [held.entryId]: hold });
    await stub.startCommit(batchId);
    await stub.markCommitted(ok.entryId);
    await stub.settle(batchId);

    const c = await stub.append(entry());
    const second = (await stub.seal()) ?? "";
    await stub.startReview(second);
    await stub.recordVerdicts(second, { [c.entryId]: allow });
    await stub.startCommit(second);
    await stub.markCommitted(c.entryId);
    await stub.settle(second);

    expect((await stub.compact(true)).pruned.batches).toBe(0); // inside retention
    await stub.advanceClock(TEST_COMPACTION.retainSettledMs + 1);
    const out = await stub.compact(true);
    expect(out.pruned).toMatchObject({ batches: 1, entries: 1 });
    const state = await stub.getState();
    expect(state.batches[batchId]?.status).toBe("SETTLED"); // still holds a QUARANTINED entry
    expect(state.batches[second]).toBeUndefined();

    // The held entry can still be decided, and once it is, its batch can go.
    expect(await stub.resolveEntry(held.entryId, "drop", "op", "spam")).toMatchObject({ ok: true });
    await stub.advanceClock(TEST_COMPACTION.retainSettledMs + 1);
    await stub.compact(true);
    expect((await stub.getState()).batches[batchId]).toBeUndefined();
  });

  it("keeps a committed entry reportable inside retention and refuses it once pruned", async () => {
    const stub = ledger();
    const a = await stub.append(entry());
    const b = await stub.append(entry());
    const batchId = (await stub.seal()) ?? "";
    await stub.startReview(batchId);
    await stub.recordVerdicts(batchId, { [a.entryId]: allow, [b.entryId]: allow });
    await stub.startCommit(batchId);
    await stub.markCommitted(a.entryId);
    await stub.markCommitted(b.entryId);
    await stub.settle(batchId);

    await stub.compact(true);
    expect(await stub.reportEntry(a.entryId, "op", "missed")).toMatchObject({ ok: true });
    await stub.advanceClock(TEST_COMPACTION.retainSettledMs + 1);
    await stub.compact(true);
    expect(await stub.reportEntry(b.entryId, "op", "missed")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("drops expired session flags and keeps live ones", async () => {
    const state: LedgerState = {
      seq: 0,
      openBatchId: null,
      nextBatchNumber: 1,
      batches: {},
      entries: {},
      flaggedSessions: { old: { at: 0, reason: "x" }, fresh: { at: 9_000, reason: "y" } },
    };
    expect(pruneState(state, 10_000, 0, 5_000)).toEqual({ batches: 0, entries: 0, flags: 1 });
    expect(Object.keys(state.flaggedSessions)).toEqual(["fresh"]);
  });

  it("validates its config", () => {
    expect(validateCompactionConfig(DEFAULT_COMPACTION)).toBe(DEFAULT_COMPACTION);
    expect(() => validateCompactionConfig({ ...DEFAULT_COMPACTION, minEvents: 0 })).toThrow();
    expect(() =>
      validateCompactionConfig({ ...DEFAULT_COMPACTION, keepEvents: DEFAULT_COMPACTION.minEvents }),
    ).toThrow();
    expect(() =>
      validateCompactionConfig({ ...DEFAULT_COMPACTION, retainSettledMs: -1 }),
    ).toThrow();
  });
});

describe("live stream across compaction", () => {
  async function viewer(stub: Stub, after: number) {
    const res = await stub.fetch(`https://ledger.test/live?after=${after}`, {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();
    const frames: LiveFrame[] = [];
    ws.addEventListener("message", (m) =>
      frames.push(...(JSON.parse(m.data as string) as LiveFrame[])),
    );
    const until = async (pred: (f: LiveFrame[]) => boolean) => {
      const deadline = Date.now() + 2_000;
      while (!pred(frames)) {
        if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(frames)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    return { ws, frames, until };
  }

  async function compacted() {
    const stub = ledger();
    const a = await stub.append(entry({ sessionId: "aaaaaaaa-session-hash" }));
    const b = await stub.append(entry({ sessionId: "bbbbbbbb-session-hash" }));
    const batchId = (await stub.seal()) ?? "";
    await stub.startReview(batchId);
    await stub.recordVerdicts(batchId, { [a.entryId]: allow, [b.entryId]: drop });
    await stub.startCommit(batchId);
    await stub.markCommitted(a.entryId, 201);
    await stub.settle(batchId);
    await stub.append(entry({ sessionId: "s-c" })); // an open batch in the snapshot too
    await stub.compact(true);
    return { stub, head: (await stub.getState()).seq };
  }

  it("sends a SNAPSHOT when the events asked for are gone, then continues live", async () => {
    const { stub, head } = await compacted();
    const v = await viewer(stub, 0);
    await v.until((f) => f.some((x) => x.type === "SNAPSHOT"));
    const snap = v.frames.find((f) => f.type === "SNAPSHOT");
    expect(snap).toMatchObject({ seq: head, flaggedSessions: [expect.any(String)] });
    if (snap?.type !== "SNAPSHOT") throw new Error("no snapshot");
    expect(snap.batches.map((b) => [b.batchId, b.status])).toEqual([
      ["batch-1", "SETTLED"],
      ["batch-2", "OPEN"],
    ]);
    expect(snap.entries.map((e) => [e.status, e.originStatus])).toEqual([
      ["COMMITTED", 201],
      ["DROPPED", null],
      ["PENDING", null],
    ]);
    // The snapshot is the public projection: no headers, short sessions.
    expect(JSON.stringify(snap)).not.toContain("content-type");
    expect(snap.entries.map((e) => e.session).slice(0, 2)).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    // No replayed events: the snapshot already covers them.
    expect(v.frames.some((f) => "seq" in f && f.type !== "SNAPSHOT")).toBe(false);

    await stub.append(entry({ sessionId: "s-d" }));
    await v.until((f) => f.some((x) => x.type === "ENTRY_APPENDED"));
    expect(v.frames.find((f) => f.type === "ENTRY_APPENDED")).toMatchObject({ seq: head + 1 });
    v.ws.close();
  });

  it("replays events, not a snapshot, for a viewer inside the kept tail", async () => {
    const { stub, head } = await compacted();
    const v = await viewer(stub, head - 2);
    await v.until((f) => f.filter((x) => "seq" in x).length === 2);
    expect(v.frames.some((f) => f.type === "SNAPSHOT")).toBe(false);
    expect(v.frames.flatMap((f) => ("seq" in f ? [f.seq] : []))).toEqual([head - 1, head]);
    v.ws.close();
  });
});
