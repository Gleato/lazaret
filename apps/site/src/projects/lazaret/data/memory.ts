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
  learnedCatches: { caseId: string; ruleId: string; ruleDescription: string; ruleStatus: string }[];
  rules: { id: string; status: string; description: string; support: number }[];
  modelCallsAvoided: { writes: number };
}

export interface MemoryEvalView {
  summary: string;
  rows: { label: string; cold: string; warm: string }[];
  catches: { caseId: string; rule: string; acted: boolean }[];
  /** Rules that passed their backtest (shadow or better), with what stage they reached. */
  learned: { status: string; rule: string }[];
  rows2: { label: string; cold: string; warm: string }[];
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
  // Say what happened in plain words, whatever the run produced: how many rules were
  // proposed, how many survived their backtest, and how many earned the right to act.
  const n = (s: string) => r.rulesByStatus[s] ?? 0;
  const proposed = Object.values(r.rulesByStatus).reduce((a, b) => a + b, 0);
  const passed = n("shadow") + n("flag") + n("block") + n("retired");
  const acting = n("flag") + n("block");
  const thin = r.rules.filter((x) => x.status === "rejected" && x.support < 2).length;
  const outcome =
    acting > 0
      ? `${acting} earned enough live hits to act at the gate.`
      : "None had earned enough live hits to act at the gate yet, so the gate alone stopped the same held-out attacks before and after training.";
  const date = new Date(r.startedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return {
    summary: `The Memory trained on ${r.split.train} corpus cases, then faced ${r.split.heldOut} it had never seen. ${r.mode === "live" ? "Claude" : "The scripted distiller"} proposed ${proposed} ${proposed === 1 ? "rule" : "rules"}; ${passed} passed ${passed === 1 ? "its" : "their"} backtest against past traffic${thin ? `, and ${thin} ${thin === 1 ? "was" : "were"} rejected for resting on a single example` : ""}. ${outcome}`,
    rows: [
      {
        label: "Attacks stopped by the gate alone",
        cold: attacks(cold.gateOnly),
        warm: attacks(warm.gateOnly),
      },
      {
        label: "Honest writes stopped by the gate",
        cold: honest(cold.gateOnly),
        warm: honest(warm.gateOnly),
      },
    ],
    // A shadow rule's match is a "would have": it was watched, not acted on.
    catches: r.learnedCatches.map((c) => ({
      caseId: c.caseId,
      rule: c.ruleDescription,
      acted: c.ruleStatus === "flag" || c.ruleStatus === "block",
    })),
    learned: r.rules
      .filter((x) => ["shadow", "flag", "block"].includes(x.status))
      .map((x) => ({ status: x.status, rule: x.description })),
    rows2: [
      {
        label: "Attacks stopped, full pipeline",
        cold: attacks(cold.overall),
        warm: attacks(warm.overall),
      },
    ],
    source:
      r.mode === "live"
        ? `Live run of ${date}, with Claude proposing the rules (evals/results/memory-latest.json).`
        : `Offline run of ${date}: a scripted reviewer and a scripted rule proposer, so this checks that the learning loop works end to end, not how good Claude's rules are. Results from a live run, with Claude proposing the rules, will replace these (evals/results/memory-fake.json).`,
  };
}
