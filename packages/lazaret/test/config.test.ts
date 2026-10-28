import { describe, expect, it } from "vitest";
import { DEFAULT_CYCLE, defineLazaret, type LazaretConfig, LazaretConfigError } from "../src";

describe("defineLazaret", () => {
  it("fills in safe defaults", () => {
    const config = defineLazaret({ origin: "https://api.example.com", routes: [] });
    expect(config.fallback).toEqual({ read: "PASS", write: "ESCROW" });
    expect(config.cycle).toEqual(DEFAULT_CYCLE);
    expect(config.ledger).toEqual({ binding: "LAZARET_LEDGER", shard: "default" });
    expect(config.gate.thresholds).toEqual({ pass: 0.7, review: 0.95 });
    expect(config.gate.sensitiveFields).toContain("role");
  });

  it("merges partial cycle and threshold overrides", () => {
    const config = defineLazaret({
      origin: "https://api.example.com",
      routes: [],
      cycle: { intervalSec: 30 },
      gate: { thresholds: { pass: 0.6 } },
    });
    expect(config.cycle.intervalSec).toBe(30);
    expect(config.cycle.maxEntries).toBe(DEFAULT_CYCLE.maxEntries);
    expect(config.gate.thresholds).toEqual({ pass: 0.6, review: 0.95 });
  });

  it("reports every problem at once", () => {
    let error: LazaretConfigError | undefined;
    try {
      defineLazaret({
        origin: "ftp://nope",
        routes: [
          { match: "POST /api/tickets/:id", policy: "ESCROW", resources: ["ticket:{ticketId}"] },
          { match: "GET nope", policy: "PASS" },
          // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
          { match: "GET /x", policy: "MAYBE" as any },
        ],
        cycle: { maxEntries: 0 },
        gate: {
          thresholds: { review: 2 },
          rules: [
            { id: "r1", action: "block", when: { field: "path", op: "eq", value: "/x" } },
            { id: "r1", action: "block", when: { field: "path", op: "eq", value: "/y" } },
          ],
        },
      });
    } catch (err) {
      error = err as LazaretConfigError;
    }
    expect(error).toBeInstanceOf(LazaretConfigError);
    const text = error?.problems.join("\n") ?? "";
    expect(text).toMatch(/origin must be http/);
    expect(text).toMatch(/unknown param \{ticketId\}/);
    expect(text).toMatch(/must start with/);
    expect(text).toMatch(/unknown policy MAYBE/);
    expect(text).toMatch(/maxEntries/);
    expect(text).toMatch(/thresholds.review/);
    expect(text).toMatch(/duplicate id/);
  });

  it("validates route budgets and the actor lookup", () => {
    const problems = (config: Partial<LazaretConfig>) => {
      try {
        defineLazaret({ origin: "https://o.test", routes: [], ...config });
        return "";
      } catch (err) {
        return (err as LazaretConfigError).problems.join("\n");
      }
    };
    expect(
      problems({ routes: [{ match: "POST /k", policy: "INLINE_REVIEW", perMinute: 0 }] }),
    ).toMatch(/perMinute must be a positive integer/);
    expect(problems({ review: { actor: { path: "api/me", fields: {} } } })).toMatch(
      /actor.path must start with \/[\s\S]*actor.fields must not be empty/,
    );
    const ok = defineLazaret({
      origin: "https://o.test",
      routes: [],
      review: { actor: { path: "/api/me", fields: { role: "account.role" } } },
    });
    expect(ok.review.actor).toEqual({
      path: "/api/me",
      fields: { role: "account.role" },
      timeoutMs: 500,
    });
    expect(defineLazaret({ origin: "https://o.test", routes: [] }).review.actor).toBeNull();
  });

  it("accepts {receipt} in resources but reserves :receipt as a route param", () => {
    expect(() =>
      defineLazaret({
        origin: "https://o.test",
        routes: [{ match: "POST /api/tickets", policy: "ESCROW", resources: ["ticket:{receipt}"] }],
      }),
    ).not.toThrow();
    expect(() =>
      defineLazaret({
        origin: "https://o.test",
        routes: [{ match: "POST /api/x/:receipt", policy: "ESCROW" }],
      }),
    ).toThrow(LazaretConfigError);
  });
});
