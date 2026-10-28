import { describe, expect, it } from "vitest";
import { DEFAULT_CYCLE } from "../src";
import { sealDeadline, sealReasonAfterAppend, validateCycleConfig } from "../src/ledger/triggers";

const cfg = { intervalSec: 30, maxEntries: 3, riskSpikeThreshold: 0.8 };

describe("cycle triggers", () => {
  it("seals on a risk spike even when the batch is small", () => {
    expect(sealReasonAfterAppend(1, 0.8, cfg)).toBe("risk");
  });

  it("seals on size once the cap is reached", () => {
    expect(sealReasonAfterAppend(2, 0.1, cfg)).toBeNull();
    expect(sealReasonAfterAppend(3, 0.1, cfg)).toBe("size");
  });

  it("prefers risk over size so the reason reflects the attack", () => {
    expect(sealReasonAfterAppend(3, 0.95, cfg)).toBe("risk");
  });

  it("computes the timer deadline from when the batch opened", () => {
    expect(sealDeadline(1_000, cfg)).toBe(31_000);
  });

  it("accepts the defaults and rejects nonsense configs", () => {
    expect(validateCycleConfig(DEFAULT_CYCLE)).toBe(DEFAULT_CYCLE);
    expect(() => validateCycleConfig({ ...cfg, intervalSec: 0 })).toThrow(RangeError);
    expect(() => validateCycleConfig({ ...cfg, maxEntries: 1.5 })).toThrow(RangeError);
    expect(() => validateCycleConfig({ ...cfg, riskSpikeThreshold: 0 })).toThrow(RangeError);
  });
});
