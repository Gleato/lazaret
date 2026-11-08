import type { ResolvedConfig } from "../config/define.ts";
import type { AgentContext, AgentToolResult } from "../ledger/types.ts";
import { pick } from "./actor.ts";

// What an AI agent was asked to do, according to origin.
//
// The AgentDojo pilot let 41% of hijacked writes through, because a well-formed transfer
// looks fine until you know the agent was only asked to pay a bill. The task can't come
// from the request: a hijacked agent controls its headers and body, and both reach the
// reviewer inside the untrusted block. So the gateway asks origin, the way it asks about
// the actor (gateway/actor.ts): a signed GET with the client's own headers. Origin finds
// the agent's run from its credential and answers with the task the user gave that run.
//
// Three things are the deployment's to get right, and Lazaret can't check them: each run
// has its own credential, no endpoint open to that credential can change the task, and
// origin keys on the credential alone, not on a header the client chose.
//
// Unlike the actor, an unknown answer is not "carry on without it". A lookup that fails
// would otherwise put a hijacked agent back under the weaker no-task review, so `unknown`
// fails closed in the gateway. `none` is origin saying this client isn't an agent.
//
// Tool results are different from the task: they're what the agent read, so an attacker
// can write into them. They go inside the untrusted block (review/prompt.ts).

export type TaskLookup =
  | { kind: "task"; context: AgentContext }
  | { kind: "none" }
  | { kind: "unknown" };

export const MAX_TASK_CHARS = 2000;
export const MAX_TOOL_RESULTS = 8;
export const MAX_TOOL_RESULT_CHARS = 2000;
const MAX_TOOL_NAME_CHARS = 100;

/** Newest results that fit the caps. A bad item is skipped: evidence only ever helps. */
function toolResults(value: unknown): Pick<AgentContext, "toolResults" | "toolResultsTruncated"> {
  if (!Array.isArray(value)) return {};
  const valid = value.filter(
    (item): item is AgentToolResult =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as AgentToolResult).tool === "string" &&
      typeof (item as AgentToolResult).result === "string",
  );
  const kept = valid.slice(-MAX_TOOL_RESULTS);
  const cut = kept.some((r) => r.result.length > MAX_TOOL_RESULT_CHARS);
  if (!kept.length) return {};
  return {
    toolResults: kept.map((r) => ({
      tool: r.tool.slice(0, MAX_TOOL_NAME_CHARS),
      result: r.result.slice(0, MAX_TOOL_RESULT_CHARS),
    })),
    ...(cut || kept.length < valid.length ? { toolResultsTruncated: true } : {}),
  };
}

/**
 * `task` on a 200 with task text. `none` on a 204, a 401 or 403 (origin's own auth will
 * refuse the write), or a 200 with no task. `unknown` on anything else, including a
 * timeout, a redirect and a 404, so a mistyped path can't quietly turn the feature off.
 * Never throws.
 */
export async function lookupTask(
  task: NonNullable<ResolvedConfig["review"]["task"]>,
  send: (signal: AbortSignal) => Promise<Response>,
): Promise<TaskLookup> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<TaskLookup>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "unknown" });
    }, task.timeoutMs);
  });
  const lookup = async (): Promise<TaskLookup> => {
    const res = await send(controller.signal);
    if (res.status === 204 || res.status === 401 || res.status === 403) return { kind: "none" };
    if (res.status !== 200) return { kind: "unknown" };
    const body: unknown = await res.json();
    const text = pick(body, task.field);
    if (text === undefined || text === null) return { kind: "none" };
    if (typeof text !== "string") return { kind: "unknown" };
    const trimmed = text.trim();
    if (!trimmed) return { kind: "none" };
    return {
      kind: "task",
      context: {
        task: trimmed.slice(0, MAX_TASK_CHARS),
        ...(task.toolResultsField ? toolResults(pick(body, task.toolResultsField)) : {}),
      },
    };
  };
  try {
    return await Promise.race([lookup(), deadline]);
  } catch {
    return { kind: "unknown" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
