import { describe, expect, it } from "vitest";
import type { BatchView, EntryView } from "../src/lib/ledger-view";
import { progressOf } from "../src/lib/write-progress";

const entry = (over: Partial<EntryView> = {}): EntryView => ({
  id: "e1",
  batchId: "b1",
  route: "POST /api/tickets",
  method: "POST",
  path: "/api/tickets",
  session: "s",
  risk: 0.1,
  signals: [],
  resources: [],
  body: null,
  bodyTruncated: false,
  status: "PENDING" as EntryView["status"],
  verdict: null,
  originStatus: null,
  taintedBy: null,
  resolution: null,
  at: 0,
  ...over,
});
const batch = (status: BatchView["status"]): BatchView => ({
  id: "b1",
  status,
  sealReason: null,
  attempt: 0,
  openedAt: 0,
  updatedAt: 0,
  entryIds: ["e1"],
  note: null,
});
const verdict = {
  verdict: "drop",
  category: "stored_xss",
  confidence: 0.97,
  rationale: "r",
} as unknown as EntryView["verdict"];

describe("one write's progress", () => {
  it("is Held as soon as the gateway gave a receipt, even before the stream shows it", () => {
    expect(progressOf(undefined, undefined)).toMatchObject({ step: 0, outcome: null });
    expect(progressOf(entry(), batch("OPEN"))).toMatchObject({ step: 0 });
  });

  it("is Sealed once its batch leaves OPEN", () => {
    expect(progressOf(entry(), batch("SEALED"))).toMatchObject({ step: 1 });
    expect(progressOf(entry(), batch("REVIEWING"))).toMatchObject({ step: 1 });
  });

  it("is Reviewed once it has a verdict", () => {
    expect(progressOf(entry({ verdict }), batch("REVIEWING"))).toMatchObject({
      step: 2,
      outcome: null,
    });
  });

  it("names the outcome on the last step", () => {
    expect(
      progressOf(entry({ status: "COMMITTED" as EntryView["status"] }), batch("SETTLED")),
    ).toEqual({
      step: 3,
      outcome: "delivered",
      finalLabel: "Delivered",
    });
    expect(
      progressOf(entry({ status: "DROPPED" as EntryView["status"], verdict }), batch("SETTLED")),
    ).toMatchObject({
      outcome: "dropped",
      finalLabel: "Dropped",
    });
    expect(
      progressOf(entry({ status: "QUARANTINED" as EntryView["status"] }), batch("QUARANTINED")),
    ).toMatchObject({
      outcome: "held",
      finalLabel: "Held for a human",
    });
  });
});
