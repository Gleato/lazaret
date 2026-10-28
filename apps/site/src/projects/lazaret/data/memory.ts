// The two-phase Memory eval for the memory panel (evals/results/memory-*.json, written
// by evals/src/memory-eval.ts): warm the Memory on a training split, then measure the
// gate alone on held-out cases with a cold Memory and with the warm one. Picked up at
// build time: the live run if it has been published, otherwise the free offline run,
// which the page labels as a scripted-reviewer check rather than a result.

const files = import.meta.glob<{ default: unknown }>(
  "../../../../../../evals/results/memory-*.json",
  {
    eager: true,
  },
);

interface Rates {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

interface MemoryResult {
  mode: "fake" | "live";
  startedAt: string;
  split: { train: number; heldOut: number };
  heldOut: { cold: { gateOnly: Rates; overall: Rates }; warm: { gateOnly: Rates; overall: Rates } };
  rulesByStatus: Record<string, number>;
  learnedCatches: { caseId: string; ruleId: string; ruleDescription: string }[];
  modelCallsAvoided: { writes: number };
}

export interface MemoryEvalView {
  summary: string;
  rows: { label: string; cold: string; warm: string }[];
  catches: { caseId: string; rule: string }[];
  source: string;
}

const PREFIX = "../../../../../../evals/results/";
export const memoryEval: MemoryEvalView | null = toView(
  (files[`${PREFIX}memory-latest.json`] ?? files[`${PREFIX}memory-fake.json`])?.default as
    | MemoryResult
    | undefined,
);

function toView(r: MemoryResult | undefined): MemoryEvalView | null {
  if (!r?.heldOut) return null;
  const { cold, warm } = r.heldOut;
  const attacks = (x: Rates) => `${x.tp} of ${x.tp + x.fn}`;
  const honest = (x: Rates) => `${x.fp} of ${x.fp + x.tn}`;
  const rules = Object.entries(r.rulesByStatus)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
  const date = new Date(r.startedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return {
    summary: `The Memory trained on ${r.split.train} corpus cases, then the gate faced ${r.split.heldOut} it had never seen. It learned ${rules || "no rules"}, and stopped ${r.modelCallsAvoided.writes} more held-out ${r.modelCallsAvoided.writes === 1 ? "write" : "writes"} at the edge without a model call.`,
    rows: [
      { label: "Attacks stopped", cold: attacks(cold.gateOnly), warm: attacks(warm.gateOnly) },
      { label: "Honest writes stopped", cold: honest(cold.gateOnly), warm: honest(warm.gateOnly) },
    ],
    catches: r.learnedCatches.map((c) => ({ caseId: c.caseId, rule: c.ruleDescription })),
    source:
      r.mode === "live"
        ? `Live run of ${date}, with Claude proposing the rules (evals/results/memory-latest.json).`
        : `Offline run of ${date}: a scripted reviewer and a scripted rule proposer, so this checks that the learning loop works end to end, not how good Claude's rules are. Results from a live run, with Claude proposing the rules, will replace these (evals/results/memory-fake.json).`,
  };
}
