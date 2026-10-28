import { env } from "cloudflare:test";
import { AnthropicReviewer, AnthropicRuleProposer } from "@gleator/lazaret";
import { config } from "@gleator/tidewater-lazaret/config";
import { describe, expect, it, type TestContext } from "vitest";
import { runMemoryEval } from "../src/memory-eval";
import { callCostUsd } from "../src/pricing";

// The two-phase Memory eval (src/memory-eval.ts). `fake` runs in every `npm test`
// (free, deterministic: scripted reviewer + scripted proposer) as a regression test of
// the learning loop; `npm run eval:memory` also writes results/memory-fake.json. `live`
// runs only via `npm run eval:memory:live`, behind the same spend guard as eval:live.

let run = 0;

async function evaluate(mode: "fake" | "live", task: TestContext["task"]) {
  const key = env.ANTHROPIC_API_KEY;
  const result = await runMemoryEval({
    mode,
    corpus: env.EVAL_CORPUS,
    ledger: env.EVAL_LEDGER,
    memory: env.EVAL_MEMORY,
    runId: `memory-${mode}-${++run}`,
    maxUsd: Number(env.EVAL_MAX_USD ?? 6),
    costOf: (c) => callCostUsd(c).usd,
    ...(mode === "live" && key
      ? {
          liveReviewer: new AnthropicReviewer(key, config.review),
          liveProposer: new AnthropicRuleProposer(key, config.memory.distillModel),
        }
      : {}),
  });
  task.meta.memoryResult = {
    ...result,
    models:
      mode === "live"
        ? {
            batch: config.review.batchModel,
            escalation: config.review.escalationModel,
            inline: config.review.inlineModel,
            distill: config.memory.distillModel,
          }
        : "scripted",
  };
  return result;
}

describe("memory eval", () => {
  it("fake: rules learned from the training split stop held-out attacks at the gate, and nothing benign", async ({
    task,
  }) => {
    const r = await evaluate("fake", task);
    // The safety bar is the same as the gate's own: a learned rule that stops a real
    // customer has no model behind it to overrule it, so zero gate false positives.
    expect(r.heldOut.warm.gateOnly.fp).toBe(0);
    expect(r.heldOut.cold.gateOnly.fp).toBe(0);
    // The loop closes end to end: something is distilled and promoted to block, and a
    // held-out attack the cold gate let through is stopped at the edge by it.
    expect(r.promoted.block.length).toBeGreaterThan(0);
    expect(r.heldOut.delta.gateRecall).toBeGreaterThan(0);
    expect(r.modelCallsAvoided.writes).toBeGreaterThan(0);
    for (const c of r.learnedCatches) expect(c.ruleDescription).toBeTruthy();
    // Learning must never cost recall: the warm arm stops at least what the cold one does.
    expect(r.heldOut.warm.overall.tp).toBeGreaterThanOrEqual(r.heldOut.cold.overall.tp);
  });

  it.runIf(env.EVAL_LIVE === "1")(
    "live: real reviewers and a real distiller across the split",
    async ({ task }) => {
      const r = await evaluate("live", task);
      console.log(JSON.stringify({ headline: r.headline, cost: r.cost }, null, 2));
      expect(r.split.heldOut).toBeGreaterThan(0);
    },
  );
});
