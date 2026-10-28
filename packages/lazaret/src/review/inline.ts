import type { ResolvedConfig } from "../config/define";
import type { Actor } from "../gateway/actor";
import type { EntryState, VerdictRecord } from "../ledger/types";
import type { Reviewer } from "./client";
import { buildInlinePrompt } from "./prompt";
import { parseVerdicts } from "./schema";

// Inline review for routes that can't wait for a batch (login, payments). The
// client is blocked on this call, so it runs the fast model under a hard deadline.
// Anything other than a confident allow fails closed. The bar for "confident"
// rises when the gate already saw strong evidence.

/**
 * Why there's no verdict. `timeout`, `error` and `budget` (the daily spend cap is
 * reached, review/budget.ts; the gateway decides that before calling) mean the
 * reviewer couldn't be reached; a route may then fall back to the gate
 * (RouteConfig.onReviewUnavailable).
 * `declined` and `unusable` mean the model saw the request and wouldn't, or couldn't,
 * judge it: those always fail closed, since an attacker can provoke them.
 */
export type UnavailableCause = "timeout" | "error" | "budget" | "declined" | "unusable";

export type InlineDecision =
  | { verdict: VerdictRecord }
  | { unavailable: string; cause: UnavailableCause };

const MIN_ALLOW_CONFIDENCE = 0.7;
const MIN_ALLOW_CONFIDENCE_HIGH_RISK = 0.9;

export async function inlineReview(
  entry: EntryState,
  reviewer: Reviewer,
  config: ResolvedConfig,
  actor: Actor | null = null,
): Promise<InlineDecision> {
  const timeoutMs = config.review.inlineTimeoutMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`inline review exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    // Race as well as abort, in case a Reviewer implementation ignores the signal.
    const outcome = await Promise.race([
      reviewer.review({
        tier: "inline",
        prompt: buildInlinePrompt(entry, actor),
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (outcome.kind === "refusal")
      return {
        unavailable: `reviewer refused (${outcome.category ?? "unspecified"})${
          outcome.advisory ? `; fallback ${outcome.advisory.model} answered, not used` : ""
        }`,
        cause: "declined",
      };
    if (outcome.kind === "incomplete") return { unavailable: outcome.reason, cause: "unusable" };
    let verdict: VerdictRecord;
    try {
      verdict = parseVerdicts(outcome.output, [entry.id])[entry.id] as VerdictRecord;
    } catch (err) {
      return { unavailable: (err as Error).message, cause: "unusable" };
    }
    const bar =
      entry.riskScore >= config.review.escalateAtRisk
        ? MIN_ALLOW_CONFIDENCE_HIGH_RISK
        : MIN_ALLOW_CONFIDENCE;
    if (verdict.verdict === "allow" && verdict.confidence < bar) {
      return {
        verdict: {
          ...verdict,
          verdict: "quarantine",
          rationale: `Allow below ${bar} confidence. ${verdict.rationale}`,
        },
      };
    }
    return { verdict };
  } catch (err) {
    return { unavailable: (err as Error).message, cause: timedOut ? "timeout" : "error" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
