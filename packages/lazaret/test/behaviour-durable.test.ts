import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  type BehaviourSample,
  createGateway,
  DurableBehaviourStore,
  defineLazaret,
  type LazaretConfig,
  LazaretConfigError,
} from "../src";
import { fakeReviewer, promptEntries, verdict } from "./fakes";

// The Durable Object behaviour store (M8, src/gate/behaviour-durable.ts). The claims:
// two isolates see one count, so a credential-stuffing run spread across isolates is
// scored as if it hit one; and the gate never waits for the Durable Object, so a slow
// or failing one costs the request nothing.

let n = 0;
const uniqueIp = () => `198.51.100.${++n}`;

/** Collects waitUntil work, so a test can let it land before the next request. */
function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, drain: () => Promise.all(pending.splice(0)) };
}

/**
 * Two gateways built from the same config stand in for two isolates: each has its own
 * memory store, as two isolates would. Requests alternate between them.
 */
function twoIsolates(behaviour: LazaretConfig["behaviour"]) {
  const origin = vi.fn(async () => Response.json({ error: "bad" }, { status: 401 }));
  const { reviewer, calls } = fakeReviewer(() => verdict("allow", 0.96));
  const config = defineLazaret({
    origin: "https://origin.test",
    ledger: { binding: "LEDGER", shard: `behaviour-${++n}` },
    routes: [{ match: "POST /api/login", policy: "INLINE_REVIEW" }],
    ...(behaviour ? { behaviour } : {}),
  });
  // One irregular clock for both, so only the per-route signals fire (not metronomic).
  let t = 3_000_000;
  let tick = 0;
  const now = () => (t += 300 + (tick++ % 3) * 150);
  const gateways = [0, 1].map(() => createGateway(config, { fetchOrigin: origin, reviewer, now }));
  const ip = uniqueIp();
  const { ctx, drain } = fakeCtx();
  const login = async (i: number) => {
    const res = await (gateways[i % 2] as (typeof gateways)[number]).fetch(
      new Request("https://edge.test/api/login", {
        method: "POST",
        body: JSON.stringify({ user: `u${i}@example.com`, password: "x" }),
        headers: {
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 (test)",
          "cf-connecting-ip": ip,
        },
      }),
      env,
      ctx,
    );
    await drain();
    return res.status;
  };
  const signals = (call: number) =>
    (
      promptEntries(calls[call]?.prompt ?? "")[0] as unknown as {
        gate: { signals: { id: string }[] };
      }
    ).gate.signals.map((s) => s.id);
  return { login, signals };
}

