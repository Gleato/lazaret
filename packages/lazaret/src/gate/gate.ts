import type { Policy, ResolvedConfig } from "../config/define";
import type { CompiledRule, RuleContext } from "./rules";
import { combineRisk, type GateSignal } from "./signals";

// The gate's verdict for one request: a risk score with the evidence behind it,
// and whether that evidence is strong enough to reject at the edge without
// spending a model call.

export interface GateDecision {
  risk: number;
  block: boolean;
  signals: GateSignal[];
}

/** A learned rule at the gate (M5). `shadow` rules record a hit but add no risk. */
export interface MemoryGateRule {
  id: string;
  mode: "shadow" | "flag" | "block";
  weight: number;
  category: string;
  compiled: CompiledRule;
}

export function decide(
  config: ResolvedConfig,
  policy: Policy,
  ctx: Omit<RuleContext, "signals">,
  signals: GateSignal[],
  memoryRules: MemoryGateRule[] = [],
): GateDecision {
  const all = [...signals];
  let ruleBlocked = false;
  // Rules see the signals gathered so far, so they can refine them
  // (e.g. "sqli hit on /api/search is expected; ignore it" in M5).
  const ruleCtx: RuleContext = { ...ctx, signals };
  for (const { rule, test } of config.gate.rules) {
    if (!test(ruleCtx)) continue;
    const weight = rule.action === "block" ? 1 : (rule.weight ?? 0);
    all.push({
      source: "rule",
      id: `rule.${rule.id}`,
      category: rule.category ?? "custom",
      weight,
    });
    if (rule.action === "block") ruleBlocked = true;
  }
  for (const m of memoryRules) {
    if (!m.compiled.test(ruleCtx)) continue;
    all.push({
      source: "rule",
      id: `memory.${m.id}`,
      category: m.category,
      weight: m.mode === "shadow" ? 0 : m.mode === "block" ? 1 : m.weight,
    });
    if (m.mode === "block") ruleBlocked = true;
  }
  const risk = combineRisk(all.map((s) => s.weight));
  // Reads (PASS) have no reviewer behind them, so they get the stricter threshold.
  const threshold = policy === "PASS" ? config.gate.thresholds.pass : config.gate.thresholds.review;
  return { risk, block: ruleBlocked || risk >= threshold, signals: all };
}
