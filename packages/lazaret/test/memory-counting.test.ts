import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  type ArchiveInput,
  DISTILL_SYSTEM_PROMPT,
  type RuleProposal,
  type RuleSample,
  statusAfterLiveEvidence,
  DEFAULT_MEMORY_THRESHOLDS as T,
} from "../src";

// Counting rules in the Memory (M11, tasks/todo.md). A rule that reads a `linked.*`
// count can be learned like any other, but an honest client can trip a count too, so
// it climbs shadow → flag → hold and never blocks, and it must name its route.

let counter = 0;
const memory = () => env.MEMORY.get(env.MEMORY.idFromName(`counting-${++counter}`));
const DAY = 24 * 60 * 60 * 1000;
let ids = 0;

const sample = (count: number): RuleSample => ({
  method: "POST",
  path: "/api/tickets",
  query: "",
  body: `refund claim ${count}`,
  headers: {},
  json: undefined,
  signals: count
    ? [
        {
          source: "behaviour",
          id: "linked.sender_route_1h",
          category: "linked",
          weight: 0,
          value: count,
        },
      ]
    : [],
});

const record = (verdict: "allow" | "drop", count: number, at = Date.now()): ArchiveInput => ({
  entryId: `c${++ids}`,
  route: "POST /api/tickets",
  sessionId: "s",
  verdict,
  category: verdict === "drop" ? "fraud" : "benign",
  confidence: 1,
  rationale: verdict === "drop" ? "Operator dropped a split refund claim." : "ok",
  source: "operator",
  at: at + ids,
  sample: sample(count),
  memoryHits: [],
});

const counting = (withPath: boolean): RuleProposal => ({
  description: "A third ticket from one sender within an hour.",
  category: "fraud",
  when: {
    all: [
      ...(withPath ? [{ field: "path" as const, op: "eq" as const, value: "/api/tickets" }] : []),
      { field: "signal:linked.sender_route_1h", op: "gte", value: 2 },
    ],
  },
});

describe("counting rules in the Memory", () => {
  const live = { liveTruePositives: 0, liveFalsePositives: 0, lastHitAt: 1_000, updatedAt: 1_000 };
  const countingRule = {
    id: "m1",
    action: "flag" as const,
    weight: 0.6,
    when: { field: "signal:linked.sender_route_1h" as const, op: "gte" as const, value: 2 },
  };

  it("tops out at hold, never block; ordinary rules still reach block", () => {
    const promoted = (rule?: typeof countingRule) =>
      statusAfterLiveEvidence(
        {
          ...live,
          status: "flag",
          liveTruePositives: T.promoteToBlockAfter,
          ...(rule ? { rule } : {}),
        },
        T,
        2_000,
      )?.status;
    expect(promoted(countingRule)).toBe("hold");
    expect(promoted()).toBe("block"); // callers from before M11 pass no rule
    // And a hold rule still retires on its first false positive.
    expect(
      statusAfterLiveEvidence(
        {
          ...live,
          status: "hold",
          liveTruePositives: 20,
          liveFalsePositives: 1,
          rule: countingRule,
        },
        T,
        2_000,
      )?.status,
    ).toBe("retired");
  });

  it("rejects a counting rule that doesn't name its route, and backtests one that does", async () => {
    const m = memory();
    const old = Date.now() - 4 * DAY; // trusted clean traffic
    await m.archive([
      record("drop", 2),
      record("drop", 3),
      ...[0, 1, 1, 0].map((n) => record("allow", n, old)),
    ]);
    const [bare] = await m.submitCandidates([counting(false)], []);
    expect(bare).toMatchObject({
      status: "rejected",
      reason: "a rule that counts linked writes must also match a path",
    });
    const [routed] = await m.submitCandidates([counting(true)], []);
    expect(routed?.support).toBe(2);
    expect(routed?.status).not.toBe("rejected");
  });

  it("hands the gate a hold rule as mode hold, weight 0, action hold", async () => {
    const m = memory();
    await m.archive([record("drop", 2), record("drop", 3)]);
    const [rule] = await m.submitCandidates([counting(true)], []);
    await m.setRuleStatus(rule?.id as string, "hold", "test");
    const [active] = await m.getActiveRules();
    expect(active).toMatchObject({ mode: "hold", weight: 0, rule: { action: "hold" } });
  });

  it("tells the distiller what the count signals mean and that counting rules need a route", () => {
    expect(DISTILL_SYSTEM_PROMPT).toContain("linked.sender_route_1h");
    expect(DISTILL_SYSTEM_PROMPT).toContain('A counting rule must have a "path" condition');
  });
});
