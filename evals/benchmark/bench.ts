import type { createGateway, Reviewer, VerdictRecord } from "@gleator/lazaret";
import { instrument, promptEntryIds } from "../src/instrument";
import { callCostUsd } from "../src/pricing";
import type { CallRecord } from "../src/types";

// The bridge between AgentDojo (Python) and the real Lazaret stack. Python asks
// "may this write happen?" and runs the tool itself on a yes, so what's measured is the
// real gateway, gate and inline reviewer, and origin is only a stub.
//
// The stub origin also plays the agent platform. Python tells it each run's task and tool
// results (`/__bench/context`, which the agent never touches), and the gateway finds them
// the way a real deployment does: a signed lookup carrying the client's credential. A
// session with no context gets 204, so arm B is the feature's own no-task path.
//
// A run is serial by design: verdicts are matched to writes by arrival order. AgentDojo's
// own runner crashes with more than one worker anyway.

export type ReviewerMode = "live" | "scripted:allow" | "scripted:drop" | "scripted:hold";

/** What became of one write. `gate_block` means no model call was made. */
export type Decision = "allow" | "drop" | "hold" | "gate_block" | "unavailable";

const MODES: readonly ReviewerMode[] = ["live", "scripted:allow", "scripted:drop", "scripted:hold"];

function scripted(verdict: "allow" | "drop" | "quarantine"): Reviewer {
  return {
    async review({ prompt }) {
      return {
        kind: "output",
        model: "scripted",
        output: {
          verdicts: promptEntryIds(prompt).map((entry_id) => ({
            entry_id,
            verdict,
            category: verdict === "allow" ? "benign" : "other",
            confidence: 0.95,
            rationale: "scripted bench reviewer",
          })),
        },
      };
    },
  };
}

interface BenchRun {
  mode: ReviewerMode;
  maxUsd: number;
  instrumented: ReturnType<typeof instrument>;
  /** Set when the cap stopped the run. Its scores would be inflated, so it isn't one. */
  invalid: string | null;
}

export interface BenchEnv {
  ANTHROPIC_API_KEY?: string;
  /** Live review needs this at server start, so no test or dry run can spend by accident. */
  BENCH_CONFIRM_SPEND?: string;
}

type Gateway = ReturnType<typeof createGateway>;

const spentUsd = (calls: CallRecord[]) => calls.reduce((n, c) => n + callCostUsd(c).usd, 0);

export const CONTEXT_PATH = "/agent/context";

interface RunContext {
  task: string;
  tool_results: { tool: string; result: string }[];
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A distinct private IP per session, so behaviour scoring can't pool separate pairs. */
function ipFor(session: string): string {
  let hash = 0;
  for (const ch of session) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `10.${(hash >> 16) & 255}.${(hash >> 8) & 255}.${hash & 255}`;
}

export function createBench(
  makeGateway: (reviewer: Reviewer, fetchOrigin: (r: Request) => Promise<Response>) => Gateway,
  liveReviewer: (apiKey: string) => Reviewer,
) {
  let run: BenchRun | null = null;
  let current: Reviewer | null = null;
  const contexts = new Map<string, RunContext>();

  // Keyed on the credential alone, as a real origin must be.
  const fetchOrigin = async (request: Request) => {
    if (new URL(request.url).pathname !== CONTEXT_PATH) return Response.json({ ok: true });
    const session = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const context = contexts.get(session);
    return context ? Response.json(context) : new Response(null, { status: 204 });
  };

  const gateway = makeGateway(
    {
      review(call) {
        if (!current) throw new Error("bench reviewer used before /__bench/reset");
        return current.review(call);
      },
    },
    fetchOrigin,
  );

  function reset(mode: ReviewerMode, maxUsd: number, env: BenchEnv) {
    let base: Reviewer;
    if (mode === "live") {
      if (env.BENCH_CONFIRM_SPEND !== "yes" || !env.ANTHROPIC_API_KEY)
        throw new Error("live review needs BENCH_CONFIRM_SPEND=yes and ANTHROPIC_API_KEY");
      base = liveReviewer(env.ANTHROPIC_API_KEY);
    } else {
      const verdict = mode.split(":")[1] as "allow" | "drop" | "hold";
      base = scripted(verdict === "hold" ? "quarantine" : verdict);
    }
    const instrumented = instrument(base, maxUsd, (c) => callCostUsd(c).usd);
    current = instrumented.reviewer;
    contexts.clear();
    run = { mode, maxUsd, instrumented, invalid: null };
  }

  async function tool(request: Request, name: string, env: object, ctx: ExecutionContext) {
    if (!run) return json({ error: "call /__bench/reset first" }, 409);
    const { calls, inlineVerdicts, started } = run.instrumented;
    if (spentUsd(calls) >= run.maxUsd) {
      run.invalid = `budget of $${run.maxUsd} reached`;
      return json({ error: run.invalid, invalid: true }, 402);
    }
    const session = request.headers.get("x-bench-session") ?? "none";
    const reviewsBefore = started.inline ?? 0;
    const verdictsBefore = inlineVerdicts.size;
    const at = Date.now();
    const res = await gateway.fetch(
      new Request(`https://bench.test/tools/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session}`,
          "content-type": "application/json",
          // Fixed: scripts' default agents add risk (gate/behaviour.ts), which would
          // measure this harness rather than the write.
          "user-agent": "agent-runtime/1.0",
          "cf-connecting-ip": ipFor(session),
        },
        body: await request.text(),
      }),
      env as never,
      ctx,
    );
    const latencyMs = Date.now() - at;
    await res.body?.cancel();

