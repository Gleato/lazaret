import { describe, expect, it } from "vitest";
import {
  backtest,
  compileRule,
  type RuleSample,
  statusAfterBacktest,
  statusAfterLiveEvidence,
  DEFAULT_MEMORY_THRESHOLDS as T,
} from "../src";

const sample = (body: string): RuleSample => ({
  method: "POST",
  path: "/api/tickets",
  query: "",
  body,
  headers: {},
  json: undefined,
  signals: [],
});
const rule = compileRule({
  id: "r",
  action: "flag",
  weight: 0.6,
  when: { field: "body", op: "contains", value: "acct-" },
});

describe("memory lifecycle", () => {
  it("backtests support and false positives", () => {
    expect(
      backtest(rule, [sample("pay acct-1"), sample("pay acct-2"), sample("hi")], [sample("hello")]),
    ).toEqual({
      support: 2,
      falsePositives: 0,
      cleanSamples: 1,
    });
  });

  it.each([
    [{ support: 5, falsePositives: 1, cleanSamples: 100 }, "rejected"],
    [{ support: 1, falsePositives: 0, cleanSamples: 100 }, "rejected"],
    [{ support: 5, falsePositives: 0, cleanSamples: 3 }, "pending"],
    [{ support: 5, falsePositives: 0, cleanSamples: 100 }, "shadow"],
  ] as const)("judges backtest %o as %s", (result, status) => {
    expect(statusAfterBacktest(result, T).status).toBe(status);
  });

  const live = { liveTruePositives: 0, liveFalsePositives: 0, lastHitAt: 1_000, updatedAt: 1_000 };

  it("earns trust slowly: shadow → flag → block on confirmed hits", () => {
    expect(
      statusAfterLiveEvidence({ ...live, status: "shadow", liveTruePositives: 2 }, T, 2_000),
    ).toBeNull();
    expect(
      statusAfterLiveEvidence({ ...live, status: "shadow", liveTruePositives: 3 }, T, 2_000)
        ?.status,
    ).toBe("flag");
    expect(
      statusAfterLiveEvidence({ ...live, status: "flag", liveTruePositives: 9 }, T, 2_000),
    ).toBeNull();
    expect(
      statusAfterLiveEvidence({ ...live, status: "flag", liveTruePositives: 10 }, T, 2_000)?.status,
    ).toBe("block");
  });

  it("loses trust at once: one false positive retires even a block rule", () => {
    expect(
      statusAfterLiveEvidence(
        { ...live, status: "block", liveTruePositives: 50, liveFalsePositives: 1 },
        T,
        2_000,
      )?.status,
    ).toBe("retired");
  });

  it("retires stale rules and ignores inactive ones", () => {
    expect(
      statusAfterLiveEvidence({ ...live, status: "flag" }, T, 1_000 + T.staleAfterMs + 1)?.status,
    ).toBe("retired");
    expect(
      statusAfterLiveEvidence({ ...live, status: "rejected", liveFalsePositives: 3 }, T, 2_000),
    ).toBeNull();
  });
});
