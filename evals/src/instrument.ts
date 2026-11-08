import type { Reviewer, VerdictRecord } from "@gleator/lazaret";
import type { CallRecord } from "./types";

// Spend tracking shared by every eval runner. It lives apart from harness.ts so the
// AgentDojo bench Worker (evals/benchmark) can use it without the corpus
// harness. Only the location changed; behaviour is the same.

export function promptEntries(prompt: string): { entry_id: string; route: string }[] {
  const start = prompt.indexOf("<batch_data>\n") + "<batch_data>\n".length;
  const data = JSON.parse(prompt.slice(start, prompt.lastIndexOf("\n</batch_data>"))) as {
    entries: { entry_id: string; route: string }[];
  };
  return data.entries;
}

export const promptEntryIds = (prompt: string) => promptEntries(prompt).map((e) => e.entry_id);

export class BudgetExceeded extends Error {}

/** Wraps a reviewer to time every call and record tokens, with a hard spend cap. */
export function instrument(inner: Reviewer, maxUsd: number, costOf: (c: CallRecord) => number) {
  const calls: CallRecord[] = [];
  const escalated = new Set<string>();
  // Counted when a call *starts*: an inline call that hits its deadline never resolves
  // in time to be recorded before the gateway answers 503.
  const started: Record<string, number> = {};
  // The model's own inline verdict per entry (before the gateway's confidence bar), so
  // the report can say *why* an inline write was refused. Keyed by entry id, which for
  // inline review is the gateway's request id.
  const inlineVerdicts = new Map<string, VerdictRecord>();
  let spent = 0;
  const reviewer: Reviewer = {
    async review(call) {
      if (spent >= maxUsd) throw new BudgetExceeded(`eval budget of $${maxUsd} reached`);
      const promptData = promptEntries(call.prompt);
      const ids = promptData.map((e) => e.entry_id);
      const route = promptData.length === 1 ? promptData[0]?.route : undefined;
      if (call.tier === "escalation") for (const id of ids) escalated.add(id);
      started[call.tier] = (started[call.tier] ?? 0) + 1;
      const at = Date.now();
      let outcome: Awaited<ReturnType<Reviewer["review"]>>;
      try {
        outcome = await inner.review(call);
      } catch (err) {
        // Timeouts (aborted by the inline deadline) and API errors are calls too.
        calls.push({
          tier: call.tier,
          model: "unknown",
          latencyMs: Date.now() - at,
          outcome: `error: ${(err as Error).name}`,
          entries: ids.length,
          route,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
        throw err;
      }
      const record: CallRecord = {
        tier: call.tier,
        model: "model" in outcome ? outcome.model : "unknown",
        latencyMs: Date.now() - at,
        outcome: outcome.kind,
        ...(outcome.kind === "refusal" ? { refusalCategory: outcome.category } : {}),
        entries: ids.length,
        route,
        inputTokens: outcome.usage?.inputTokens ?? 0,
        outputTokens: outcome.usage?.outputTokens ?? 0,
        cacheReadTokens: outcome.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: outcome.usage?.cacheWriteTokens ?? 0,
      };
      calls.push(record);
      spent += costOf(record);
      if (call.tier === "inline" && outcome.kind === "output") {
        const v = (outcome.output as { verdicts?: (VerdictRecord & { entry_id: string })[] })
          .verdicts?.[0];
        if (v && ids[0]) inlineVerdicts.set(ids[0], v);
      }
      return outcome;
    },
  };
  return { reviewer, calls, escalated, started, inlineVerdicts };
}
