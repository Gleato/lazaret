import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compileRule,
  createCommitter,
  createGateway,
  decide,
  defineLazaret,
  type LazaretConfig,
  type LedgerPort,
  type MemoryPort,
  type Rule,
  runReviewPipeline,
} from "../src";
import { HOLD_CAP_PER_HOUR } from "../src/ledger/links";
import { fakeOrigin, fakeReviewer, SECRET, verdict } from "./fakes";
import { entry, rejectionOf } from "./helpers";
import { MemoryStepRunner } from "./step-runner";

// The `hold` action (M11, tasks/todo.md): a rule that sends a write to a person with no
// model call. For patterns an honest client can also trip, such as a third refund claim
// in an hour, where `block` would be wrong and paying a model every time is wasteful.

const THIRD_CLAIM: Rule = {
  id: "third-claim",
  description: "A third refund claim from one sender within an hour.",
  category: "fraud",
  action: "hold",
  when: {
    all: [
      { field: "path", op: "eq", value: "/api/tickets" },
      { field: "signal:linked.sender_route_1h", op: "gte", value: 2 },
    ],
  },
};

describe("the hold action", () => {
  it("compiles, and the gate holds only where a reviewer would have looked", () => {
    expect(compileRule(THIRD_CLAIM).rule.action).toBe("hold");
    expect(() => compileRule({ ...THIRD_CLAIM, action: "drop" as never })).toThrow(
      /block, flag or hold/,
    );
    const config = defineLazaret({
      origin: "https://origin.test",
      routes: [],
      gate: { rules: [THIRD_CLAIM] },
    });
    const ctx = {
      method: "POST",
      path: "/api/tickets",
      query: "",
      body: "",
      headers: {},
      json: undefined,
    };
    const count = {
      source: "behaviour" as const,
      id: "linked.sender_route_1h",
      category: "linked",
      weight: 0,
      value: 2,
    };
    const escrow = decide(config, "ESCROW", ctx, [count]);
    expect(escrow.hold).toEqual({
      ruleId: "rule.third-claim",
      category: "fraud",
      description: THIRD_CLAIM.description,
    });
    expect(escrow.block).toBe(false);
    expect(escrow.risk).toBe(0); // a routing decision, not evidence
    expect(decide(config, "PASS", ctx, [count]).hold).toBeUndefined();
    expect(decide(config, "ESCROW", ctx, []).hold).toBeUndefined();
  });

  it("is refused by the Ledger when malformed", async () => {
    const stub = env.LEDGER.get(env.LEDGER.idFromName("hold-shape"));
    const err = await rejectionOf(stub.append(entry({ hold: { ruleId: 1 } as never })));
    expect(err.message).toMatch(/entry.hold/);
  });
});

