import { describe, expect, it } from "vitest";
import { columnPath, niceMax, plot, VIEW } from "../src/lib/curve";
import { type CampaignResult, toCurveView } from "../src/projects/lazaret/data/memory";

// The Memory panel's learning curve (M7.1): chart geometry and the campaign view.

describe("learning-curve geometry", () => {
  it("rounds the axis up to a clean maximum", () => {
    expect([niceMax(0), niceMax(0.6), niceMax(283), niceMax(365), niceMax(1)]).toEqual([
      1, 1, 500, 500, 1,
    ]);
  });

  it("places points on one axis, and skips missing values in the line", () => {
    const p = plot(
      [
        { x: 1, label: "1", value: 100, display: "100" },
        { x: 2, label: "2", value: null, display: "n/a" },
        { x: 3, label: "3", value: 0, display: "0" },
      ],
      200,
      String,
    );
    expect(p.ticks.map((t) => t.label)).toEqual(["0", "100", "200"]);
    expect(p.marks[0]?.cy).toBeCloseTo(VIEW.top + (VIEW.h - VIEW.top - VIEW.bottom) / 2);
    expect(p.path.split(" ").filter((s) => /^[ML]/.test(s))).toHaveLength(2);
  });

  it("draws columns no wider than 24px, and nothing for a zero", () => {
    expect(columnPath(50, 100, 100, 80)).toBe("");
    const d = columnPath(50, 40, 100, 80);
    expect(d.startsWith("M38.0,100.0")).toBe(true); // 24px wide, centred on 50
  });
});

const run = (mode: "fake" | "live"): CampaignResult => ({
  mode,
  startedAt: "2026-10-29T03:00:00Z",
  config: { windows: 2, casesPerWindow: 50, attackShare: 0.3, operatorDelayWindows: 1 },
  families: { train: ["a"], heldOut: ["b", "c"] },
  baselineProbe: { heldOutGateRecall: 0 },
  cost: { totalUsd: 1.234 },
  windows: [1, 2].map((window) => ({
    window,
    writes: 52,
    attacks: 15,
    benign: 35,
    recall: window === 1 ? 0.8 : 1,
    falsePositiveRate: 0,
    modelCallsPer1k: window === 1 ? 365 : 283,
    usdPer1k: 3.1,
    gateShareOfStops: window === 1 ? 0 : 0.5,
    stops: 12,
    gateStops: window === 1 ? 0 : 6,
    promotions: (window === 1 ? { shadow: 2 } : { block: 1 }) as Record<string, number>,
    probe: { heldOutGateRecall: window === 1 ? 0 : 0.25, trainGateRecall: 0.4 },
  })),
});

describe("campaign view", () => {
  it("says what happened, and labels the simulated parts", () => {
    const v = toCurveView(run("fake"));
    expect(v?.summary).toContain("from 365 to 283");
    expect(v?.charts.map((c) => c.id)).toEqual(["calls", "gate", "heldout"]);
    expect(v?.charts[2]?.points[0]?.label).toBe("0"); // the before-training baseline
    expect(v?.caveats.join(" ")).toMatch(/simulated operator/);
    expect(v?.caveats.join(" ")).toMatch(/keyword reviewer/);
    expect(v?.table.head).not.toContain("Cost per 1,000");
    expect(v?.table.rows[1]).toContain("1 to block");
  });

  it("shows cost per 1,000 writes and the spend only for a live run", () => {
    const v = toCurveView(run("live"));
    expect(v?.table.head).toContain("Cost per 1,000");
    expect(v?.source).toContain("$1.23");
    expect(v?.caveats.join(" ")).not.toMatch(/keyword reviewer/);
    // Cost per 1,000 rose (3.1 → 3.1 is "did not fall"), and the held-out line rose.
    expect(v?.summary).toMatch(/did not fall/);
    expect(v?.summary).not.toMatch(/held out of training/);
  });

  it("says so when learning didn't reach held-out families", () => {
    const r = run("live");
    for (const w of r.windows) w.probe.heldOutGateRecall = 0;
    expect(toCurveView(r)?.summary).toMatch(/did not stop any attack family held out/);
  });

  it("renders nothing when no campaign has been published", () => {
    expect(toCurveView(undefined)).toBeNull();
  });
});
