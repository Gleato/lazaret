import type { Policy, ResolvedConfig } from "../config/define.ts";
import type { CompiledRule, RuleContext } from "./rules.ts";
import { combineRisk, type GateSignal } from "./signals.ts";

// The gate's verdict for one request: a risk score with the evidence behind it,
// and whether that evidence is strong enough to reject at the edge without
// spending a model call.

export interface GateDecision {
  risk: number;
  block: boolean;
  signals: GateSignal[];
  /** Set when a `hold` rule matched (M11): send the write to a person, no model call. */
  hold?: HoldReason;
}

/** Why a write is held for a person by a rule rather than a reviewer (M11). */
export interface HoldReason {
  ruleId: string;
  category: string;
  description: string;
}

/** A learned rule at the gate (M5). `shadow` rules record a hit but add no risk. */
export interface MemoryGateRule {
  id: string;
  mode: "shadow" | "flag" | "hold" | "block";
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
  let hold: HoldReason | undefined;
  // Rules see the signals gathered so far, so they can refine them
  // (e.g. "sqli hit on /api/search is expected; ignore it" in M5).
  const ruleCtx: RuleContext = { ...ctx, signals };
  for (const { rule, test } of config.gate.rules) {
    if (!test(ruleCtx)) continue;
    // A hold is a routing decision, not evidence: weight 0 unless the rule gives one.
    const weight = rule.action === "block" ? 1 : (rule.weight ?? 0);
    all.push({
      source: "rule",
      id: `rule.${rule.id}`,
      category: rule.category ?? "custom",
      weight,
    });
    if (rule.action === "block") ruleBlocked = true;
    if (rule.action === "hold") {
      hold ??= {
        ruleId: `rule.${rule.id}`,
        category: rule.category ?? "custom",
        description: rule.description ?? rule.id,
      };
    }
  }
  for (const m of memoryRules) {
    if (!m.compiled.test(ruleCtx)) continue;
    all.push({
      source: "rule",
      id: `memory.${m.id}`,
      category: m.category,
      weight: m.mode === "shadow" || m.mode === "hold" ? 0 : m.mode === "block" ? 1 : m.weight,
    });
    if (m.mode === "block") ruleBlocked = true;
    if (m.mode === "hold") {
      hold ??= {
        ruleId: `memory.${m.id}`,
        category: m.category,
        description: m.compiled.rule.description ?? m.id,
      };
    }
  }
  const risk = combineRisk(all.map((s) => s.weight));
  // Reads (PASS) have no reviewer behind them, so they get the stricter threshold.
  const threshold = policy === "PASS" ? config.gate.thresholds.pass : config.gate.thresholds.review;
  const block = ruleBlocked || risk >= threshold;
  // A hold only means something where a reviewer would have looked: escrowed and inline
  // writes. A block wins over it. Reads and BLOCK routes ignore it.
  const holds = !block && hold !== undefined && (policy === "ESCROW" || policy === "INLINE_REVIEW");
  return { risk, block, signals: all, ...(holds ? { hold } : {}) };
}
