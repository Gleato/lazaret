import { env } from "cloudflare:test";
import { AnthropicReviewer, AnthropicRuleProposer } from "@gleator/lazaret";
import { config } from "@gleator/tidewater-lazaret/config";
import { scriptedReviewer } from "@gleator/tidewater-lazaret/scripted-reviewer";
import { describe, expect, it, type TestContext } from "vitest";
import { patternAwareReviewer, runPatternEval, waveCases } from "../src/pattern";
import { callCostUsd } from "../src/pricing";
import { scriptedProposer } from "../src/proposer";

// The pattern eval (M11, src/pattern.ts). `fake` runs in every `npm test` (free:
// scripted reviewer and proposer) as a regression test of the plumbing; `npm run
// eval:pattern` also writes results/pattern-fake.json. `live` only via
// `npm run eval:pattern:live`, behind the same spend guard as the other live evals.

let run = 0;

async function evaluate(mode: "fake" | "live", task: TestContext["task"]) {
  const key = env.ANTHROPIC_API_KEY;
  const result = await runPatternEval({
    mode,
    ledger: env.EVAL_LEDGER,
    memory: env.EVAL_MEMORY,
    runId: `pattern-${mode}-${++run}`,
    maxUsd: Number(env.EVAL_MAX_USD ?? 6),
    costOf: (c) => callCostUsd(c).usd,
    ...(mode === "live" && key
      ? {
          reviewer: new AnthropicReviewer(key, config.review),
          proposer: new AnthropicRuleProposer(key, config.memory.distillModel),
        }
      : { reviewer: patternAwareReviewer(scriptedReviewer), proposer: scriptedProposer }),
  });
  task.meta.patternResult = { ...result, models: mode === "live" ? config.review : "scripted" };
  return result;
}

describe("pattern eval", () => {
  it("generates fresh actors every wave, deterministically", () => {
    const a = waveCases(1, 7);
    expect(waveCases(1, 7)).toEqual(a);
    const ids = (w: number) => waveCases(w, 7).map((c) => c.requests[0]?.bodyText);
    expect(ids(2)).not.toEqual(ids(1));
    expect(a.filter((c) => c.label === "attack")).toHaveLength(8);
    expect(a.filter((c) => c.label === "benign")).toHaveLength(8);
  });

  it.skipIf(env.EVAL_LIVE === "1")(
    "fake: split fraud is held, honest look-alikes are not",
    async ({ task }) => {
      const result = await evaluate("fake", task);
      for (const w of result.waves) {
        expect(w.attacksStopped).toBe(w.attacks);
        expect(w.honestHeld).toEqual([]);
      }
    },
  );

  it.runIf(env.EVAL_LIVE === "1")(
    "live: real reviewer and distiller over the waves",
    async ({ task }) => {
      const result = await evaluate("live", task);
      console.log(
        JSON.stringify(
          result.waves.map((w) => ({ ...w, ruleEvents: undefined })),
          null,
          1,
        ),
      );
      expect(result.waves.length).toBeGreaterThan(0);
    },
  );
});
