import { describe, expect, it } from "vitest";
import { applyTaint, type EntryState } from "../src";
import { entry, verdict } from "./helpers";

const e = (id: string, sessionId: string, resources: string[]): EntryState => ({
  ...entry({ sessionId, resources }),
  id,
  batchId: "batch-1",
  status: "PENDING",
  receivedAt: 0,
});

describe("taint propagation", () => {
  it("drops a same-session write that builds on a dropped one, transitively", () => {
    const entries = [
      e("edit", "mallory", ["ticket:42"]),
      e("reply", "mallory", ["ticket:42", "reply:new"]),
      e("attach", "mallory", ["ticket:42"]),
    ];
    const result = applyTaint(entries, {
      edit: verdict("drop"),
      reply: verdict("allow"),
      attach: verdict("allow"),
    });
    expect(result.verdicts.reply).toMatchObject({ verdict: "drop", category: "tainted" });
    expect(result.verdicts.reply?.rationale).toContain("edit");
    expect(result.verdicts.attach).toMatchObject({ verdict: "drop", category: "tainted" });
    expect(result.tainted).toBe(2);
  });

  it("never punishes a different session for touching the same resource", () => {
    const entries = [e("attack", "mallory", ["ticket:42"]), e("honest", "ann", ["ticket:42"])];
    const result = applyTaint(entries, { attack: verdict("drop"), honest: verdict("allow") });
    expect(result.verdicts.honest?.verdict).toBe("allow");
  });

  it("does not link writes through `:new` creation keys", () => {
    const entries = [e("t1", "ann", ["ticket:new"]), e("t2", "ann", ["ticket:new"])];
    expect(
      applyTaint(entries, { t1: verdict("drop"), t2: verdict("allow") }).verdicts.t2?.verdict,
    ).toBe("allow");
  });

  it("only taints forwards: an earlier write is unaffected by a later drop", () => {
    const entries = [e("first", "ann", ["ticket:7"]), e("second", "ann", ["ticket:7"])];
    expect(
      applyTaint(entries, { first: verdict("allow"), second: verdict("drop") }).verdicts.first
        ?.verdict,
    ).toBe("allow");
  });

  it("holds dependents of a quarantined write", () => {
    const entries = [e("a", "ann", ["ticket:9"]), e("b", "ann", ["ticket:9"])];
    expect(
      applyTaint(entries, { a: verdict("quarantine"), b: verdict("allow") }).verdicts.b,
    ).toMatchObject({
      verdict: "quarantine",
      category: "tainted",
    });
  });

  it("flags sessions for reviewer drops only, once each", () => {
    const entries = [
      e("a", "mallory", ["x:1"]),
      e("b", "mallory", ["x:1"]),
      e("c", "mallory", ["y:1"]),
    ];
    const result = applyTaint(entries, {
      a: verdict("drop"),
      b: verdict("allow"),
      c: verdict("drop"),
    });
    expect(result.flaggedSessions).toEqual([{ sessionId: "mallory", reason: "xss in entry a" }]);
  });
});
