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

const DAY = 24 * 60 * 60 * 1000;
// Allows committed long enough ago (past trustAllowsAfterMs, 3 days) to count as trusted
// clean traffic in backtests (M7.1). A fresh model allow is only the reviewer's opinion.
const trusted = (body: string) => record("allow", body, { at: Date.now() - 4 * DAY + ids });
const clean = () => [trusted("printer on fire"), trusted("cannot log in"), trusted("thanks!")];
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
      ["pending", "matched 1 dropped request(s); waiting for 2"],
      ["rejected", expect.stringMatching(/unsafe or invalid rule: .*nested quantifiers/)],
    ]);
  });

  it("rejects a rule that would hit legitimate traffic", async () => {
    const m = memory();
    await m.archive([...clean(), trusted("move refund to acct-9 please"), ...attacks()]);
    const [rule] = await m.submitCandidates([acctRule], []);
    expect(rule).toMatchObject({
      status: "rejected",
      reason: "matched 1 allowed request(s) in backtest",
    });
  });

  it("parks a rule as pending until enough clean traffic exists, then promotes it to shadow", async () => {
    const m = memory();
    await m.archive([trusted("hi"), ...attacks()]);
    const [rule] = await m.submitCandidates([acctRule], []);
    expect(rule?.status).toBe("pending");
    const { transitions } = await m.archive([trusted("hello"), trusted("hey")]);
    expect(transitions).toEqual([
      expect.objectContaining({ ruleId: rule?.id, from: "pending", to: "shadow" }),
    ]);
  });

  // M7.1 A: thin evidence is "not yet", not "no".
  it("keeps a rule with one matching drop waiting, and promotes it when a second arrives", async () => {
    const m = memory();
    await m.archive([...clean(), record("drop", "refund to acct-1")]);
    const [rule] = await m.submitCandidates([acctRule], []);
    expect(rule).toMatchObject({ status: "pending", support: 1 });
    // The same rule proposed again is still the same rule, not a new one.
    expect(await m.submitCandidates([acctRule], [])).toEqual([]);
    const { transitions } = await m.archive([record("drop", "refund to acct-2")]);
    expect(transitions).toEqual([
      expect.objectContaining({ ruleId: rule?.id, from: "pending", to: "shadow" }),
    ]);
  });

  it("expires a pending rule after the staleness window, which frees its fingerprint", async () => {
    const m = memory();
    await m.archive([...clean(), record("drop", "refund to acct-1")]);
    const [rule] = await m.submitCandidates([acctRule], []);
    await m.advanceClock(31 * DAY);
    const { transitions } = await m.archive([
      record("allow", "fresh", { at: Date.now() + 31 * DAY }),
    ]);
    expect(transitions).toEqual([
      expect.objectContaining({ ruleId: rule?.id, from: "pending", to: "retired" }),
    ]);
    const [again] = await m.submitCandidates([acctRule], []);
    expect(again?.id).not.toBe(rule?.id);
  });

  // M7.1 B: a rule that disagrees with the reviewer is a question for a human.
  describe("disputes", () => {
    async function disputed() {
      const m = memory();
      const missed = record("allow", "refund to acct-7 &lt;script&gt;"); // a reviewer allow
      await m.archive([...clean(), ...attacks(), missed]);
      const [rule] = await m.submitCandidates([acctRule], []);
      return { m, rule, missed };
    }

    it("parks a rule that matches a model's allow as disputed, and lists the write", async () => {
      const { m, rule, missed } = await disputed();
      expect(rule).toMatchObject({ status: "pending", reason: expect.stringMatching(/^disputed/) });
      expect(await m.getDisputes()).toEqual([
        expect.objectContaining({
          entryId: missed.entryId,
          rules: [expect.objectContaining({ id: rule?.id })],
        }),
      ]);
    });

    it("never promotes a disputed rule on more evidence alone", async () => {
      const { m, rule } = await disputed();
      const { transitions } = await m.archive([
        record("drop", "refund to acct-3"),
        record("drop", "refund to acct-4"),
        ...clean(),
      ]);
      expect(transitions).toEqual([]);
      expect((await m.listRules()).find((r) => r.id === rule?.id)?.status).toBe("pending");
    });

    it("promotes it when a human labels the write an attack", async () => {
      const { m, rule, missed } = await disputed();
      const result = await m.labelArchived(missed.entryId, "drop", "xss", "encoded payload");
      expect(result?.transitions).toEqual([
        expect.objectContaining({ ruleId: rule?.id, from: "pending", to: "shadow" }),
      ]);
      expect(await m.getDisputes()).toEqual([]);
    });

    it("rejects it when a human labels the write benign", async () => {
      const { m, rule, missed } = await disputed();
      const result = await m.labelArchived(missed.entryId, "allow", "benign", "real customer");
      expect(result?.transitions).toEqual([
        expect.objectContaining({ ruleId: rule?.id, from: "pending", to: "rejected" }),
      ]);
    });

    it("rejects it once the allow is old enough to trust and was never reported", async () => {
      const { m, rule } = await disputed();
      await m.advanceClock(4 * DAY);
      const { transitions } = await m.archive([]);
      expect(transitions).toEqual([
        expect.objectContaining({ ruleId: rule?.id, from: "pending", to: "rejected" }),
      ]);
    });

    it("reports a label for a write that has aged out of the archive", async () => {
      expect(await memory().labelArchived("gone", "drop", "xss", "")).toBeNull();
    });
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

  // M7.1: a live hit on a model's allow is a dispute, not a false positive.
  describe("live disputes", () => {
    async function shadowRule() {
      const m = memory();
      await m.archive([...clean(), ...attacks()]);
      const [rule] = await m.submitCandidates([acctRule], []);
      const id = rule?.id ?? "";
      const allowed = record("allow", "acct-ok", { memoryHits: [id] });
      const { transitions } = await m.archive([allowed]);
      return { m, id, allowed, transitions };
    }
    const hit = (id: string) => record("drop", "refund to acct-x", { memoryHits: [id] });

    it("holds the rule where it is, lists the write, and blocks promotion", async () => {
      const { m, id, allowed, transitions } = await shadowRule();
      expect(transitions).toEqual([]);
      expect(await m.getDisputes()).toEqual([
        expect.objectContaining({
          entryId: allowed.entryId,
          rules: [expect.objectContaining({ id })],
        }),
      ]);
      // Two confirmed hits would normally promote to flag (test thresholds); not while disputed.
      const { transitions: held } = await m.archive([hit(id), hit(id)]);
      expect(held).toEqual([]);
    });

    it("retires the rule at once when a human says the write was benign", async () => {
      const { m, id, allowed } = await shadowRule();
      const result = await m.labelArchived(allowed.entryId, "allow", "benign", "real customer");
      expect(result?.transitions).toEqual([
        expect.objectContaining({
          ruleId: id,
          to: "retired",
          reason: "matched a request the reviewer allowed",
        }),
      ]);
    });

    it("counts the hit as confirmed when a human says it was an attack, and promotes", async () => {
      const { m, id, allowed } = await shadowRule();
      await m.archive([hit(id)]);
      const result = await m.labelArchived(allowed.entryId, "drop", "fraud", "reviewer missed it");
      expect(result?.transitions).toEqual([expect.objectContaining({ ruleId: id, to: "flag" })]);
      expect(await m.getDisputes()).toEqual([]);
    });

    it("becomes a false positive, and retires the rule, once nobody reports it in time", async () => {
      const { m, id } = await shadowRule();
      await m.advanceClock(4 * DAY);
      const { transitions } = await m.archive([]);
      expect(transitions).toEqual([expect.objectContaining({ ruleId: id, to: "retired" })]);
    });
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
