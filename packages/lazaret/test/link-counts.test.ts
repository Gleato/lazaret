import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compileRule,
  createGateway,
  defineLazaret,
  type EntryState,
  type GateSignal,
  type LazaretConfig,
  type RuleContext,
} from "../src";
import { fakeReviewer, verdict } from "./fakes";
import { allow, entry } from "./helpers";

// Count signals (M11, tasks/todo.md). Linked history let the reviewer see fraud split
// across writes, but the Memory couldn't learn it: its rules read one request. Now the
// hour's linked counts are zero-weight gate signals, so a rule can say "a third refund
// claim from one sender in an hour" in the rule language it already has.

let counter = 0;
const ledger = () => env.LEDGER.get(env.LEDGER.idFromName(`counts-${++counter}`));

async function decided(
  stub: ReturnType<typeof ledger>,
  links: string[],
  route = "POST /api/tickets",
  v = allow,
) {
  const { entryId, batchId } = await stub.append(entry({ links, route }));
  await stub.seal();
  await stub.beginReview(batchId);
  await stub.recordVerdicts(batchId, { [entryId]: v });
  return entryId;
}

describe("signal values in rules", () => {
  const ctx = (signals: GateSignal[]): RuleContext => ({
    method: "POST",
    path: "/api/tickets",
    query: "",
    body: "",
    headers: {},
    json: undefined,
    signals,
  });
  const rule = compileRule({
    id: "r",
    action: "flag",
    weight: 0.6,
    when: { field: "signal:linked.sender_route_1h", op: "gte", value: 2 },
  });

  it("reads a measured signal as its value, not its zero weight", () => {
    const count = (value: number): GateSignal => ({
      source: "behaviour",
      id: "linked.sender_route_1h",
      category: "linked",
      weight: 0,
      value,
    });
    expect(rule.test(ctx([count(2)]))).toBe(true);
    expect(rule.test(ctx([count(1)]))).toBe(false);
    expect(rule.test(ctx([]))).toBe(false);
  });

  it("still reads an ordinary signal as its weight", () => {
    const weighted = compileRule({
      id: "w",
      action: "flag",
      weight: 0.5,
      when: { field: "signal:sqli.union_select", op: "gte", value: 0.5 },
    });
    expect(
      weighted.test(
        ctx([{ source: "signature", id: "sqli.union_select", category: "sqli", weight: 0.8 }]),
      ),
    ).toBe(true);
  });
});

describe("Ledger link counts", () => {
  it("counts the hour's earlier writes on the same route, by sender and by resource", async () => {
    const stub = ledger();
    await decided(stub, ["session:s1"]);
    await decided(stub, ["actor:acct_mara"]); // another login of the same account
    await decided(stub, ["session:s1"], "POST /api/tickets/:id/replies"); // other route
    const shared = "resource:account:acct_theo";
    await decided(stub, ["session:agent-2", shared], "POST /api/accounts/:id/credits");
    await decided(stub, ["session:attacker", shared], "POST /api/accounts/:id/credits", {
      ...allow,
      verdict: "drop",
      category: "fraud",
    });

    const tickets = await stub.getLinkContext(
      ["session:s1", "actor:acct_mara"],
      "POST /api/tickets",
    );
    expect(tickets.counts).toEqual({ senderRoute: 2, resourceRoute: 0, heldSender: 0 });
    expect(tickets.history).toEqual([]); // only asked for counts
    // Others' writes on a shared resource count only if allowed, as in the history.
    const credits = await stub.getLinkContext(
      ["session:agent-9", shared],
      "POST /api/accounts/:id/credits",
    );
    expect(credits.counts).toEqual({ senderRoute: 0, resourceRoute: 1, heldSender: 0 });
  });

  it("forgets writes older than an hour", async () => {
    const stub = ledger();
    await decided(stub, ["session:s1"]);
    await runInDurableObject(stub, (_i, ctx) => {
      ctx.storage.sql.exec("UPDATE linked_writes SET at = at - ?", 61 * 60_000);
    });
    const { counts } = await stub.getLinkContext(["session:s1"], "POST /api/tickets");
    expect(counts.senderRoute).toBe(0);
  });
});

