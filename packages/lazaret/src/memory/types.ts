import type { Rule } from "../gate/rules";
import type { GateSignal } from "../gate/signals";
import type { Verdict } from "../ledger/types";

// Memory vocabulary (principle 5: turn past execution logs into new memories).
//
// Every reviewed write is archived with a *sample*: the canonical view of the
// request that a rule would see at the gate. Rules the distiller proposes are
// judged against those samples (backtest), then earn trust in production:
//
//   proposed ─▶ pending ─▶ shadow ─▶ flag ─▶ block
//      │          │          │        │        │
//      ▼          ▼          └────────┴────────┴─▶ retired (any false positive, or stale)
//   rejected   (waits for enough clean traffic to judge)
//
//   shadow  evaluated on live traffic but has no effect; its hits are scored
//           against the reviewer's independent verdicts
//   flag    adds risk at the gate (more escalation, earlier seals)
//   block   rejects at the edge without spending a model call

export type RuleStatus = "pending" | "shadow" | "flag" | "block" | "rejected" | "retired";
export const ACTIVE_STATUSES: readonly RuleStatus[] = ["shadow", "flag", "block"];

/** A JSON value. Typed precisely (not `unknown`) so samples stay RPC-serialisable. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** What a rule can see, mirroring the gate's RuleContext (minus live signals). */
export interface RuleSample {
  method: string;
  path: string;
  query: string;
  body: string;
  headers: Record<string, string>;
  json: JsonValue | undefined;
  signals: GateSignal[];
}

export interface ArchivedVerdict {
  entryId: string;
  route: string;
  sessionId: string;
  verdict: Verdict;
  category: string;
  confidence: number;
  rationale: string;
  /** Who produced the verdict. `operator` labels (M6.7) are ground truth and win. */
  source: "batch" | "inline" | "operator";
  at: number;
  sample: RuleSample;
}

export interface MemoryRule {
  id: string;
  rule: Rule;
  status: RuleStatus;
  category: string;
  description: string;
  /** Archived drops the rule matches at backtest time. */
  support: number;
  /** Archived allows the rule was tested against. */
  cleanSamples: number;
  /** Live hits on writes the reviewer independently dropped / allowed. */
  liveTruePositives: number;
  liveFalsePositives: number;
  createdAt: number;
  updatedAt: number;
  lastHitAt: number | null;
  reason: string;
}

export interface MemoryThresholds {
  /** Archived drops a candidate must match. */
  minSupport: number;
  /** Archived allows needed before a backtest can vouch for a rule. */
  minCleanSamples: number;
  /** Live true positives (and zero false positives) to go shadow → flag. */
  promoteToFlagAfter: number;
  /** Live true positives (and zero false positives) to go flag → block. */
  promoteToBlockAfter: number;
  /** Risk weight of a flag-tier rule. */
  flagWeight: number;
  /** Active rules with no hits for this long are retired. */
  staleAfterMs: number;
}

export const DEFAULT_MEMORY_THRESHOLDS: MemoryThresholds = {
  minSupport: 2,
  minCleanSamples: 20,
  promoteToFlagAfter: 3,
  promoteToBlockAfter: 10,
  flagWeight: 0.6,
  staleAfterMs: 30 * 24 * 60 * 60 * 1000,
};

/** A proposal from the distiller, before it is compiled and backtested. */
export interface RuleProposal {
  description: string;
  category: string;
  when: Rule["when"];
}

/** The gate's view of an active memory rule. */
export interface ActiveRuleSpec {
  id: string;
  mode: "shadow" | "flag" | "block";
  weight: number;
  category: string;
  rule: Rule;
}

/** Signal id prefix for memory rule hits. The reviewer never sees these (see prompt.ts). */
export const MEMORY_SIGNAL_PREFIX = "memory.";