    if (res.headers.get("x-lazaret-review") === "budget") run.invalid = "library budget reached";
    if (run.invalid) return json({ error: run.invalid, invalid: true }, 402);

    const reviewed = (started.inline ?? 0) > reviewsBefore;
    const verdict: VerdictRecord | null =
      inlineVerdicts.size > verdictsBefore ? ([...inlineVerdicts.values()].at(-1) ?? null) : null;
    let decision: Decision;
    if (res.ok) decision = "allow";
    else if (res.status === 503) decision = "unavailable";
    else if (!reviewed) decision = "gate_block";
    else decision = verdict?.verdict === "drop" ? "drop" : "hold"; // includes allows under the bar
    return json({ decision, status: res.status, latencyMs, verdict });
  }

  return {
    async fetch(request: Request, env: BenchEnv, ctx: ExecutionContext): Promise<Response> {
      const { pathname } = new URL(request.url);
      const toolName = /^\/__bench\/tool\/([\w-]+)$/.exec(pathname)?.[1];
      if (request.method === "POST" && toolName) return tool(request, toolName, env, ctx);

      if (request.method === "POST" && pathname === "/__bench/reset") {
        const body = (await request.json()) as { reviewer?: ReviewerMode; maxUsd?: number };
        const mode = body.reviewer ?? "scripted:allow";
        if (!MODES.includes(mode)) return json({ error: `unknown reviewer ${mode}` }, 400);
        if (!(typeof body.maxUsd === "number" && body.maxUsd > 0))
          return json({ error: "maxUsd is required" }, 400);
        try {
          reset(mode, body.maxUsd, env);
        } catch (err) {
          return json({ error: (err as Error).message }, 403);
        }
        return json({ ok: true });
      }

      if (request.method === "POST" && pathname === "/__bench/context") {
        const body = (await request.json()) as {
          session: string;
          task?: string;
          toolResult?: { tool: string; result: string };
        };
        if (body.task !== undefined) {
          contexts.set(body.session, { task: body.task, tool_results: [] });
        }
        if (body.toolResult) contexts.get(body.session)?.tool_results.push(body.toolResult);
        return json({ ok: true });
      }

      if (request.method === "GET" && pathname === "/__bench/calls") {
        if (!run) return json({ error: "call /__bench/reset first" }, 409);
        const { calls, started } = run.instrumented;
        return json({
          mode: run.mode,
          maxUsd: run.maxUsd,
          spentUsd: spentUsd(calls),
          invalid: run.invalid,
          started,
          calls,
        });
      }
      return json({ error: "not found" }, 404);
    },
  };
}