describe("durable behaviour store", () => {
  it("sees failed logins across isolates as one count; the memory store splits them", async () => {
    const durable = twoIsolates({ store: "durable" });
    const memory = twoIsolates(undefined);
    for (let i = 0; i < 8; i++) {
      expect(await durable.login(i)).toBe(401);
      expect(await memory.login(i)).toBe(401);
    }
    const tripped = (iso: typeof durable) =>
      [...Array(8).keys()].find((i) => iso.signals(i).includes("behaviour.auth_failures"));
    // 5 refusals trip the signal. One shared window sees them by the 6th login, or the
    // 7th, since the shared view lags one request per isolate. Two isolate windows see
    // at most 3 each in 8 logins, and never trip.
    expect(tripped(durable)).toBeLessThanOrEqual(6);
    expect(tripped(memory)).toBeUndefined();
  });

  it("reports the behaviour lookup's cost as Server-Timing, with no wait on I/O", async () => {
    const config = defineLazaret({
      origin: "https://origin.test",
      ledger: { binding: "LEDGER", shard: `timing-${++n}` },
      routes: [{ match: "GET /api/*", policy: "PASS" }],
      behaviour: { store: "durable" },
    });
    const gateway = createGateway(config, { fetchOrigin: async () => Response.json({}) });
    const { ctx, drain } = fakeCtx();
    const res = await gateway.fetch(
      new Request("https://edge.test/api/tickets", { headers: { "cf-connecting-ip": uniqueIp() } }),
      env,
      ctx,
    );
    await drain();
    // Local workerd's clock is precise, so allow the CPU the merge takes; deployed,
    // Workers' clock only moves on I/O and this reads 0.
    const dur = Number(/^behaviour;dur=(\d+)$/.exec(res.headers.get("server-timing") ?? "")?.[1]);
    expect(dur).toBeLessThanOrEqual(5);
  });

  it("adds no wait to the request, even when the Durable Object hangs", async () => {
    const hang = { record: () => new Promise(() => {}), setStatus: async () => {} };
    const slowEnv = { SLOW: { idFromName: (k: string) => k, get: () => hang } };
    const store = new DurableBehaviourStore({ binding: "SLOW" });
    const sample = (at: number): BehaviourSample => ({ at, method: "GET", path: "/" });
    store.record("k", sample(1), slowEnv);
    // Synchronous: the gate never awaits the shared view.
    expect(store.record("k", sample(2), slowEnv).map((s) => s.at)).toEqual([1, 2]);
  });

  it("merges the shared window into the next request's view, without duplicates", async () => {
    const shared: BehaviourSample[] = [];
    const stub = {
      record: async (s: BehaviourSample) => {
        shared.push({ ...s });
        return [{ id: "other-isolate", at: 5, method: "POST", path: "/x", status: 401 }, ...shared];
      },
      setStatus: async () => {},
    };
    const fakeEnv = { B: { idFromName: (k: string) => k, get: () => stub } };
    const store = new DurableBehaviourStore({ binding: "B" });
    const work: Promise<unknown>[] = [];
    const bg = (p: Promise<unknown>) => void work.push(p);
    const first = store.record("k", { at: 10, method: "GET", path: "/" }, fakeEnv, bg);
    expect(first.map((s) => s.at)).toEqual([10]); // nothing shared yet
    await Promise.all(work);
    const second = store.record("k", { at: 20, method: "GET", path: "/" }, fakeEnv, bg);
    expect(second.map((s) => s.id === "other-isolate" || s.at)).toEqual([true, 10, 20]);
  });

  it("logs and carries on when the Durable Object fails or the binding is missing", async () => {
    const broken = {
      record: async () => {
        throw new Error("overloaded");
      },
      setStatus: async () => {},
    };
    const brokenEnv = { B: { idFromName: (k: string) => k, get: () => broken } };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const work: Promise<unknown>[] = [];
    const store = new DurableBehaviourStore({ binding: "B" });
    expect(
      store.record("k", { at: 1, method: "GET", path: "/" }, brokenEnv, (p) => void work.push(p)),
    ).toHaveLength(1);
    await Promise.all(work); // the failure is caught, never an unhandled rejection
    const unbound = new DurableBehaviourStore({ binding: "NOPE" });
    expect(unbound.record("k", { at: 1, method: "GET", path: "/" }, {})).toHaveLength(1);
    expect(errors).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it("piggybacks a status whose own send failed on the key's next sync", async () => {
    const received: unknown[][] = [];
    const stub = {
      record: async (_s: BehaviourSample, statuses: unknown[]) => {
        received.push(statuses);
        return [];
      },
      setStatus: async () => {
        throw new Error("lost");
      },
    };
    const fakeEnv = { B: { idFromName: (k: string) => k, get: () => stub } };
    const store = new DurableBehaviourStore({ binding: "B" });
    const work: Promise<unknown>[] = [];
    const bg = (p: Promise<unknown>) => void work.push(p);
    const first: BehaviourSample = { at: 1, method: "POST", path: "/api/login" };
    store.record("k", first, fakeEnv, bg);
    first.status = 401;
    await store.settle(["k"], first, fakeEnv);
    store.record("k", { at: 2, method: "POST", path: "/api/login" }, fakeEnv, bg);
    await Promise.all(work);
    store.record("k", { at: 3, method: "POST", path: "/api/login" }, fakeEnv, bg);
    await Promise.all(work);
    expect(received).toEqual([[], [{ id: first.id, status: 401 }], []]); // sent once, then cleared
  });

  it("ages samples out by the caller's clock and records a repeated id once", async () => {
    const stub = env.LAZARET_BEHAVIOUR.get(env.LAZARET_BEHAVIOUR.idFromName(`ip:${uniqueIp()}`));
    const s = (id: string, at: number): BehaviourSample => ({ id, at, method: "GET", path: "/" });
    await stub.record(s("a", 1_000));
    await stub.record(s("b", 2_000));
    await stub.setStatus({ id: "b", status: 401 });
    const window = await stub.record(s("c", 3_000));
    expect(window.map((x) => [x.id, x.status])).toEqual([
      ["a", undefined],
      ["b", 401],
      ["c", undefined],
    ]);
    // 60 s later, a and b have left the window.
    expect((await stub.record(s("d", 62_500))).map((x) => x.id)).toEqual(["c", "d"]);
    expect((await stub.record(s("d", 62_500))).map((x) => x.id)).toEqual(["c", "d"]);
  });

  it("validates its config", () => {
    const base = { origin: "https://o.test", routes: [] };
    expect(defineLazaret(base).behaviour).toEqual({
      store: "memory",
      binding: "LAZARET_BEHAVIOUR",
    });
    expect(() =>
      defineLazaret({ ...base, behaviour: { store: "redis" as unknown as "memory" } }),
    ).toThrow(LazaretConfigError);
  });
});
