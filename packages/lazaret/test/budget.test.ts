import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  costUsd,
  createCommitter,
  createGateway,
  defineLazaret,
  type LazaretConfig,
  type LedgerPort,
  meteredProposer,
  meteredReviewer,
  nextUtcMidnight,
  type Reviewer,
  type ReviewUsage,
  runReviewPipeline,
  SpendTable,
  utcDay,
} from "../src";
import { fakeOrigin, fakeReviewer, verdict } from "./fakes";
import { entry } from "./helpers";
import { MemoryStepRunner } from "./step-runner";

// The daily spend cap (review/budget.ts): pricing, the counter, metering, and what
// each tier does once the day's budget is spent.

const usage = (over: Partial<ReviewUsage> = {}): ReviewUsage => ({
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

let counter = 0;
const budgetStub = (name = `budget-${++counter}`) => env.LEDGER.get(env.LEDGER.idFromName(name));

describe("pricing", () => {
  it("prices from real token counts, dated snapshots by their alias", () => {
    expect(costUsd("claude-sonnet-5-5", usage())).toEqual({ usd: 2, priced: true });
    expect(costUsd("claude-haiku-5-5-20261001", usage()).usd).toBeCloseTo(0.1);
    expect(
      costUsd("claude-sonnet-5-5", usage({ inputTokens: 0, cacheWriteTokens: 1_000_000 })).usd,
    ).toBeCloseTo(2.5);
  });

  it("prices an unknown model as Opus 5.5, so the cap trips early rather than late", () => {
    expect(costUsd("claude-mystery", usage())).toEqual({ usd: 4, priced: false });
  });
});

describe("SpendTable", () => {
  it("adds up spend per key and day, and reports the cap", async () => {
    let now = Date.UTC(2026, 9, 28, 23, 0);
    await runInDurableObject(budgetStub(), (_i, ctx) => {
      const table = new SpendTable(ctx.storage.sql, () => now);
      table.charge(0.6);
      table.charge(0.5);
      table.charge(0.2, "ip:abc");
      expect(table.status(1)).toMatchObject({
        day: "2026-10-28",
        exhausted: true,
        resetsAt: Date.UTC(2026, 9, 29),
      });
      expect(table.status(1).spentUsd).toBeCloseTo(1.1);
      expect(table.status(1, "ip:abc").spentUsd).toBeCloseTo(0.2);
      // Nonsense charges are ignored rather than corrupting the total.
      table.charge(Number.NaN);
      table.charge(-5);
      expect(table.status(1).spentUsd).toBeCloseTo(1.1);
      // A new UTC day starts from zero.
      now = Date.UTC(2026, 9, 29, 0, 1);
      expect(table.status(1)).toMatchObject({ day: "2026-10-29", spentUsd: 0, exhausted: false });
    });
  });

  it("is reachable over RPC on any Ledger instance", async () => {
    const stub = budgetStub();
    await stub.chargeSpend(0.25);
    await stub.chargeSpend(0.25, "ip:x");
    expect((await stub.budgetStatus(10)).spentUsd).toBeCloseTo(0.25);
    expect((await stub.budgetStatus(0.25, "ip:x")).exhausted).toBe(true);
  });

  it("computes UTC days and midnights", () => {
    expect(utcDay(Date.UTC(2026, 11, 31, 23, 59))).toBe("2026-12-31");
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1));
  });
});

describe("metering", () => {
  it("charges each call from its usage and model", async () => {
    const charge = vi.fn();
    const base: Reviewer = {
      review: async () => ({
        kind: "output",
        model: "claude-haiku-5-5",
        output: {},
        usage: usage(),
      }),
    };
    await meteredReviewer(base, charge, () => "claude-opus-5-5").review({
      tier: "inline",
      prompt: "",
    });
    expect(charge).toHaveBeenCalledWith(expect.closeTo(0.1, 5));
  });

  it("prices an incomplete call at its tier's model, and never fails the review on a charge error", async () => {
    const charge = vi.fn().mockRejectedValue(new Error("budget object down"));
    const base: Reviewer = {
      review: async () => ({ kind: "incomplete", reason: "max_tokens", usage: usage() }),
    };
    const outcome = await meteredReviewer(base, charge, () => "claude-sonnet-5-5").review({
      tier: "batch",
      prompt: "",
    });
    expect(outcome.kind).toBe("incomplete");
    expect(charge).toHaveBeenCalledWith(2);
  });

  it("charges nothing for a reviewer that reports no usage", async () => {
    const charge = vi.fn();
    const scripted: Reviewer = {
      review: async () => ({ kind: "output", model: "scripted", output: {} }),
    };
    await meteredReviewer(scripted, charge, () => "x").review({ tier: "batch", prompt: "" });
    expect(charge).not.toHaveBeenCalled();
  });

  it("meters the rule distiller too", async () => {
    const charge = vi.fn();
    const proposer = meteredProposer(
      {
        propose: async () => ({
          kind: "output",
          model: "claude-sonnet-5-5",
          output: {},
          usage: usage(),
        }),
      },
      charge,
      "claude-sonnet-5-5",
    );
    await proposer.propose({ drops: [], allows: [], existing: [] } as never);
    expect(charge).toHaveBeenCalledWith(2);
  });
});

