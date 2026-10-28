import { describe, expect, it } from "vitest";
import { type BehaviourSample, combineRisk, MemoryBehaviourStore, scoreBehaviour } from "../src";
import { headerSignals } from "../src/gate/behaviour";

const ids = (samples: BehaviourSample[], now: number) =>
  scoreBehaviour(samples, now).map((s) => s.id);

describe("behaviour scoring", () => {
  it("leaves a human-paced session alone", () => {
    const gaps = [0, 2300, 4100, 9800, 11200, 19000, 24500, 31000, 33200];
    const samples = gaps.map((at) => ({ at, method: "GET", path: "/api/tickets" }));
    expect(ids(samples, 33_200)).toEqual([]);
  });

  it("spots an agent: fast, metronomic, enumerating paths", () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({
      at: i * 100,
      method: "GET",
      path: `/api/tickets/${i}`,
    }));
    const signals = scoreBehaviour(samples, 5_900);
    expect(signals.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        "behaviour.rate_high",
        "behaviour.metronomic",
        "behaviour.path_enumeration",
      ]),
    );
    expect(combineRisk(signals.map((s) => s.weight))).toBeGreaterThan(0.7);
  });

  it("spots credential stuffing by its failure ratio", () => {
    const samples = Array.from({ length: 12 }, (_, i) => ({
      at: i * 3_000 + (i % 3) * 700,
      method: "POST",
      path: "/api/login",
      status: i % 6 === 0 ? 200 : 401,
    }));
    expect(ids(samples, 40_000)).toContain("behaviour.failure_flood");
  });

  it("gives weak, non-blocking hints for automation user agents", () => {
    expect(headerSignals({ "user-agent": "curl/8.7.1" })[0]?.weight).toBeLessThan(0.3);
    expect(headerSignals({})[0]?.id).toBe("headers.no_user_agent");
    expect(headerSignals({ "user-agent": "Mozilla/5.0 (Macintosh)" })).toEqual([]);
  });
});

describe("MemoryBehaviourStore", () => {
  it("keeps a sliding window per key", () => {
    const store = new MemoryBehaviourStore(1_000);
    store.record("k", { at: 0, method: "GET", path: "/" });
    store.record("k", { at: 500, method: "GET", path: "/" });
    expect(store.record("k", { at: 1_200, method: "GET", path: "/" }).map((s) => s.at)).toEqual([
      500, 1_200,
    ]);
  });

  it("evicts the least recently used key when full", () => {
    const store = new MemoryBehaviourStore(60_000, 2);
    store.record("a", { at: 1, method: "GET", path: "/" });
    store.record("b", { at: 2, method: "GET", path: "/" });
    store.record("a", { at: 3, method: "GET", path: "/" }); // a is now most recent
    store.record("c", { at: 4, method: "GET", path: "/" }); // evicts b, the oldest
    expect(store.record("a", { at: 5, method: "GET", path: "/" })).toHaveLength(3);
    expect(store.record("b", { at: 6, method: "GET", path: "/" })).toHaveLength(1);
  });
});
