import { AnthropicReviewer, LazaretLedger, type Reviewer } from "@gleator/lazaret";
import pgWasm from "libpg-query/wasm/libpg-query.wasm";
import { instrument } from "../../src/instrument";
import { callCostUsd } from "../../src/pricing";
import type { CallRecord } from "../../src/types";
import { loadParser } from "./classify";
import { HOST_TASK_PATH, hostTask, memoryStore } from "./context";
import { createProxy, DEFAULT_UPSTREAM } from "./proxy";
import { createWriteReview, mcpConfig, type RunGuard, scriptedReviewer } from "./review";

// Local only (see wrangler.jsonc): `npm run mcp:proxy -w @gleator/lazaret-evals`.
// MCP_REVIEWER picks the reviewer: `--var MCP_REVIEWER:scripted:drop`, or `live` (step 7),
// which needs BENCH_CONFIRM_SPEND=yes and ANTHROPIC_API_KEY at start (`npm run mcp:proxy:live`).

interface ProxyEnv {
  UPSTREAM_MCP_URL?: string;
  MCP_REVIEWER?: string;
  /** The host's credential for PUT /host/task (step 5) and /__mcp/run. Never given to the agent. */
  HOST_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  BENCH_CONFIRM_SPEND?: string;
}

/** The Ledger only keeps the spend counter here; nothing is dispatched for review. */
export class McpLedger extends LazaretLedger {
  protected override reviewWorkflowBinding(): string | null {
    return null;
  }
}

/** Run control for the replay, as the bench's /__bench/reset and /__bench/calls. Host only. */
const RUN_PATH = "/__mcp/run";

let proxy: ReturnType<typeof createProxy> | undefined;
const tasks = memoryStore();

/** Logs the task each reviewed write carried, so a run can show it (README, step 5). */
const logged = (reviewer: Reviewer): Reviewer => ({
  review(call) {
    const task = /<agent_task>([\s\S]*?)<\/agent_task>/.exec(call.prompt)?.[1];
    console.log(`[review] task=${task ?? "(none)"}`);
    return reviewer.review(call);
  },
});

const spentUsd = (calls: CallRecord[]) => calls.reduce((n, c) => n + callCostUsd(c).usd, 0);

// One run at a time. A live reviewer spends nothing until a run sets its cap.
let base: Reviewer | undefined;
let run: { maxUsd: number; invalid: string | null; inst: ReturnType<typeof instrument> };
function newRun(maxUsd: number) {
  if (!base) throw new Error("reviewer not built");
  run = { maxUsd, invalid: null, inst: instrument(base, maxUsd, (c) => callCostUsd(c).usd) };
}
const guard: RunGuard = {
  stopped() {
    if (!run.invalid && spentUsd(run.inst.calls) >= run.maxUsd)
      run.invalid = `budget of $${run.maxUsd} reached`;
    return run.invalid;
  },
  libraryBudget() {
    run.invalid = "library budget reached";
  },
};

function buildReviewer(env: ProxyEnv): { reviewer: Reviewer; live: boolean } {
  const mode = env.MCP_REVIEWER ?? "scripted:drop";
  if (mode !== "live") return { reviewer: scriptedReviewer(mode), live: false };
  if (env.BENCH_CONFIRM_SPEND !== "yes" || !env.ANTHROPIC_API_KEY)
    throw new Error("MCP_REVIEWER=live needs BENCH_CONFIRM_SPEND=yes and ANTHROPIC_API_KEY");
  return { reviewer: new AnthropicReviewer(env.ANTHROPIC_API_KEY, mcpConfig.review), live: true };
}

async function runControl(request: Request, env: ProxyEnv): Promise<Response> {
  if (!env.HOST_SECRET || request.headers.get("authorization") !== `Bearer ${env.HOST_SECRET}`)
    return Response.json({ error: "forbidden" }, { status: 403 });
  if (request.method === "POST") {
    const { maxUsd } = (await request.json()) as { maxUsd?: unknown };
    if (!(typeof maxUsd === "number" && maxUsd > 0))
      return Response.json({ error: "maxUsd is required" }, { status: 400 });
    newRun(maxUsd);
    return Response.json({ ok: true, reviewer: env.MCP_REVIEWER ?? "scripted:drop" });
  }
  const { calls, started } = run.inst;
  return Response.json({
    reviewer: env.MCP_REVIEWER ?? "scripted:drop",
    model: mcpConfig.review.inlineModel,
    inlineTimeoutMs: mcpConfig.review.inlineTimeoutMs,
    maxUsd: run.maxUsd,
    spentUsd: spentUsd(calls),
    invalid: run.invalid,
    started,
    calls,
  });
}

export default {
  async fetch(request, env, ctx) {
    if (!proxy) {
      await loadParser(pgWasm);
      const { reviewer, live } = buildReviewer(env);
      base = logged(reviewer);
      newRun(live ? 0 : Number.POSITIVE_INFINITY);
      if (live) run.invalid = "no cap set: POST /__mcp/run {maxUsd} first";
      const review = createWriteReview(
        { review: (call) => run.inst.reviewer.review(call) },
        tasks,
        guard,
      );
      proxy = createProxy(env.UPSTREAM_MCP_URL || DEFAULT_UPSTREAM, fetch, review);
    }
    const { pathname } = new URL(request.url);
    if (pathname === HOST_TASK_PATH) return hostTask(request, tasks, env.HOST_SECRET);
    if (pathname === RUN_PATH) return runControl(request, env);
    return proxy(request, env, ctx);
  },
} satisfies ExportedHandler<ProxyEnv>;
