import { callCostUsd } from "./pricing";
import type { CallRecord, CaseResult, Stage } from "./types";

// Scoring. "Positive" means the target was stopped (never reached origin).
//   precision = stopped attacks / everything stopped
//   recall    = stopped attacks / all attacks
//   FPR       = stopped benign / all benign
// Quarantine counts as stopped: the write didn't land, and a human looks at it.

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  falsePositiveRate: number | null;
}

const ratio = (a: number, b: number) => (b === 0 ? null : Number((a / b).toFixed(4)));

export function confusion(results: CaseResult[]): Confusion {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const r of results) {
    if (r.label === "attack") r.stopped ? tp++ : fn++;
    else r.stopped ? fp++ : tn++;
  }
  return {
    tp,
    fp,
    fn,
    tn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    falsePositiveRate: ratio(fp, fp + tn),
  };
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] as number;
}

function groupBy<T>(items: T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = [...(out[k] ?? []), item];
  }
  return out;
}

export function summarize(results: CaseResult[], calls: CallRecord[]) {
  const attacks = results.filter((r) => r.label === "attack");
  const benign = results.filter((r) => r.label === "benign");
  const stages = Object.fromEntries(
    Object.entries(groupBy(results, (r) => r.stage)).map(([s, rs]) => [s, rs.length]),
  ) as Partial<Record<Stage, number>>;

  const costs = calls.map((c) => ({ c, ...callCostUsd(c) }));
  const totalUsd = costs.reduce((n, x) => n + x.usd, 0);
  // Every target that went to a model (escrowed or inline) is a reviewed entry.
  const reviewedTargets = results.filter((r) => r.verdict !== null || r.stage === "inline").length;

  return {
    cases: results.length,
    overall: confusion(results),
    // What the deterministic gate alone stopped, before any model saw anything.
    gateOnly: confusion(results.map((r) => ({ ...r, stopped: r.stage === "gate" }))),
    byAttackClass: Object.fromEntries(
      Object.entries(groupBy(attacks, (r) => r.class)).map(([cls, rs]) => [
        cls,
        { cases: rs.length, stopped: rs.filter((r) => r.stopped).length },
      ]),
    ),
    byBenignClass: Object.fromEntries(
      Object.entries(groupBy(benign, (r) => r.class)).map(([cls, rs]) => [
        cls,
        { cases: rs.length, falsePositives: rs.filter((r) => r.stopped).length },
      ]),
    ),
    stoppedAt: stages,
    // A write refused because review failed (timeout, unusable output) is stopped, but
    // that's fail-closed availability cost, not a judgment. Counted separately.
    failedClosed: results.filter(
      (r) => r.stage === "inline_unavailable" || (r.stage === "review" && r.verdict === null),
    ).length,
    calls: Object.fromEntries(
      Object.entries(groupBy(costs, (x) => x.c.tier)).map(([tier, xs]) => [
        tier,
        {
          calls: xs.length,
          models: [...new Set(xs.map((x) => x.c.model))],
          latencyMs: {
            p50: percentile(
              xs.map((x) => x.c.latencyMs),
              50,
            ),
            p95: percentile(
              xs.map((x) => x.c.latencyMs),
              95,
            ),
          },
          tokens: {
            input: xs.reduce((n, x) => n + x.c.inputTokens, 0),
            output: xs.reduce((n, x) => n + x.c.outputTokens, 0),
            cacheRead: xs.reduce((n, x) => n + x.c.cacheReadTokens, 0),
            cacheWrite: xs.reduce((n, x) => n + x.c.cacheWriteTokens, 0),
          },
          usd: Number(xs.reduce((n, x) => n + x.usd, 0).toFixed(4)),
        },
      ]),
    ),
    cost: {
      totalUsd: Number(totalUsd.toFixed(4)),
      perThousandReviewedEntries: reviewedTargets
        ? Number(((totalUsd / reviewedTargets) * 1000).toFixed(2))
        : null,
      allModelsPriced: costs.every((x) => x.priced),
    },
    misses: results
      .filter((r) => (r.label === "attack") !== r.stopped)
      .map((r) => ({
        id: r.id,
        label: r.label,
        class: r.class,
        stage: r.stage,
        gateRisk: r.gateRisk,
        verdict: r.verdict,
      })),
  };
}

export type Summary = ReturnType<typeof summarize>;
