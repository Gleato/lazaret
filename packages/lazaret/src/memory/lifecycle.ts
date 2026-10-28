import { type CompiledRule, compileRule } from "../gate/rules";
import type { MemoryRule, MemoryThresholds, RuleSample, RuleStatus } from "./types";

// Pure decision logic for rule trust. Kept apart from storage so the policy is
// easy to read and test exhaustively.

export interface BacktestResult {
  support: number;
  falsePositives: number;
  cleanSamples: number;
}

export function backtest(
  compiled: CompiledRule,
  drops: RuleSample[],
  allows: RuleSample[],
): BacktestResult {
  const hits = (s: RuleSample) => compiled.test(s);
  return {
    support: drops.filter(hits).length,
    falsePositives: allows.filter(hits).length,
    cleanSamples: allows.length,
  };
}

/** Status for a candidate after a backtest. */
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
  if (result.support < t.minSupport) {
    return {
      status: "rejected",
      reason: `matched ${result.support} dropped request(s); needs ${t.minSupport}`,
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

/**
 * Status after live evidence. A single false positive retires any active rule.
 * Trust is earned slowly and lost at once, because a bad rule at the gate
 * silently harms real users.
 */
export function statusAfterLiveEvidence(
  rule: Pick<
    MemoryRule,
    "status" | "liveTruePositives" | "liveFalsePositives" | "lastHitAt" | "updatedAt"
  >,
  t: MemoryThresholds,
  now: number,
): { status: RuleStatus; reason: string } | null {
  const active = rule.status === "shadow" || rule.status === "flag" || rule.status === "block";
  if (!active) return null;
  if (rule.liveFalsePositives > 0) {
    return { status: "retired", reason: "matched a request the reviewer allowed" };
  }
  if (now - (rule.lastHitAt ?? rule.updatedAt) > t.staleAfterMs) {
    return { status: "retired", reason: "no hits within the staleness window" };
  }
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
