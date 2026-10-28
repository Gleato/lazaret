import { env } from "cloudflare:test";
import { AnthropicReviewer } from "@gleator/lazaret";
import { config } from "@gleator/tidewater-lazaret/config";
import { describe, expect, it, type TestContext } from "vitest";
import { type Mode, runCorpus } from "../src/harness";
import { percentile, summarize } from "../src/metrics";
import { callCostUsd } from "../src/pricing";
import { measureTtft } from "../src/ttft";

// The eval run. `gate-only` and `fake` run in every `npm test` (free, deterministic)
// and double as regression tests. `live` runs only via `npm run eval:live` with
// explicit spend confirmation (see vitest.config.ts).

let shard = 0;

async function evaluate(mode: Mode, task: TestContext["task"]) {
  const startedAt = new Date().toISOString();
  const maxUsd = Number(env.EVAL_MAX_USD ?? 6);
  const { results, calls, batches } = await runCorpus(env.EVAL_CORPUS, {
    mode,
    ledger: env.EVAL_LEDGER,
    shard: `eval-${mode}-${++shard}`,
    maxUsd,
    costOf: (c) => callCostUsd(c).usd,
    ...(mode === "live" && env.ANTHROPIC_API_KEY
      ? { liveReviewer: new AnthropicReviewer(env.ANTHROPIC_API_KEY, config.review) }
      : {}),
  });
  const summary = summarize(results, calls);
  task.meta.evalResult = {
    mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    corpus: {
      cases: env.EVAL_CORPUS.length,
      attacks: env.EVAL_CORPUS.filter((c) => c.label === "attack").length,
      benign: env.EVAL_CORPUS.filter((c) => c.label === "benign").length,
    },
    models:
      mode === "live"
        ? {
            batch: config.review.batchModel,
            escalation: config.review.escalationModel,
            inline: config.review.inlineModel,
          }
        : "scripted",
    summary,
    results,
    calls,
    batches,
  };
  return { summary, results };
}

describe("evals", () => {
  it("gate-only: the deterministic gate blocks /admin and never a benign request", async ({
    task,
  }) => {
    const { summary, results } = await evaluate("gate-only", task);
    // A gate false positive rejects a real customer with no model in the loop to
    // overrule it, so the bar is zero.
    expect(summary.gateOnly.fp).toBe(0);
    // The gate is triage, not the judge: writes hard-block only on stacked evidence
    // (risk >= 0.95), and single strong signals go to the reviewer instead. So the
    // floor here is the BLOCK route plus nothing benign, not a recall target.
    expect(summary.gateOnly.tp).toBeGreaterThanOrEqual(3);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    for (const id of ["admin-01", "admin-02", "admin-03"]) expect(byId[id]?.stage).toBe("gate");
  });

  it("sends corpus bodies byte-for-byte, including keys like __proto__", () => {
    // Regression: objects passed into workerd lost `__proto__`, so the first live run
    // never actually sent its prototype-pollution case.
    const mass05 = env.EVAL_CORPUS.find((c) => c.id === "mass-05");
    expect(mass05?.requests[0]?.bodyText).toContain('"__proto__":{"role":"admin"}');
  });

  it("fake: the scripted reviewer's drops propagate through taint and nothing benign is lost", async ({
    task,
  }) => {
    const { summary, results } = await evaluate("fake", task);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    for (const id of ["taint-01", "taint-02", "taint-03"]) expect(byId[id]?.stage).toBe("taint");
    // The benign follow-ups to the customer's own pending tickets are delivered.
    expect(byId["ok-reply-04"]?.stage).toBe("delivered");
    expect(byId["ok-reply-05"]?.stage).toBe("delivered");
    expect(summary.overall.recall).toBeGreaterThan(summary.gateOnly.recall ?? 0);
    expect(summary.calls.batch?.calls).toBeGreaterThan(0);
  });

  it.runIf(env.EVAL_LIVE === "1")(
    "live: real Claude reviewers over the full corpus",
    async ({ task }) => {
      const { summary } = await evaluate("live", task);
      const ttft = await measureTtft(env.ANTHROPIC_API_KEY as string, config.review.inlineModel);
      const result = task.meta.evalResult as Record<string, unknown>;
      result.ttft = {
        ...ttft,
        p50: percentile(ttft.firstTokenMs, 50),
        p95: percentile(ttft.firstTokenMs, 95),
      };
      console.log(JSON.stringify({ overall: summary.overall, cost: summary.cost }, null, 2));
      expect(summary.cases).toBe(env.EVAL_CORPUS.length);
    },
  );
});
