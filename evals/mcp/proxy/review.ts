import { createGateway, defineLazaret, type Reviewer, type VerdictRecord } from "@gleator/lazaret";
import { scripted } from "../../benchmark/bench";
import { lookupTask, TASK_PATH, type TaskStore } from "./context";
import type { ToolCall } from "./proxy";

// lazaret-mcp step 4: write tool calls go through the real Lazaret gateway, as in the
// AgentDojo bench (benchmark/config.ts). A write becomes `POST /tools/:name` on an
// INLINE_REVIEW route with the tool's arguments as the body. The gateway's origin is an
// adapter: when the gateway forwards a write, it sends the original JSON-RPC request
// (same id, `_meta` and headers) upstream and returns the upstream's response as it came.
// A write the gateway doesn't forward never reaches the upstream, and the client gets an
// MCP tool error saying why.

export const mcpConfig = defineLazaret({
  origin: "https://mcp-origin.test",
  routes: [{ match: "POST /tools/:name", policy: "INLINE_REVIEW" }],
  // One session per agent run, keyed on the client's credential to lazaret-mcp, and the
  // run's task is looked up by the same credential (step 5, context.ts). No tool results.
  session: { header: "authorization" },
  ledger: { binding: "MCP_LEDGER" },
  review: { dailyBudgetUsd: 1, task: { path: TASK_PATH } },
});

export type ReviewerMode = "scripted:allow" | "scripted:drop" | "scripted:hold";

export function scriptedReviewer(mode: string): Reviewer {
  if (mode === "scripted:allow") return scripted("allow");
  if (mode === "scripted:drop") return scripted("drop");
  if (mode === "scripted:hold") return scripted("quarantine");
  throw new Error(
    `MCP_REVIEWER must be scripted:allow, scripted:drop or scripted:hold, not ${mode}`,
  );
}

/** Names the pending call in the gateway's request to origin. Not `x-lazaret-*`, which it strips. */
const CALL_HEADER = "x-mcp-call";

interface Pending {
  body: string;
  forward: () => Promise<Response>;
  sent?: Response;
}

export function createWriteReview(reviewer: Reviewer, tasks: TaskStore) {
  const pending = new Map<string, Pending>();
  // The reviewer's own verdicts, by entry id (the gateway's request id, for inline
  // review), so a refusal can say why. The gateway itself answers only "forbidden".
  const verdicts = new Map<string, VerdictRecord>();

  const gateway = createGateway(mcpConfig, {
    reviewer: {
      async review(call) {
        const result = await reviewer.review(call);
        if (result.kind === "output")
          for (const v of (result.output as { verdicts?: (VerdictRecord & { entry_id: string })[] })
            .verdicts ?? [])
            verdicts.set(v.entry_id, v);
        return result;
      },
    },
    async fetchOrigin(request) {
      // The gateway's own task lookup. Only the gateway reaches this: /mcp never routes here,
      // and nothing on this path goes upstream.
      if (request.method === "GET" && new URL(request.url).pathname === TASK_PATH)
        return lookupTask(request, tasks);
      const call = pending.get(request.headers.get(CALL_HEADER) ?? "");
      if (!call) return Response.json({ error: "no such call" }, { status: 404 });
      if ((await request.text()) !== call.body)
        return Response.json({ error: "body changed" }, { status: 409 });
      const res = await call.forward();
      const body = await res.arrayBuffer(); // the upstream answers JSON, not a stream
      call.sent = new Response(body, res);
      return new Response(body, res);
    },
  });

  return async function review(
    call: ToolCall,
    request: Request,
    forward: () => Promise<Response>,
    env: object,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const key = crypto.randomUUID();
    const entry: Pending = { body: JSON.stringify(call.arguments ?? {}), forward };
    pending.set(key, entry);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Fixed, as in the bench: a script's default agent adds risk (gate/behaviour.ts).
      "user-agent": "agent-runtime/1.0",
      [CALL_HEADER]: key,
    };
    const auth = request.headers.get("authorization");
    if (auth) headers.authorization = auth;
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) headers["cf-connecting-ip"] = ip;
    try {
      const res = await gateway.fetch(
        new Request(`${mcpConfig.origin.origin}/tools/${encodeURIComponent(String(call.name))}`, {
          method: "POST",
          headers,
          body: entry.body,
        }),
        env,
        ctx,
      );
      if (entry.sent) {
        await res.body?.cancel();
        return entry.sent;
      }
      const { error } = (await res.json().catch(() => ({}))) as { error?: string };
      const requestId = res.headers.get("x-lazaret-request-id") ?? "";
      const verdict = verdicts.get(requestId);
      verdicts.delete(requestId);
      return refusal(call.id, refusalText(res.status, error, verdict));
    } finally {
      pending.delete(key);
    }
  };
}

function refusalText(status: number, error: string | undefined, verdict?: VerdictRecord): string {
  if (verdict?.verdict === "drop") return `Lazaret dropped this write: ${verdict.rationale}`;
  if (verdict) return `Lazaret held this write for a person to review: ${verdict.rationale}`;
  if (error === "held_for_review") return "Lazaret held this write for a person to review (rule).";
  if (status === 503) return `Lazaret couldn't review this write, so it wasn't sent (${error}).`;
  return `Lazaret blocked this write before review (${error ?? status}).`;
}

/** An MCP tool error, not a JSON-RPC error: the agent reads it as the tool's result. */
function refusal(id: ToolCall["id"], text: string): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError: true },
  });
}
