import { describe, expect, it } from "vitest";
import {
  backtest,
  compileRule,
  pendingExpired,
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
      disputed: 0,
      cleanSamples: 1,
    });
  });

  it("counts a match on an untrusted allow as a dispute, not a false positive", () => {
    expect(backtest(rule, [], [sample("hello")], [sample("acct-9"), sample("hi")])).toEqual({
      support: 0,
      falsePositives: 0,
      disputed: 1,
      cleanSamples: 3,
    });
  });

  // M7.1: only a false positive on trusted traffic is final; thin evidence waits.
  it.each([
    [{ support: 5, falsePositives: 1, disputed: 0, cleanSamples: 100 }, "rejected"],
    [{ support: 5, falsePositives: 1, disputed: 3, cleanSamples: 100 }, "rejected"],
    [{ support: 5, falsePositives: 0, disputed: 1, cleanSamples: 100 }, "pending"],
    [{ support: 1, falsePositives: 0, disputed: 0, cleanSamples: 100 }, "pending"],
    [{ support: 0, falsePositives: 0, disputed: 0, cleanSamples: 100 }, "pending"],
    [{ support: 5, falsePositives: 0, disputed: 0, cleanSamples: 3 }, "pending"],
    [{ support: 5, falsePositives: 0, disputed: 0, cleanSamples: 100 }, "shadow"],
  ] as const)("judges backtest %o as %s", (result, status) => {
    expect(statusAfterBacktest(result, T).status).toBe(status);
  });

  it("expires a pending rule after the staleness window, and only pending ones", () => {
    expect(pendingExpired({ status: "pending", createdAt: 0 }, T, T.staleAfterMs)).toBe(false);
    expect(pendingExpired({ status: "pending", createdAt: 0 }, T, T.staleAfterMs + 1)).toBe(true);
    expect(pendingExpired({ status: "shadow", createdAt: 0 }, T, T.staleAfterMs + 1)).toBe(false);
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

  it("holds promotion while a live hit is disputed, but still retires on a false positive", () => {
    const shadow = { ...live, status: "shadow" as const, liveTruePositives: 5 };
    expect(statusAfterLiveEvidence(shadow, T, 2_000, 1)).toBeNull();
    expect(statusAfterLiveEvidence(shadow, T, 2_000, 0)?.status).toBe("flag");
    expect(statusAfterLiveEvidence({ ...shadow, liveFalsePositives: 1 }, T, 2_000, 1)?.status).toBe(
      "retired",
    );
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
