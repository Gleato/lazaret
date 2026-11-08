import { env } from "cloudflare:test";
import { createGateway, defineLazaret, type Reviewer } from "@gleator/lazaret";
import { beforeEach, describe, expect, it } from "vitest";
import { type BenchEnv, CONTEXT_PATH, createBench } from "../benchmark/bench";
import { benchConfig } from "../benchmark/config";

// The bridge's contract with the Python harness. These matter because a wrong mapping
// here would quietly change benchmark scores, and a budget stop must never look like a
// stopped attack.

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const benchEnv = {
  BENCH_LEDGER: env.EVAL_LEDGER,
  LAZARET_SIGNING_SECRET: "bench-signing-secret-0123456789",
} as unknown as BenchEnv;

const seen: string[] = [];
const prompts: { prompt: string; agent: boolean | undefined }[] = [];

/** Answers like a real paid model, so the spend cap has real numbers to count. */
const paidReviewer: Reviewer = {
  async review({ prompt, agent }) {
    prompts.push({ prompt, agent });
    const entry_id = /"entry_id":\s*"([^"]+)"/.exec(prompt)?.[1];
    return {
      kind: "output",
      model: "claude-opus-5-5",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      output: {
        verdicts: [
          { entry_id, verdict: "allow", category: "benign", confidence: 0.95, rationale: "ok" },
        ],
      },
    } as Awaited<ReturnType<Reviewer["review"]>>;
  },
};

// The pilot's config plus one BLOCK route: a deterministic refusal with no model call,
// which needs no guessing at what scores high enough at the gate.
const testConfig = defineLazaret({
  origin: benchConfig.origin.href,
  routes: [
    { match: "POST /tools/forbidden", policy: "BLOCK" },
    { match: "POST /tools/:name", policy: "INLINE_REVIEW" },
  ],
  session: { header: "authorization" },
  ledger: { binding: benchConfig.ledger.binding },
  review: { dailyBudgetUsd: 50, task: { path: CONTEXT_PATH, toolResultsField: "tool_results" } },
});

const makeBench = () =>
  createBench(
    (reviewer, stubOrigin) =>
      createGateway(testConfig, {
        reviewer,
        fetchOrigin: (request) => {
          const { pathname } = new URL(request.url);
          if (pathname !== CONTEXT_PATH) seen.push(pathname);
          return stubOrigin(request);
        },
      }),
    () => paidReviewer,
  );

type Bench = ReturnType<typeof makeBench>;

const post = (bench: Bench, path: string, body: unknown, e: BenchEnv = benchEnv, session = "s1") =>
  bench.fetch(
    new Request(`https://bench.test${path}`, {
      method: "POST",
      headers: { "x-bench-session": session },
      body: JSON.stringify(body),
    }),
    e,
    ctx,
  );

const reset = (bench: Bench, reviewer: string, e: BenchEnv = benchEnv, maxUsd = 1) =>
  post(bench, "/__bench/reset", { reviewer, maxUsd }, e);

const write = { recipient: "UK12345", amount: 10, subject: "rent" };

describe("bench bridge", () => {
  let bench: Bench;
  beforeEach(() => {
    bench = makeBench();
    seen.length = 0;
    prompts.length = 0;
  });

  it("reports an allowed write and reaches the stub origin", async () => {
    await reset(bench, "scripted:allow");
    const res = await post(bench, "/__bench/tool/send_money", write);
    expect(await res.json()).toMatchObject({ decision: "allow", status: 200 });
    expect(seen).toEqual(["/tools/send_money"]);
  });

  it("tells a drop from a hold, though the client sees the same 403", async () => {
    await reset(bench, "scripted:drop");
    const dropped = await post(bench, "/__bench/tool/send_money", write);
    expect(await dropped.json()).toMatchObject({ decision: "drop", status: 403 });

    await reset(bench, "scripted:hold");
    const held = await post(bench, "/__bench/tool/send_money", write);
    expect(await held.json()).toMatchObject({ decision: "hold", status: 403 });
    expect(seen).toEqual([]);
  });

  it("reports a gate block when no model was called", async () => {
    await reset(bench, "scripted:allow");
    const res = await post(bench, "/__bench/tool/forbidden", write);
    expect(await res.json()).toMatchObject({ decision: "gate_block", status: 403 });
    const calls = (await (
      await bench.fetch(new Request("https://bench.test/__bench/calls"), benchEnv, ctx)
    ).json()) as { calls: unknown[] };
    expect(calls.calls).toEqual([]);
  });

  it("refuses to review live without the spend confirmation", async () => {
    const res = await reset(bench, "live", { ...benchEnv, ANTHROPIC_API_KEY: "test" });
    expect(res.status).toBe(403);
  });

  it("marks the run invalid at the cap, rather than scoring a stop", async () => {
    const paid = { ...benchEnv, ANTHROPIC_API_KEY: "test", BENCH_CONFIRM_SPEND: "yes" };
    await reset(bench, "live", paid, 0.01);
    const first = await post(bench, "/__bench/tool/send_money", write, paid);
    expect(await first.json()).toMatchObject({ decision: "allow" });

    const second = await post(bench, "/__bench/tool/send_money", write, paid);
    expect(second.status).toBe(402);
    expect(await second.json()).toMatchObject({ invalid: true });
  });
});

describe("task context in the bench", () => {
  const paid = { ...benchEnv, ANTHROPIC_API_KEY: "test", BENCH_CONFIRM_SPEND: "yes" };
  beforeEach(() => {
    prompts.length = 0;
  });

  it("reviews with no task unless the run was given one", async () => {
    const bench = makeBench();
    await reset(bench, "live", paid);
    await post(bench, "/__bench/tool/send_money", write, paid);
    expect(prompts[0]?.agent).toBeUndefined();
    expect(prompts[0]?.prompt).not.toContain("agent_task");
  });

  it("finds a session's task by its credential, through the real lookup", async () => {
    const bench = makeBench();
    await reset(bench, "live", paid, 100); // two calls of the deliberately pricey reviewer
    await post(bench, "/__bench/context", { session: "s1", task: "Pay the bill" });
    await post(bench, "/__bench/context", {
      session: "s1",
      toolResult: { tool: "read_file", result: "Amount: 98.70" },
    });
    await post(bench, "/__bench/tool/send_money", write, paid);
    await post(bench, "/__bench/tool/send_money", write, paid, "s2");

    const [mine, other] = prompts;
    expect(mine?.agent).toBe(true);
    expect(mine?.prompt.split("<batch_data>")[0]).toContain("Pay the bill");
    expect(mine?.prompt.split("<batch_data>")[1]).toContain("Amount: 98.70");
    expect(other?.prompt).not.toContain("Pay the bill");
  });

  it("forgets every task at reset, so one run can't leak into the next", async () => {
    const bench = makeBench();
    await reset(bench, "live", paid);
    await post(bench, "/__bench/context", { session: "s1", task: "Pay the bill" });
    await reset(bench, "live", paid);
    await post(bench, "/__bench/tool/send_money", write, paid);
    expect(prompts[0]?.prompt).not.toContain("Pay the bill");
  });
});