describe("held writes through the gateway and review", () => {
  let counter = 0;
  const origin = vi.fn();
  beforeEach(() => {
    origin.mockReset();
    origin.mockImplementation(async (req: Request) =>
      new URL(req.url).pathname.endsWith("/api/me")
        ? Response.json({ account: { id: "acct_mara", role: "agent" } })
        : Response.json({ ok: true }, { status: 201 }),
    );
  });

  function setup(rules: Rule[] = [THIRD_CLAIM]) {
    const shard = `hold-${++counter}`;
    const { reviewer, calls } = fakeReviewer(() => verdict("allow", 0.96));
    const archived: string[] = [];
    const config = defineLazaret({
      origin: "https://origin.test",
      ledger: { binding: "LEDGER", shard },
      session: { header: "authorization" },
      routes: [
        { match: "POST /api/tickets", policy: "ESCROW", resources: ["ticket:{receipt}"] },
        {
          match: "POST /api/accounts/:id/credits",
          policy: "INLINE_REVIEW",
          resources: ["account:{id}"],
        },
      ],
      review: { actor: { path: "/api/me", fields: { id: "account.id" } } },
      link: {},
      gate: { rules },
    } satisfies LazaretConfig);
    const gateway = createGateway(config, { fetchOrigin: origin, reviewer });
    const stub = env.LEDGER.get(env.LEDGER.idFromName(shard));
    const memory: MemoryPort = {
      archive: (records) => void archived.push(...records.map((r) => r.entryId)),
      getReviewerContext: () => [],
      getDistillInput: () => ({ drops: [], allows: [], existing: [] }),
      submitCandidates: () => [],
      markDistilled: () => undefined,
    };
    const review = async () => {
      const batchId = await stub.seal();
      if (!batchId) return null;
      return runReviewPipeline(
        new MemoryStepRunner(),
        {
          ledger: stub as unknown as LedgerPort,
          reviewer,
          committer: createCommitter({
            origin: config.origin,
            secret: SECRET,
            fetchOrigin: fakeOrigin().fetchOrigin,
          }),
          config,
          memory,
          attemptBackoffMs: 1,
        },
        batchId,
      );
    };
    const post = (path: string, body: unknown, token = "mara-1") =>
      gateway.fetch(
        new Request(`https://edge.test${path}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "cf-connecting-ip": "203.0.113.9",
          },
        }),
        env,
      );
    return { stub, post, review, calls, archived };
  }

  it("quarantines a third claim with no model call, and keeps it out of the archive", async () => {
    const { stub, post, review, calls, archived } = setup();
    for (const body of ["refund $49", "refund $48"]) {
      await post("/api/tickets", { body });
      await review();
    }
    expect(calls).toHaveLength(2);
    const third = (await (await post("/api/tickets", { body: "refund $47" })).json()) as {
      receipt: string;
    };
    expect((await stub.getState()).entries[third.receipt]?.hold?.ruleId).toBe("rule.third-claim");
    await review();
    expect(calls).toHaveLength(2); // no model read the held write
    const held = (await stub.getState()).entries[third.receipt];
    expect(held).toMatchObject({
      status: "QUARANTINED",
      verdict: { verdict: "quarantine", category: "fraud", confidence: 1 },
    });
    expect(held?.verdict?.rationale).toMatch(/^Held by learned rule rule\.third-claim/);
    // In the human queue, where an operator decides it.
    expect((await stub.getQuarantine()).map((e) => e.id)).toContain(third.receipt);
    expect(archived).not.toContain(third.receipt);
  });

  it("refuses a held inline write without asking the reviewer", async () => {
    const credits: Rule = {
      id: "third-credit",
      description: "A third credit to one customer within an hour.",
      category: "fraud",
      action: "hold",
      when: { field: "signal:linked.resource_route_1h", op: "gte", value: 2 },
    };
    const { stub, post, calls } = setup([credits]);
    await post("/api/accounts/acct_rowan/credits", { amount_cents: 4900 });
    await post("/api/accounts/acct_rowan/credits", { amount_cents: 4800 });
    await vi.waitFor(async () => {
      const { counts } = await stub.getLinkContext(
        ["resource:account:acct_rowan"],
        "POST /api/accounts/:id/credits",
      );
      expect(counts.resourceRoute).toBe(2);
    });
    const res = await post("/api/accounts/acct_rowan/credits", { amount_cents: 4700 });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("held_for_review");
    expect(calls).toHaveLength(2);
  });

  it(`stops holding a sender after ${HOLD_CAP_PER_HOUR} holds in an hour, and reviews instead`, async () => {
    const { stub, post, review } = setup();
    const { counts } = await stub.getLinkContext(["session:x"], "POST /api/tickets");
    expect(counts.heldSender).toBe(0);
    // Earlier claims, then enough holds from this sender to reach the cap.
    for (const n of [1, 2]) {
      await post("/api/tickets", { body: `claim ${n}` });
      await review();
    }
    for (let n = 0; n < HOLD_CAP_PER_HOUR; n++) {
      await post("/api/tickets", { body: `held ${n}` });
      await review();
    }
    const next = (await (await post("/api/tickets", { body: "one more" })).json()) as {
      receipt: string;
    };
    expect((await stub.getState()).entries[next.receipt]?.hold).toBeUndefined();
  });
});
