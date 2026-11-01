import { type CompiledRule, compileRule } from "../gate/rules";
import type { MemoryRule, MemoryThresholds, RuleSample, RuleStatus } from "./types";

// Pure decision logic for rule trust. Kept apart from storage so the policy is
// easy to read and test exhaustively.

export interface BacktestResult {
  /** Archived drops the rule matches. */
  support: number;
  /** Trusted allows it matches (an operator's label, or an allow old enough to trust). */
  falsePositives: number;
  /**
   * Untrusted allows it matches: writes only a model has vouched for (M7.1). The rule
   * and the reviewer disagree, and either could be wrong (rules see the decoded request,
   * so they catch encoded payloads a reviewer can miss), so a human settles it.
   */
  disputed: number;
  cleanSamples: number;
}

/**
 * Backtest a rule against archived drops and allows. `disputable` are allows only a
 * model has vouched for; a match there is a dispute, not a false positive (M7.1).
 */
export function backtest(
  compiled: CompiledRule,
  drops: RuleSample[],
  allows: RuleSample[],
  disputable: RuleSample[] = [],
): BacktestResult {
  const hits = (s: RuleSample) => compiled.test(s);
  return {
    support: drops.filter(hits).length,
    falsePositives: allows.filter(hits).length,
    disputed: disputable.filter(hits).length,
    cleanSamples: allows.length + disputable.length,
  };
}

/**
 * Status for a candidate after a backtest (M7.1). Only a false positive on trusted
 * traffic is final. Everything else that stops a rule today is "not enough evidence
 * yet", so the rule waits as `pending` and is re-backtested as traffic arrives (and
 * labels land), until it qualifies or expires after `staleAfterMs`. Before M7.1 a rule
 * with one matching drop was rejected for good and its fingerprint blocked it from
 * ever being proposed again, which is how the live Memory eval learned nothing.
 */
export function statusAfterBacktest(
  result: BacktestResult,
  t: MemoryThresholds,
): { status: RuleStatus; reason: string } {
  if (result.falsePositives > 0) {
    return {
      status: "rejected",
      reason: `matched ${result.falsePositives} allowed request(s) in backtest`,
    };
  }
  if (result.disputed > 0) {
    return {
      status: "pending",
      reason: `disputed: matched ${result.disputed} request(s) the reviewer allowed; waiting for a human label`,
    };
  }
  if (result.support < t.minSupport) {
    return {
      status: "pending",
      reason: `matched ${result.support} dropped request(s); waiting for ${t.minSupport}`,
    };
  }
  if (result.cleanSamples < t.minCleanSamples) {
    return {
      status: "pending",
      reason: `${result.cleanSamples}/${t.minCleanSamples} clean samples so far; waiting for more traffic`,
    };
  }
  return {
    status: "shadow",
    reason: `matched ${result.support} drops and 0 of ${result.cleanSamples} clean requests`,
  };
}

/** A pending rule that never gathered its evidence expires, so its slot frees up. */
export function pendingExpired(
  rule: Pick<MemoryRule, "status" | "createdAt">,
  t: MemoryThresholds,
  now: number,
): boolean {
  return rule.status === "pending" && now - rule.createdAt > t.staleAfterMs;
}

/**
 * Status after live evidence. A single false positive retires any active rule.
 * Trust is earned slowly and lost at once, because a bad rule at the gate
 * silently harms real users. A false positive here is a hit on *trusted* clean
 * traffic (an operator's label, or an allow nobody reported in time); a hit on a
 * fresh model allow is a dispute, which holds promotion until it is settled (M7.1).
 */
export function statusAfterLiveEvidence(
  rule: Pick<
    MemoryRule,
    "status" | "liveTruePositives" | "liveFalsePositives" | "lastHitAt" | "updatedAt"
  >,
  t: MemoryThresholds,
  now: number,
  /** Live hits on writes a model allowed and no human has labelled yet (M7.1). */
  openDisputes = 0,
): { status: RuleStatus; reason: string } | null {
  const active = rule.status === "shadow" || rule.status === "flag" || rule.status === "block";
  if (!active) return null;
  if (rule.liveFalsePositives > 0) {
    return { status: "retired", reason: "matched a request the reviewer allowed" };
  }
  if (now - (rule.lastHitAt ?? rule.updatedAt) > t.staleAfterMs) {
    return { status: "retired", reason: "no hits within the staleness window" };
  }
  // A rule the reviewer disagrees with doesn't climb until a human settles it.
  if (openDisputes > 0) return null;
  if (rule.status === "shadow" && rule.liveTruePositives >= t.promoteToFlagAfter) {
    return {
      status: "flag",
      reason: `${rule.liveTruePositives} confirmed live hits, no false positives`,
    };
  }
  if (rule.status === "flag" && rule.liveTruePositives >= t.promoteToBlockAfter) {
    return {
      status: "block",
      reason: `${rule.liveTruePositives} confirmed live hits, no false positives`,
    };
  }
  return null;
}

export { compileRule };
