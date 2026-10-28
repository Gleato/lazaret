import type { ResolvedConfig } from "../config/define";
import type { EntryState, VerdictRecord } from "../ledger/types";
import type { Reviewer } from "./client";
import { buildInlinePrompt } from "./prompt";
import { parseVerdicts } from "./schema";

// Inline review for routes that can't wait for a batch (login, payments). The
// client is blocked on this call, so it runs the fast model under a hard deadline.
// Anything other than a confident allow fails closed. The bar for "confident"
// rises when the gate already saw strong evidence.

export type InlineDecision = { verdict: VerdictRecord } | { unavailable: string };

const MIN_ALLOW_CONFIDENCE = 0.7;
const MIN_ALLOW_CONFIDENCE_HIGH_RISK = 0.9;

export async function inlineReview(
  entry: EntryState,
  reviewer: Reviewer,
  config: ResolvedConfig,
): Promise<InlineDecision> {
  const timeoutMs = config.review.inlineTimeoutMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`inline review exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    // Race as well as abort, in case a Reviewer implementation ignores the signal.
    const outcome = await Promise.race([
      reviewer.review({
        tier: "inline",
        prompt: buildInlinePrompt(entry),
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (outcome.kind === "refusal")
      return { unavailable: `reviewer refused (${outcome.category ?? "unspecified"})` };
    if (outcome.kind === "incomplete") return { unavailable: outcome.reason };
    const verdict = parseVerdicts(outcome.output, [entry.id])[entry.id] as VerdictRecord;
    const bar =
      entry.riskScore >= config.cycle.riskSpikeThreshold
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
    return { unavailable: (err as Error).message };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
