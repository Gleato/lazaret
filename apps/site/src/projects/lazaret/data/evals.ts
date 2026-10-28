import live from "../../../../../../evals/results/live-latest.json";

// The evals panel's numbers, from the latest published live run
// (evals/results/live-latest.json), at build time. The page names the run, its date and
// models, so every figure can be traced back to the file. Nothing here is typed in by
// hand: publishing a new run and rebuilding updates the page.

interface Rates {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
}
interface TierDeclines {
  calls: number;
  declined: number;
  rate: number;
  byCategory: Record<string, number>;
}
interface TierCalls {
  calls: number;
  latencyMs: { p50: number; p95: number };
}

const s = live.summary as unknown as {
  overall: Rates;
  gateOnly: Rates;
  byAttackClass: Record<string, { cases: number; stopped: number }>;
  byBenignClass: Record<string, { cases: number; falsePositives: number }>;
  stoppedAt: Record<string, number>;
  failedClosed: number;
  declines: Record<"inline" | "batch" | "escalation", TierDeclines>;
  calls: Record<"inline" | "batch" | "escalation", TierCalls>;
  cost: { totalUsd: number; perThousandReviewedEntries: number };
  misses: { id: string }[];
};

/** Readable names for the corpus's attack classes. */
const CLASS_NAMES: Record<string, string> = {
  sqli: "SQL injection",
  xss: "Stored XSS",
  downstream_injection: "Prompt injection aimed at the support agent",
  reviewer_injection: "Prompt injection aimed at the reviewer",
  fraud: "Refund fraud",
  mass_assignment: "Mass assignment",
  credential_attack: "Credential stuffing and spraying",
  taint: "Taint (follow-ups to an attack)",
  privilege_escalation: "Privilege escalation",
  spam: "Spam",
  path_traversal: "Path traversal",
  template_injection: "Template injection",
  ssrf: "Server-side request forgery",
  nosql_injection: "NoSQL injection",
  command_injection: "Command injection",
};

/** Where in the pipeline a stopped attack (or a delivered write) ended up, in pipeline order. */
const STAGES: { key: string; label: string }[] = [
  { key: "gate", label: "Gate, before any model call" },
  { key: "inline", label: "Inline review" },
  { key: "inline_unavailable", label: "Inline review unavailable (failed closed)" },
  { key: "review", label: "Batch review" },
  { key: "escalation", label: "Escalation to the stronger model" },
  { key: "taint", label: "Taint" },
];

export const evals = {
  run: {
    file: "evals/results/live-latest.json",
    startedAt: live.startedAt,
    models: live.models,
    cases: live.corpus.cases,
    attacks: live.corpus.attacks,
    benign: live.corpus.benign,
  },
  overall: s.overall,
  gateOnly: s.gateOnly,
  classes: Object.entries(s.byAttackClass)
    .map(([key, v]) => ({ key, name: CLASS_NAMES[key] ?? key, ...v }))
    .sort((a, b) => b.cases - a.cases),
  stages: STAGES.map((st) => ({ ...st, count: s.stoppedAt[st.key] ?? 0 })),
  delivered: s.stoppedAt.delivered ?? 0,
  failedClosed: s.failedClosed,
  declines: (["batch", "escalation", "inline"] as const).map((tier) => ({
    tier,
    ...s.declines[tier],
  })),
  latency: {
    inline: s.calls.inline.latencyMs,
    batch: s.calls.batch.latencyMs,
    escalation: s.calls.escalation.latencyMs,
    ttftP50: live.ttft.p50,
    ttftP95: live.ttft.p95,
    deadlineMs: 3000,
  },
  cost: s.cost,
  /** Honest writes stopped, with where (each is explained on the page, not hidden). */
  honestStopped: (
    live.results as { id: string; label: string; stopped: boolean; stage: string; route: string }[]
  )
    .filter((r) => r.label === "benign" && r.stopped)
    .map((r) => ({ id: r.id, stage: r.stage, route: r.route })),
  /** Inline calls that ran into the deadline (they fail closed). */
  inlinePastDeadline: (live.calls as { tier: string; latencyMs: number }[]).filter(
    (c) => c.tier === "inline" && c.latencyMs >= 3000,
  ).length,
  falsePositives: Object.entries(s.byBenignClass)
    .filter(([, v]) => v.falsePositives > 0)
    .map(([key, v]) => ({ key, ...v })),
};

export type EvalsView = typeof evals;
