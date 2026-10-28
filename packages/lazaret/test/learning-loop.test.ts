import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  createCommitter,
  createGateway,
  defineLazaret,
  type LedgerPort,
  type MemoryPort,
  type RuleProposer,
  runReviewPipeline,
} from "../src";
import { fakeOrigin, fakeReviewer, SECRET, verdict } from "./fakes";
import { MemoryStepRunner } from "./step-runner";

// Principle 5, end to end. A fraud pattern the gate has no signature for, a
// support ticket that quietly carries a `payout_account`, is caught by the
// reviewer, distilled into a rule, proven against clean traffic, shadowed,
// promoted, and finally blocked at the edge without a model call.

const origin = vi.fn(async () => Response.json({ ok: true }));

describe("learning loop (principle 5)", () => {
  it("turns reviewer verdicts into an edge rule that eventually blocks without a model call", async () => {
    const config = defineLazaret({
      origin: "https://origin.test",
      ledger: { binding: "LEDGER", shard: "learning-loop" },
      memory: { binding: "MEMORY", name: "learning-loop", ruleCacheTtlMs: 0 },
      session: { cookie: "sid" },
      routes: [{ match: "POST /api/tickets", policy: "ESCROW", resources: ["ticket:new"] }],
    });
    const ledger = env.LEDGER.get(env.LEDGER.idFromName("learning-loop"));
    const memory = env.MEMORY.get(env.MEMORY.idFromName("learning-loop"));
    const gateway = createGateway(config, { fetchOrigin: origin });

    // The reviewer is the source of truth: tickets with a payout account are fraud.
    const { reviewer, calls } = fakeReviewer((e) =>
      e.body?.includes("payout_account") ? verdict("drop", 0.97, "fraud") : verdict("allow"),
    );
    // Stand-in for Claude's distiller: proposes the structural rule a model would.
    const proposer: RuleProposer = {
      propose: async (input) => ({
        kind: "output",
        model: "fake",
        output: {
          proposals: input.drops.length
            ? [
                {
                  description: "Support tickets must not carry a payout account.",
                  category: "fraud",
                  conditions: [
                    { field: "path", op: "eq", value: "/api/tickets", ci: false },
                    { field: "json:payout_account", op: "exists", value: "", ci: false },
                  ],
                },
              ]
            : [],
        },
      }),
    };
    const deps = {
      ledger: ledger as unknown as LedgerPort,
      memory: memory as unknown as MemoryPort,
      reviewer,
      proposer,
      committer: createCommitter({
        origin: config.origin,
        secret: SECRET,
        fetchOrigin: fakeOrigin().fetchOrigin,
      }),
      config,
    };

    let n = 0;
    const send = (body: unknown) => {
      n++; // a fresh session and IP each time, so behaviour scoring stays out of it
      return gateway.fetch(
        new Request("https://edge.test/api/tickets", {
          method: "POST",
          body: JSON.stringify(body),
          headers: {
            "content-type": "application/json",
            cookie: `sid=user-${n}`,
            "cf-connecting-ip": `198.51.100.${n}`,
            "user-agent": "Mozilla/5.0",
          },
        }),
        env,
      );
    };
    const fraud = () =>
      send({ subject: "Refund", body: "Please refund my order", payout_account: `ACCT-${n}` });
    const benign = () => send({ subject: "Help", body: `My printer is on fire (${n})` });
    const reviewAll = async () => {
      await ledger.seal();
      const state = await ledger.getState();
      for (const batch of Object.values(state.batches)) {
        if (batch.status === "SEALED")
          await runReviewPipeline(new MemoryStepRunner(), deps, batch.id);
      }
    };
    const rule = async () => (await memory.listRules())[0];

    // 1. Clean traffic and two frauds. The gate sees nothing wrong with the fraud.
    for (let i = 0; i < 3; i++) expect((await benign()).status).toBe(202);
    for (let i = 0; i < 2; i++) expect((await fraud()).status).toBe(202);
    await reviewAll();

    // 2. Distilled and backtested: 2 drops matched, 0 of 3 clean. Shadow mode.
    expect(await rule()).toMatchObject({ status: "shadow", support: 2, cleanSamples: 3 });

    // 3. Shadow hits are scored against the reviewer, which never sees them.
    for (let i = 0; i < 2; i++) await fraud();
    await reviewAll();
    expect(calls.at(-1)?.prompt).not.toContain("memory.");
    // …but it does get the route's drop history as background (regression: hints were once dropped).
    expect(calls.at(-1)?.prompt).toContain("recent_drops_on_these_routes");
    expect(await rule()).toMatchObject({ status: "flag", liveTruePositives: 2 });

    // 4. Flagged: still reviewed, now with extra risk. Two more confirmations → block.
    for (let i = 0; i < 2; i++) await fraud();
    await reviewAll();
    expect(await rule()).toMatchObject({ status: "block", liveTruePositives: 4 });

    // 5. Blocked at the edge. No model call, no escrow. Honest users unaffected.
    const reviewsBefore = calls.length;
    expect((await fraud()).status).toBe(403);
    expect((await benign()).status).toBe(202);
    await reviewAll();
    expect(calls.length).toBe(reviewsBefore + 1); // only the benign ticket was reviewed
    expect((await memory.getRuleEvents()).map((e) => e.to)).toEqual(["shadow", "flag", "block"]);
  });
});
