import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ArchiveInput, DistillInput, RuleProposal, RuleSample } from "../src";

// The recursive JSON type in samples is too deep for the RPC stub's mapped types.
type DistillView = { getDistillInput(): Promise<DistillInput> };

let counter = 0;
const memory = () => env.MEMORY.get(env.MEMORY.idFromName(`memory-${++counter}`));

const sample = (body: string): RuleSample => ({
  method: "POST",
  path: "/api/tickets",
  query: "",
  body,
  headers: {},
  json: undefined,
  signals: [],
});

let ids = 0;
const record = (
  verdict: "allow" | "drop",
  body: string,
  extra: Partial<ArchiveInput> = {},
): ArchiveInput => ({
  entryId: `e${++ids}`,
  route: "POST /api/tickets",
  sessionId: "s",
  verdict,
  category: verdict === "drop" ? "fraud" : "benign",
  confidence: 0.95,
  rationale: verdict === "drop" ? "Redirects a refund to an outside account." : "ok",
  source: "batch",
  at: Date.now() + ids, // realistic timestamps: tiny ones would trip the staleness check
  sample: sample(body),
  memoryHits: [],
  ...extra,
});

const acctRule: RuleProposal = {
  description: "Refund requests naming an external payout account.",
  category: "fraud",
  when: { field: "body", op: "contains", value: "acct-" },
};

const clean = () => [
  record("allow", "printer on fire"),
  record("allow", "cannot log in"),
  record("allow", "thanks!"),
];
const attacks = () => [record("drop", "refund to acct-1"), record("drop", "refund to acct-2")];

describe("Memory", () => {
  it("archives idempotently, so a replayed Workflow step can't double-count", async () => {
    const m = memory();
    const r = record("allow", "hi");
    expect(await m.archive([r])).toMatchObject({ archived: 1 });
    expect(await m.archive([r])).toMatchObject({ archived: 0 });
    expect((await m.getStats()).archived).toEqual({ allow: 1 });
  });

  it("judges candidates by backtest: shadow, pending, rejected, unsafe, duplicate", async () => {
    const m = memory();
    await m.archive([...clean(), ...attacks()]);
    const created = await m.submitCandidates(
      [
        acctRule,
        acctRule, // duplicate, skipped
        {
          description: "broader, but still clean",
          category: "fraud",
          when: { field: "body", op: "contains", value: "refund" },
        },
        {
          description: "too narrow",
          category: "fraud",
          when: { field: "body", op: "contains", value: "acct-1" },
        },
        {
          description: "redos",
          category: "fraud",
          when: { field: "body", op: "matches", value: "(a+)+$" },
        },
      ],
      [],
    );
    expect(created.map((r) => [r.status, r.reason])).toEqual([
      ["shadow", "matched 2 drops and 0 of 3 clean requests"],
      ["shadow", expect.any(String)],
      ["rejected", "matched 1 dropped request(s); needs 2"],
      ["rejected", expect.stringMatching(/unsafe or invalid rule: .*nested quantifiers/)],
    ]);
  });

  it("rejects a rule that would hit legitimate traffic", async () => {
    const m = memory();
    await m.archive([...clean(), record("allow", "move refund to acct-9 please"), ...attacks()]);
    const [rule] = await m.submitCandidates([acctRule], []);
    expect(rule).toMatchObject({
      status: "rejected",
      reason: "matched 1 allowed request(s) in backtest",
    });
  });

  it("parks a rule as pending until enough clean traffic exists, then promotes it to shadow", async () => {
    const m = memory();
    await m.archive([record("allow", "hi"), ...attacks()]);
    const [rule] = await m.submitCandidates([acctRule], []);
    expect(rule?.status).toBe("pending");
    const { transitions } = await m.archive([record("allow", "hello"), record("allow", "hey")]);
    expect(transitions).toEqual([
      expect.objectContaining({ ruleId: rule?.id, from: "pending", to: "shadow" }),
    ]);
  });

  it("promotes on live hits the reviewer confirms, and turns into a block rule", async () => {
    const m = memory();
    await m.archive([...clean(), ...attacks()]);
    const [rule] = await m.submitCandidates([acctRule], []);
    const id = rule?.id ?? "";
    const hit = () => record("drop", "refund to acct-x", { memoryHits: [id] });

    await m.archive([hit()]);
    const { transitions: toFlag } = await m.archive([hit()]);
    expect(toFlag.map((t) => t.to)).toEqual(["flag"]);
    await m.archive([hit()]);
    const { transitions: toBlock } = await m.archive([hit()]);
    expect(toBlock.map((t) => t.to)).toEqual(["block"]);

    const [active] = await m.getActiveRules();
    expect(active).toMatchObject({ id, mode: "block", rule: { action: "block" } });
    expect((await m.getRuleEvents()).map((e) => e.to)).toEqual(["shadow", "flag", "block"]);
  });

  it("retires a rule the moment the reviewer allows something it matched", async () => {
    const m = memory();
    await m.archive([...clean(), ...attacks()]);
    const [rule] = await m.submitCandidates([acctRule], []);
    const { transitions } = await m.archive([
      record("allow", "acct-ok", { memoryHits: [rule?.id ?? ""] }),
    ]);
    expect(transitions).toEqual([
      expect.objectContaining({ to: "retired", reason: "matched a request the reviewer allowed" }),
    ]);
    expect(await m.getActiveRules()).toEqual([]);
  });

  it("feeds the distiller only unexplained, non-tainted, undistilled drops, plus clean counter-examples", async () => {
    const m = memory();
    const [a, b] = attacks();
    await m.archive([
      ...clean(),
      a as ArchiveInput,
      b as ArchiveInput,
      record("drop", "covered acct-3", { memoryHits: ["mem-9"] }),
      record("drop", "tainted", { category: "tainted" }),
    ]);
    const input = await (m as unknown as DistillView).getDistillInput();
    expect(input.drops.map((d) => d.entryId).sort()).toEqual([a?.entryId, b?.entryId].sort());
    expect(input.allows).toHaveLength(3);
    await m.markDistilled(input.drops.map((d) => d.entryId));
    expect((await (m as unknown as DistillView).getDistillInput()).drops).toEqual([]);
  });

  it("summarises recent drops per route for the reviewer", async () => {
    const m = memory();
    await m.archive([...clean(), ...attacks()]);
    expect(await m.getReviewerContext(["POST /api/tickets"])).toEqual([
      {
        route: "POST /api/tickets",
        category: "fraud",
        count: 2,
        example: "Redirects a refund to an outside account.",
      },
    ]);
    expect(await m.getReviewerContext([])).toEqual([]);
  });

  it("lets an operator override a rule", async () => {
    const m = memory();
    await m.archive([...clean(), ...attacks()]);
    const [rule] = await m.submitCandidates([acctRule], []);
    expect(await m.setRuleStatus(rule?.id ?? "", "retired", "too risky")).toMatchObject({
      status: "retired",
      reason: "operator: too risky",
    });
  });
});
