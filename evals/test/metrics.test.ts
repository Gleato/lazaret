import { describe, expect, it } from "vitest";
import { confusion, percentile, summarize } from "../src/metrics";
import { callCostUsd } from "../src/pricing";
import type { CallRecord, CaseResult } from "../src/types";

const result = (
  label: "attack" | "benign",
  stopped: boolean,
  extra: Partial<CaseResult> = {},
): CaseResult => ({
  id: `${label}-${Math.random()}`,
  label,
  class: label === "attack" ? "xss" : "ticket",
  route: "POST /api/tickets",
  status: 202,
  stopped,
  stage: stopped ? "review" : "delivered",
  gateRisk: 0,
  signals: [],
  verdict: null,
  ...extra,
});

const call = (extra: Partial<CallRecord> = {}): CallRecord => ({
  tier: "batch",
  model: "claude-sonnet-5-5",
  latencyMs: 1000,
  outcome: "output",
  entries: 10,
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...extra,
});

describe("metrics", () => {
  it("computes precision, recall and FPR with stopped as the positive class", () => {
    const c = confusion([
      result("attack", true),
      result("attack", true),
      result("attack", false),
      result("benign", true),
      result("benign", false),
      result("benign", false),
      result("benign", false),
    ]);
    expect(c).toEqual({
      tp: 2,
      fp: 1,
      fn: 1,
      tn: 3,
      precision: 0.6667,
      recall: 0.6667,
      falsePositiveRate: 0.25,
    });
  });

  it("returns null instead of dividing by zero", () => {
    expect(confusion([]).precision).toBeNull();
  });

  it("uses nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });

  it("prices calls from token usage, including cache reads and writes", () => {
    expect(callCostUsd(call()).usd).toBeCloseTo(2);
    expect(callCostUsd(call({ inputTokens: 0, outputTokens: 1_000_000 })).usd).toBeCloseTo(10);
    expect(
      callCostUsd(call({ inputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }))
        .usd,
    ).toBeCloseTo(0.2 + 2.5);
    // An unknown model (e.g. a fallback) prices high, as Opus, and is flagged.
    expect(callCostUsd(call({ model: "claude-mystery" }))).toEqual({ usd: 4, priced: false });
  });

  it("separates what the gate alone stopped from the full pipeline, and lists misses", () => {
    const s = summarize(
      [
        result("attack", true, { stage: "gate" }),
        result("attack", true, { stage: "review" }),
        result("attack", false, { id: "missed" }),
        result("benign", true, { id: "fp", class: "hard_negative" }),
      ],
      [call(), call({ tier: "inline", model: "claude-haiku-5-5", latencyMs: 300 })],
    );
    expect(s.gateOnly.tp).toBe(1);
    expect(s.overall.tp).toBe(2);
    expect(s.misses.map((m) => m.id).sort()).toEqual(["fp", "missed"]);
    expect(s.byBenignClass.hard_negative).toEqual({ cases: 1, falsePositives: 1 });
    expect(s.calls.inline?.latencyMs.p50).toBe(300);
    expect(s.cost.totalUsd).toBeCloseTo(2.1);
  });
});