describe("batch review under the cap", () => {
  const config = defineLazaret({ origin: "https://origin.test/app", routes: [] });

  async function pipeline(spent: { exhausted: boolean }[]) {
    const stub = env.LEDGER.get(env.LEDGER.idFromName(`budget-pipeline-${++counter}`));
    const { reviewer, calls } = fakeReviewer(() => verdict("allow"));
    let check = 0;
    const deps = {
      ledger: stub as unknown as LedgerPort,
      reviewer,
      committer: createCommitter({
        origin: config.origin,
        secret: "test-signing-secret-0123456789",
        fetchOrigin: fakeOrigin(201).fetchOrigin,
      }),
      config,
      budget: {
        status: () => ({
          exhausted: spent[Math.min(check++, spent.length - 1)]?.exhausted ?? false,
          resetsAt: Date.now() + 3_600_000,
        }),
      },
    };
    const { batchId } = await stub.append(entry());
    await stub.seal();
    return { stub, deps, calls, batchId };
  }

  it("waits sealed until the next day, then reviews and commits as normal", async () => {
    const { stub, deps, calls, batchId } = await pipeline([
      { exhausted: true },
      { exhausted: false },
    ]);
    const step = new MemoryStepRunner();
    expect(await runReviewPipeline(step, deps, batchId)).toMatchObject({ outcome: "settled" });
    // One durable sleep of about an hour (until "midnight", plus a minute).
    expect(step.sleeps).toHaveLength(1);
    expect(step.sleeps[0]?.[0]).toBe("budget-wait-1");
    expect(step.sleeps[0]?.[1]).toBeGreaterThan(3_600_000);
    expect(calls).toHaveLength(1);
    expect((await stub.getState()).batches[batchId]?.status).toBe("SETTLED");
  });

  it("never reviews or commits while spent, and quarantines after a week of waiting", async () => {
    const { stub, deps, calls, batchId } = await pipeline([{ exhausted: true }]);
    const step = new MemoryStepRunner();
    expect(await runReviewPipeline(step, deps, batchId)).toMatchObject({
      outcome: "quarantined",
      reason: expect.stringContaining("budget"),
    });
    expect(step.sleeps).toHaveLength(7);
    expect(calls).toHaveLength(0);
    expect((await stub.getState()).batches[batchId]?.status).toBe("QUARANTINED");
  });

  it("goes ahead if the budget object can't be reached (the cap guards spend, not safety)", async () => {
    const { deps, calls, batchId } = await pipeline([]);
    deps.budget.status = () => {
      throw new Error("down");
    };
    expect(await runReviewPipeline(new MemoryStepRunner(), deps, batchId)).toMatchObject({
      outcome: "settled",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("inline review under the cap", () => {
  const login = { user: "ann@example.com", password: "correct horse" };

  function setup(overrides: Partial<LazaretConfig>, reviewer: Reviewer) {
    const n = ++counter;
    const budgetShard = `inline-budget-${n}`;
    const origin = vi.fn(async () => Response.json({ ok: true }));
    const gateway = createGateway(
      defineLazaret({
        origin: "https://origin.test",
        ledger: { binding: "LEDGER", shard: `inline-${n}` },
        routes: [{ match: "POST /api/login", policy: "INLINE_REVIEW" }],
        review: { dailyBudgetUsd: 1, budgetShard },
        ...overrides,
      }),
      { fetchOrigin: origin, reviewer },
    );
    const post = () =>
      gateway.fetch(
        new Request("https://edge.test/api/login", {
          method: "POST",
          body: JSON.stringify(login),
          headers: {
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0 (test)",
            "cf-connecting-ip": "203.0.113.9",
          },
        }),
        env,
      );
    return { post, origin, budget: budgetStub(budgetShard) };
  }

  it("charges each inline call to the day's budget", async () => {
    const reviewer = fakeReviewer(
      () => verdict("allow", 0.96),
      () => ({
        kind: "output",
        model: "claude-haiku-5-5",
        output: { verdicts: [] },
        usage: usage({ inputTokens: 100_000 }),
      }),
    ).reviewer;
    const { post, budget } = setup({}, reviewer);
    await post();
    expect((await budget.budgetStatus(1)).spentUsd).toBeCloseTo(0.01);
  });

  it("once spent, skips the model and fails closed by default", async () => {
    const { reviewer, calls } = fakeReviewer(() => verdict("allow", 0.96));
    const { post, origin, budget } = setup({}, reviewer);
    await budget.chargeSpend(1);
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.headers.get("x-lazaret-review")).toBe("budget");
    expect(calls).toHaveLength(0);
    expect(origin).not.toHaveBeenCalled();
  });

  it("once spent, lets a spotless login through on gate rules when the route opts in", async () => {
    const { reviewer, calls } = fakeReviewer(() => verdict("allow", 0.96));
    const { post, budget } = setup(
      {
        routes: [
          { match: "POST /api/login", policy: "INLINE_REVIEW", onReviewUnavailable: "gate" },
        ],
      },
      reviewer,
    );
    await budget.chargeSpend(5);
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-lazaret-review")).toBe("degraded");
    expect(calls).toHaveLength(0);
  });
});