describe("Gateway count signals", () => {
  const origin = vi.fn();
  beforeEach(() => {
    origin.mockReset();
    origin.mockImplementation(async (req: Request) =>
      new URL(req.url).pathname.endsWith("/api/me")
        ? Response.json({ account: { id: "acct_mara", role: "customer" } })
        : Response.json({ ok: true }, { status: 201 }),
    );
  });

  function setup(
    overrides: Partial<LazaretConfig> = {},
    reviewer = fakeReviewer(() => verdict("allow", 0.96)).reviewer,
  ) {
    const shard = `counts-gw-${++counter}`;
    const config = defineLazaret({
      origin: "https://origin.test",
      ledger: { binding: "LEDGER", shard },
      session: { header: "authorization" },
      routes: [
        { match: "POST /api/tickets", policy: "ESCROW", resources: ["ticket:{receipt}"] },
        { match: "POST /api/login", policy: "INLINE_REVIEW", onReviewUnavailable: "gate" },
      ],
      review: { actor: { path: "/api/me", fields: { id: "account.id" } } },
      link: {},
      ...overrides,
    });
    const gateway = createGateway(config, { fetchOrigin: origin, reviewer });
    const stub = env.LEDGER.get(env.LEDGER.idFromName(shard));
    const post = (path: string, body: unknown, token = "mara-1") =>
      gateway.fetch(
        new Request(`https://edge.test${path}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "user-agent": "Mozilla/5.0 (test)",
            "cf-connecting-ip": "203.0.113.9",
          },
        }),
        env,
      );
    return { stub, post, gateway };
  }

  /** Settle every open batch with an allow, as review would. */
  async function reviewAll(stub: ReturnType<typeof ledger>) {
    const batchId = await stub.seal();
    if (!batchId) return;
    const state = await stub.getState();
    await stub.beginReview(batchId);
    const ids = state.batches[batchId]?.entryIds ?? [];
    await stub.recordVerdicts(batchId, Object.fromEntries(ids.map((id) => [id, allow])));
  }

  it("gives a third claim from one account a count signal of 2, at zero weight", async () => {
    const { stub, post } = setup();
    await post("/api/tickets", { body: "refund $49" });
    await reviewAll(stub);
    await post("/api/tickets", { body: "refund $48" }, "mara-2"); // a new sign-in
    await reviewAll(stub);
    const res = await post("/api/tickets", { body: "refund $47" }, "mara-3");
    expect(res.headers.get("server-timing")).toMatch(/links;dur=\d+/);
    const { receipt } = (await res.json()) as { receipt: string };
    const third = (await stub.getState()).entries[receipt] as EntryState;
    const count = third.signals.find((s) => s.id === "linked.sender_route_1h");
    expect(count).toMatchObject({ weight: 0, value: 2 });
    expect(third.riskScore).toBe(0); // measurements never move risk
  });

  it("adds no count signals to a first write, or when linking is off", async () => {
    const on = setup();
    const first = (await (await on.post("/api/tickets", { body: "hi" })).json()) as {
      receipt: string;
    };
    expect((await on.stub.getState()).entries[first.receipt]?.signals).toEqual([]);

    const off = setup({ link: undefined });
    const res = await off.post("/api/tickets", { body: "hi" });
    expect(res.headers.get("server-timing") ?? "").not.toMatch(/links/);
  });

  it("doesn't link writes that have no session, so one address isn't one sender", async () => {
    origin.mockImplementation(async (req: Request) =>
      new URL(req.url).pathname.endsWith("/api/me")
        ? Response.json({ error: "login required" }, { status: 401 })
        : Response.json({ ok: true }, { status: 201 }),
    );
    const { gateway } = setup();
    const login = () =>
      gateway.fetch(
        new Request("https://edge.test/api/login", {
          method: "POST",
          body: JSON.stringify({ email: "mara@tidewater.test", password: "x" }),
          headers: {
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0 (test)",
            "cf-connecting-ip": "203.0.113.9",
          },
        }),
        env,
      );
    await login();
    const res = await login();
    // No `links` timing: the lookup never ran, so no history or count reached the reviewer.
    expect(res.headers.get("server-timing") ?? "").not.toMatch(/links/);
  });

  it("still lets a repeat login through on the gate alone when the reviewer is down", async () => {
    const down = fakeReviewer(
      () => verdict("allow"),
      () => new Error("reviewer down"),
    ).reviewer;
    const { post, stub } = setup({}, down);
    // Logins are decided inline; record two (after the response, as waitUntil would),
    // so the third carries a count signal of 2.
    await post("/api/login", { email: "mara@tidewater.test", password: "x" });
    await post("/api/login", { email: "mara@tidewater.test", password: "x" });
    await vi.waitFor(async () => {
      const { counts } = await stub.getLinkContext(
        ["session:x", "actor:acct_mara"],
        "POST /api/login",
      );
      expect(counts.senderRoute).toBe(2);
    });
    const res = await post("/api/login", { email: "mara@tidewater.test", password: "x" });
    // Before M11's fix, the zero-weight count made the gate's view "not spotless", and
    // this login failed closed (503) during a reviewer outage.
    expect(res.status).toBe(201);
    expect(res.headers.get("x-lazaret-review")).toBe("degraded");
  });
});
