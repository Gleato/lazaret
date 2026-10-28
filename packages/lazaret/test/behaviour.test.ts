import { describe, expect, it } from "vitest";
import { type BehaviourSample, combineRisk, MemoryBehaviourStore, scoreBehaviour } from "../src";
import { headerSignals, scoreRoute } from "../src/gate/behaviour";

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

describe("per-route scoring", () => {
  const keys = (n: number, status?: number): BehaviourSample[] =>
    Array.from({ length: n }, (_, i) => ({
      at: i * 3_000,
      method: "POST",
      path: "/api/keys",
      route: "POST /api/keys",
      ...(status === undefined ? {} : { status }),
    }));
  const weight = (signals: ReturnType<typeof scoreRoute>, id: string) =>
    signals.find((s) => s.id === id)?.weight;

  it("leaves a route alone within its budget, and without one", () => {
    expect(scoreRoute(keys(3), "POST /api/keys", 9_000, 3)).toEqual([]);
    expect(scoreRoute(keys(15), "POST /api/keys", 45_000)).toEqual([]);
  });

  it("raises a burst over the route's budget in tiers, up to an edge block", () => {
    expect(weight(scoreRoute(keys(4), "POST /api/keys", 12_000, 3), "behaviour.route_burst")).toBe(
      0.5,
    );
    expect(weight(scoreRoute(keys(7), "POST /api/keys", 21_000, 3), "behaviour.route_burst")).toBe(
      0.8,
    );
    expect(weight(scoreRoute(keys(13), "POST /api/keys", 39_000, 3), "behaviour.route_burst")).toBe(
      0.95,
    );
  });

  it("only counts the route in question, inside the last minute", () => {
    const other = keys(10).map((s) => ({ ...s, route: "POST /api/tickets" }));
    expect(scoreRoute(other, "POST /api/keys", 30_000, 3)).toEqual([]);
    // 15 keys over 42 s, scored 80 s after the first: only the last 8 are in the window.
    const signals = scoreRoute(keys(15), "POST /api/keys", 80_000, 3);
    expect(signals[0]?.evidence).toMatch(/^8 requests/);
  });

  it("counts 401s and 403s as auth failures, but not other errors", () => {
    expect(scoreRoute(keys(4, 401), "POST /api/keys", 12_000)).toEqual([]);
    expect(
      weight(scoreRoute(keys(5, 401), "POST /api/keys", 15_000), "behaviour.auth_failures"),
    ).toBe(0.5);
    expect(
      weight(scoreRoute(keys(10, 403), "POST /api/keys", 30_000), "behaviour.auth_failures"),
    ).toBe(0.8);
    expect(
      weight(scoreRoute(keys(20, 401), "POST /api/keys", 57_000), "behaviour.auth_failures"),
    ).toBe(0.95);
    expect(scoreRoute(keys(20, 422), "POST /api/keys", 57_000)).toEqual([]);
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
