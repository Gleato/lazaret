import { describe, expect, it } from "vitest";
import { builtinMerge, defineLazaret, type PendingWrite } from "../src";

const pending = (
  receipt: string,
  json: unknown,
  params: Record<string, string> = {},
): PendingWrite => ({
  receipt,
  json,
  params,
  receivedAt: 0,
});

describe("built-in overlay mergers", () => {
  it("append-json-array appends the author's pending items, marked, at root or a path", () => {
    const append = builtinMerge({ on: "GET /x", merge: "append-json-array" });
    expect(append([{ id: 1 }], [pending("r1", { subject: "new" })], { params: {} })).toEqual([
      { id: 1 },
      { subject: "new", _lazaret: { pending: true, receipt: "r1" } },
    ]);
    const nested = builtinMerge({ on: "GET /x", merge: "append-json-array", path: "data.items" });
    expect(
      nested({ data: { items: [] }, total: 0 }, [pending("r1", { a: 1 })], { params: {} }),
    ).toEqual({
      data: { items: [{ a: 1, _lazaret: { pending: true, receipt: "r1" } }] },
      total: 0,
    });
  });

  it("skips non-object writes and leaves non-array targets alone", () => {
    const append = builtinMerge({ on: "GET /x", merge: "append-json-array" });
    expect(append([], [pending("r1", undefined), pending("r2", "text")], { params: {} })).toEqual(
      [],
    );
    expect(append({ not: "an array" }, [pending("r1", { a: 1 })], { params: {} })).toEqual({
      not: "an array",
    });
  });

  it("patch-json-by-id patches only the matching item, in order", () => {
    const patch = builtinMerge({
      on: "GET /x",
      merge: "patch-json-by-id",
      idField: "ticketId",
      idParam: "id",
    });
    const out = patch(
      [
        { ticketId: 1, status: "open" },
        { ticketId: 2, status: "open" },
      ],
      [
        pending("r1", { status: "pending" }, { id: "1" }),
        pending("r2", { status: "closed" }, { id: "1" }),
      ],
      { params: {} },
    );
    expect(out).toEqual([
      { ticketId: 1, status: "closed", _lazaret: { pending: true, receipt: "r2" } },
      { ticketId: 2, status: "open" },
    ]);
  });

  it("merge-json-object shallow-merges into a single resource without mutating the input", () => {
    const merge = builtinMerge({ on: "GET /x", merge: "merge-json-object" });
    const original = { id: 1, name: "Ann" };
    expect(merge(original, [pending("r1", { name: "Annie" })], { params: {} })).toEqual({
      id: 1,
      name: "Annie",
      _lazaret: { pending: true, receipt: "r1" },
    });
    expect(original).toEqual({ id: 1, name: "Ann" });
  });
});

describe("overlay config", () => {
  const base = { origin: "https://origin.test" };

  it("compiles overlays, including arrays of them, from ESCROW routes", () => {
    const config = defineLazaret({
      ...base,
      routes: [
        {
          match: "PATCH /api/tickets/:id",
          policy: "ESCROW",
          overlay: [
            { on: "GET /api/tickets", merge: "patch-json-by-id" },
            { on: "GET /api/tickets/:id", merge: "merge-json-object" },
          ],
        },
      ],
    });
    expect(config.overlays.map((o) => [o.writeRoute, o.on.source])).toEqual([
      ["PATCH /api/tickets/:id", "GET /api/tickets"],
      ["PATCH /api/tickets/:id", "GET /api/tickets/:id"],
    ]);
  });

  it("rejects overlays on non-ESCROW routes, non-GET targets and unknown mergers", () => {
    expect(() =>
      defineLazaret({
        ...base,
        routes: [
          {
            match: "POST /a",
            policy: "PASS",
            overlay: { on: "GET /a", merge: "append-json-array" },
          },
          {
            match: "POST /b",
            policy: "ESCROW",
            overlay: { on: "POST /b", merge: "append-json-array" },
          },
          // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
          { match: "POST /c", policy: "ESCROW", overlay: { on: "GET /c", merge: "concat" as any } },
        ],
      }),
    ).toThrow(
      /only applies to ESCROW[\s\S]*must be a GET route[\s\S]*unknown overlay merge concat/,
    );
  });
});
