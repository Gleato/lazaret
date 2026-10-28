import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createGateway, defineLazaret, type VerdictRecord } from "../src";
import { fakeOrigin, verdict } from "./fakes";
import { entry } from "./helpers";

// The human review queue (M6.7): the only way out of QUARANTINED. Driven through the
// real gateway, a real Ledger and a real Memory, with a fake origin that verifies
// signatures like a real one.

const TOKEN = "operator-token-0123456789abcdef";
let counter = 0;

async function setup({ token = TOKEN as string | null } = {}) {
  const shard = `operator-${++counter}`;
  const config = defineLazaret({
    origin: "https://origin.test",
    ledger: { binding: "LEDGER", shard },
    memory: { binding: "MEMORY", name: shard },
    routes: [],
  });
  const origin = fakeOrigin(201);
  const gateway = createGateway(config, { fetchOrigin: origin.fetchOrigin });
  const ledger = env.LEDGER.get(env.LEDGER.idFromName(shard));
  const memory = env.MEMORY.get(env.MEMORY.idFromName(shard));
  const testEnv = token === null ? env : { ...env, LAZARET_OPERATOR_TOKEN: token };
  const call = (path: string, init: RequestInit = {}, auth = `Bearer ${TOKEN}`) =>
    gateway.fetch(
      new Request(`https://edge.test/__lazaret/operator/${path}`, {
        ...init,
        headers: { authorization: auth, "x-lazaret-operator": "ridge", ...init.headers },
      }),
      testEnv,
    );
  const act = (id: string, action: string, extra: Record<string, unknown> = {}) =>
    call(`entries/${id}`, {
      method: "POST",
      body: JSON.stringify({ action, ...extra }),
      headers: { "content-type": "application/json" },
    });

  /** Run one batch by hand: append, seal, record verdicts, commit the allowed, settle. */
  async function reviewed(specs: { resources: string[]; v: VerdictRecord; body?: string }[]) {
    const receipts = [];
    for (const s of specs) {
      receipts.push(
        await ledger.append(
          entry({
            resources: s.resources,
            request: { ...entry().request, body: JSON.stringify({ body: s.body ?? "hi" }) },
          }),
        ),
      );
    }
    const batchId = receipts[0]?.batchId as string;
    await ledger.seal();
    await ledger.beginReview(batchId);
    await ledger.recordVerdicts(
      batchId,
      Object.fromEntries(receipts.map((r, i) => [r.entryId, specs[i]?.v as VerdictRecord])),
    );
    await ledger.beginCommit(batchId);
    for (const e of await ledger.getCommitPlan(batchId)) await ledger.markCommitted(e.id, 201);
    await ledger.settle(batchId);
    return receipts.map((r) => r.entryId);
  }
  return { call, act, ledger, memory, origin, reviewed };
}

describe("operator queue", () => {
  it("doesn't exist without a token, and refuses a wrong one", async () => {
    expect((await (await setup({ token: null })).call("queue")).status).toBe(404);
    const { call } = await setup();
    expect((await call("queue", {}, "Bearer wrong-token")).status).toBe(401);
    expect((await call("queue", {}, "")).status).toBe(401);
  });

  it("lists held entries without credentials, oldest first", async () => {
    const { call, reviewed } = await setup();
    const [held] = await reviewed([
      { resources: ["ticket:1"], v: verdict("quarantine", 0.6, "uncertain") },
      { resources: ["ticket:2"], v: verdict("allow") },
    ]);
    const res = await call("queue");
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: Record<string, unknown>[] };
    expect(entries.map((e) => e.id)).toEqual([held]);
    expect(JSON.stringify(entries)).not.toMatch(/authorization|cookie/i);
  });

  it("releases a held write to origin, signed, with its idempotency key", async () => {
    const { act, ledger, origin, reviewed } = await setup();
    const [held] = (await reviewed([
      { resources: ["ticket:1"], v: verdict("quarantine", 0.6, "uncertain") },
    ])) as [string];
    const res = await act(held, "release", { note: "real customer" });
    expect(await res.json()).toMatchObject({ status: "committed", originStatus: 201 });
    expect(origin.received).toHaveLength(1);
    expect(origin.received[0]).toMatchObject({ verified: true, idempotencyKey: held });
    expect((await ledger.getState()).entries[held]).toMatchObject({
      status: "COMMITTED",
      resolution: { decision: "release", operator: "ridge", note: "real customer" },
    });
    // Repeating the decision is a no-op success, not a second delivery.
    expect((await act(held, "release")).status).toBe(200);
  });

  it("refuses to release a write while the held write it depends on is still held", async () => {
    const { act, ledger, reviewed } = await setup();
    // The reply was allowed, but taint holds it with its held parent ticket.
    const [parent, child] = (await reviewed([
      { resources: ["ticket:7"], v: verdict("quarantine", 0.6, "uncertain") },
      { resources: ["ticket:7"], v: verdict("allow") },
    ])) as [string, string];
    expect((await ledger.getState()).entries[child]?.status).toBe("QUARANTINED");

    const refused = await act(child, "release");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: `release held entry ${parent} first` });
    expect((await act(parent, "release")).status).toBe(200);
    expect((await act(child, "release")).status).toBe(200);
  });

  it("drops a held write with its held dependents, and flags the session", async () => {
    const { act, ledger, reviewed } = await setup();
    const [parent, child, other] = (await reviewed([
      { resources: ["ticket:7"], v: verdict("quarantine", 0.6, "uncertain") },
      { resources: ["ticket:7"], v: verdict("allow") },
      { resources: ["ticket:8"], v: verdict("quarantine", 0.6, "uncertain") },
    ])) as [string, string, string];
    const res = await act(parent, "drop", { category: "xss" });
    expect(await res.json()).toMatchObject({ cascaded: [child] });
    const state = await ledger.getState();
    expect(state.entries[parent]?.status).toBe("DROPPED");
    expect(state.entries[child]).toMatchObject({
      status: "DROPPED",
      resolution: { decision: "drop" },
    });
    expect(state.entries[other]?.status).toBe("QUARANTINED"); // unrelated: untouched
    expect(Object.keys(state.flaggedSessions)).toContain("session-a");
  });

  it("labels decisions into the Memory as ground truth, so a reviewer miss becomes a lesson", async () => {
    const { act, memory, reviewed } = await setup();
    // The reviewer allowed a write that was in fact an attack (eval sqli-06, run 5).
    const [missed] = (await reviewed([
      { resources: ["account:me"], v: verdict("allow", 0.8), body: "%27 OR 1=1 --" },
    ])) as [string];
    const res = await act(missed, "report", { category: "sqli", note: "tautology probe" });
    expect(res.status).toBe(200);
    // Labelling runs off the response path; give it a moment to land.
    await new Promise((r) => setTimeout(r, 50));
    const input = await (
      memory as unknown as {
        getDistillInput(): Promise<{ drops: { entryId: string; category: string }[] }>;
      }
    ).getDistillInput();
    expect(input.drops).toContainEqual(
      expect.objectContaining({ entryId: missed, category: "sqli" }),
    );
  });

  it("only reports committed writes, and only resolves held ones", async () => {
    const { act, reviewed } = await setup();
    const [held, allowed] = (await reviewed([
      { resources: ["ticket:1"], v: verdict("quarantine", 0.6, "uncertain") },
      { resources: ["ticket:2"], v: verdict("allow") },
    ])) as [string, string];
    expect((await act(held, "report")).status).toBe(409);
    expect((await act(allowed, "drop")).status).toBe(409);
    expect((await act("nope", "drop")).status).toBe(404);
    expect((await act(held, "approve")).status).toBe(400);
  });
});
