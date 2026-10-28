import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createCommitter,
  defineLazaret,
  type LedgerPort,
  type Reviewer,
  runReviewPipeline,
  TransientReviewError,
} from "../src";
import { fakeOrigin, fakeReviewer, looksMalicious, SECRET, verdict } from "./fakes";
import { entry } from "./helpers";
import { Crash, MemoryStepRunner } from "./step-runner";

// The review → commit pipeline against a real Ledger Durable Object, a scripted
// reviewer, and a fake origin that verifies signatures like a real one would.

const config = defineLazaret({ origin: "https://origin.test/app", routes: [] });
let counter = 0;

async function setup(reviewer: Reviewer, originStatus = 201) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName(`pipeline-${++counter}`));
  const origin = fakeOrigin(originStatus);
  const deps = {
    ledger: stub as unknown as LedgerPort,
    reviewer,
    committer: createCommitter({
      origin: config.origin,
      secret: SECRET,
      fetchOrigin: origin.fetchOrigin,
    }),
    config,
    attemptBackoffMs: 1,
  };
  return { stub, origin, deps };
}

const body = (text: string) => ({ ...entry().request, body: JSON.stringify({ body: text }) });

describe("review pipeline", () => {
  it("commits allowed writes (signed), drops attacks, taints dependents, flags the attacker", async () => {
    const { reviewer } = fakeReviewer((e) =>
      looksMalicious(e.body) ? verdict("drop") : verdict("allow"),
    );
    const { stub, origin, deps } = await setup(reviewer);
    const honest = await stub.append(entry({ sessionId: "ann", request: body("Printer on fire") }));
    const attack = await stub.append(
      entry({
        sessionId: "mallory",
        resources: ["ticket:42"],
        request: body("<script>steal()</script>"),
      }),
    );
    const followUp = await stub.append(
      entry({ sessionId: "mallory", resources: ["ticket:42"], request: body("thanks!") }),
    );

    const step = new MemoryStepRunner();
    expect(await runReviewPipeline(step, deps, honest.batchId)).toEqual({
      outcome: "settled",
      committed: 1,
    });

    const state = await stub.getState();
    expect(state.batches[honest.batchId]?.status).toBe("SETTLED");
    expect(state.entries[honest.entryId]).toMatchObject({ status: "COMMITTED", originStatus: 201 });
    expect(state.entries[attack.entryId]?.status).toBe("DROPPED");
    expect(state.entries[followUp.entryId]).toMatchObject({
      status: "DROPPED",
      verdict: { category: "tainted" },
    });
    expect(state.flaggedSessions.mallory).toBeDefined();

    expect(origin.received).toHaveLength(1);
    expect(origin.received[0]).toMatchObject({
      verified: true,
      id: honest.entryId,
      idempotencyKey: honest.entryId,
      url: "https://origin.test/app/api/tickets",
    });
  });

  it("escalates a high-risk allow and keeps it only if the second opinion is confident", async () => {
    const { reviewer, calls } = fakeReviewer((e, tier) =>
      tier === "escalation"
        ? verdict("allow", e.body?.includes("localhost") ? 0.97 : 0.7)
        : verdict("allow"),
    );
    const { stub, deps } = await setup(reviewer);
    // Each high-risk write trips the risk-spike seal, so each lands in its own batch.
    const devUrl = await stub.append(
      entry({ riskScore: 0.85, request: body("my dev server is http://localhost:3000") }),
    );
    const sketchy = await stub.append(entry({ riskScore: 0.85, request: body("{{ config }}") }));
    expect([devUrl.sealed, sketchy.sealed]).toEqual(["risk", "risk"]);

    for (const { batchId } of [devUrl, sketchy])
      await runReviewPipeline(new MemoryStepRunner(), deps, batchId);
    expect(calls.map((c) => c.tier)).toEqual(["batch", "escalation", "batch", "escalation"]);
    const state = await stub.getState();
    expect(state.entries[devUrl.entryId]?.status).toBe("COMMITTED");
    expect(state.entries[sketchy.entryId]?.status).toBe("QUARANTINED");
  });

  it("quarantines the batch on a refusal, without retrying or committing", async () => {
    const { reviewer, calls } = fakeReviewer(
      () => verdict("allow"),
      () => ({ kind: "refusal", category: "cyber", model: "x" }),
    );
    const { stub, origin, deps } = await setup(reviewer);
    const { batchId } = await stub.append(entry());
    await stub.seal();

    expect(await runReviewPipeline(new MemoryStepRunner(), deps, batchId)).toEqual({
      outcome: "quarantined",
      reason: "reviewer refused (cyber)",
    });
    expect(calls).toHaveLength(1);
    expect(origin.received).toHaveLength(0);
    expect((await stub.getState()).batches[batchId]?.status).toBe("QUARANTINED");
  });

  it("quarantines on malformed output instead of giving an attacker another roll", async () => {
    const { reviewer, calls } = fakeReviewer(
      () => verdict("allow"),
      () => ({ kind: "output", model: "x", output: { verdicts: [] } }),
    );
    const { stub, deps } = await setup(reviewer);
    const { batchId } = await stub.append(entry());
    await stub.seal();
    const result = await runReviewPipeline(new MemoryStepRunner(), deps, batchId);
    expect(result).toMatchObject({
      outcome: "quarantined",
      reason: expect.stringMatching(/malformed/),
    });
    expect(calls).toHaveLength(1);
  });

  it("retries transient failures, then fails the attempt, backs off, and recovers (principle 4)", async () => {
    // Attempt 1: three 429s exhaust the step's retries. Attempt 2 succeeds.
    const { reviewer, calls } = fakeReviewer(
      () => verdict("allow"),
      (_tier, n) => (n <= 3 ? new TransientReviewError("429 rate limited") : undefined),
    );
    const { stub, deps } = await setup(reviewer);
    const { batchId } = await stub.append(entry());
    await stub.seal();
    const step = new MemoryStepRunner();

    expect(await runReviewPipeline(step, deps, batchId)).toMatchObject({ outcome: "settled" });
    expect(calls).toHaveLength(4);
    expect(step.sleeps).toEqual([["backoff-1", 1]]);
    expect((await stub.getState()).batches[batchId]).toMatchObject({
      status: "SETTLED",
      reviewAttempts: 2,
      lastError: "429 rate limited",
    });
  });

  it("quarantines after the last attempt fails", async () => {
    const { reviewer } = fakeReviewer(
      () => verdict("allow"),
      () => new TransientReviewError("overloaded"),
    );
    const { stub, deps } = await setup(reviewer);
    const { batchId } = await stub.append(entry());
    await stub.seal();
    expect(await runReviewPipeline(new MemoryStepRunner(), deps, batchId)).toEqual({
      outcome: "quarantined",
      reason: "review unavailable after 3 attempts",
    });
  });

  describe("crash recovery (principles 3 and 4)", () => {
    it("resumes after a crash mid-commit without double-committing or re-reviewing", async () => {
      const { reviewer, calls } = fakeReviewer(() => verdict("allow"));
      const { stub, origin, deps } = await setup(reviewer);
      const a = await stub.append(entry());
      const b = await stub.append(entry());
      const batchId = (await stub.seal()) ?? "";

      // Origin accepts entry a, then the Worker dies before the step checkpoints.
      const step = new MemoryStepRunner();
      step.crashBeforeCheckpoint.add(`commit-${a.entryId}`);
      await expect(runReviewPipeline(step, deps, batchId)).rejects.toThrow(Crash);

      // Workflows replays the run: completed steps come from the checkpoint log.
      expect(await runReviewPipeline(step, deps, batchId)).toEqual({
        outcome: "settled",
        committed: 2,
      });
      expect(calls).toHaveLength(1); // the review was not paid for twice

      // Origin saw a twice, both carrying the same idempotency key, and can dedupe.
      // The Ledger recorded exactly one commit per entry.
      expect(origin.received.map((r) => r.idempotencyKey)).toEqual([
        a.entryId,
        a.entryId,
        b.entryId,
      ]);
      const commits = (await stub.getEvents()).filter((e) => e.event.type === "ENTRY_COMMITTED");
      expect(commits).toHaveLength(2);
    });

    it("resumes after a crash between review and recording, without a second review", async () => {
      const { reviewer, calls } = fakeReviewer(() => verdict("allow"));
      const { stub, deps } = await setup(reviewer);
      const { batchId } = await stub.append(entry());
      await stub.seal();
      const step = new MemoryStepRunner();
      step.crashBeforeCheckpoint.add("record-verdicts");
      await expect(runReviewPipeline(step, deps, batchId)).rejects.toThrow(Crash);
      expect(await runReviewPipeline(step, deps, batchId)).toMatchObject({ outcome: "settled" });
      expect(calls).toHaveLength(1);
    });

    it("retries origin 5xx and records origin's definitive answer", async () => {
      const { reviewer } = fakeReviewer(() => verdict("allow"));
      const { stub, deps } = await setup(reviewer);
      let attempts = 0;
      deps.committer = createCommitter({
        origin: config.origin,
        secret: SECRET,
        fetchOrigin: async () => new Response(null, { status: ++attempts < 3 ? 503 : 422 }),
      });
      const { batchId, entryId } = await stub.append(entry());
      await stub.seal();
      await runReviewPipeline(new MemoryStepRunner(), deps, batchId);
      expect(attempts).toBe(3);
      expect((await stub.getState()).entries[entryId]).toMatchObject({
        status: "COMMITTED",
        originStatus: 422,
      });
    });
  });
});
