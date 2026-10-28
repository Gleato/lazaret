import { describe, expect, it } from "vitest";
import { compileRule, type Rule, type RuleContext, RuleError } from "../src";

const ctx: RuleContext = {
  method: "POST",
  path: "/api/accounts/7/credits",
  query: "",
  body: '{"amount":5000,"currency":"usd"}',
  headers: { "user-agent": "python-requests/2.32", "x-api-version": "2" },
  json: { amount: 5000, currency: "usd", meta: { source: "Agent" } },
  signals: [{ source: "signature", id: "sqli.tautology", category: "sqli", weight: 0.75 }],
};

const test = (when: Rule["when"]) => compileRule({ id: "t", action: "block", when }).test(ctx);

describe("rule DSL", () => {
  it("evaluates leaf operators", () => {
    expect(test({ field: "method", op: "eq", value: "POST" })).toBe(true);
    expect(test({ field: "path", op: "startsWith", value: "/api/accounts" })).toBe(true);
    expect(test({ field: "header:User-Agent", op: "contains", value: "PYTHON", ci: true })).toBe(
      true,
    );
    expect(test({ field: "json:amount", op: "gte", value: 1000 })).toBe(true);
    expect(test({ field: "json:meta.source", op: "in", value: ["agent", "bot"], ci: true })).toBe(
      true,
    );
    expect(test({ field: "json:missing.deep", op: "exists" })).toBe(false);
    expect(test({ field: "signal:sqli", op: "gte", value: 0.7 })).toBe(true);
    expect(test({ field: "path", op: "matches", value: "^/api/accounts/\\d+/credits$" })).toBe(
      true,
    );
  });

  it("composes with all / any / not", () => {
    expect(
      test({
        all: [
          { field: "method", op: "eq", value: "POST" },
          {
            any: [
              { field: "json:amount", op: "gt", value: 10_000 },
              { field: "header:user-agent", op: "contains", value: "python" },
            ],
          },
          { not: { field: "header:x-api-version", op: "eq", value: "1" } },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    ["(a+)+$", /nested quantifiers/],
    ["(a|aa)*b", /nested quantifiers/],
    ["([a-z]*)*", /nested quantifiers/],
    ["(\\w+)\\1", /backreferences/],
    ["foo(?=bar)", /lookarounds/],
    ["x".repeat(300), /too long/],
  ])("rejects ReDoS-prone regex %s", (source, message) => {
    expect(() => test({ field: "path", op: "matches", value: source })).toThrow(message);
  });

  it("allows bounded, non-nested regexes", () => {
    expect(
      test({ field: "path", op: "matches", value: "^/api/(?:tickets|accounts)/\\d{1,10}" }),
    ).toBe(true);
    expect(test({ field: "path", op: "matches", value: "(ab)?c*" })).toBe(true);
  });

  it("enforces size, depth and shape limits", () => {
    let deep: Rule["when"] = { field: "method", op: "eq", value: "POST" };
    for (let i = 0; i < 9; i++) deep = { not: deep };
    expect(() => test(deep)).toThrow(/deeper than 8/);
    expect(() =>
      test({ any: Array.from({ length: 70 }, () => ({ field: "method", op: "exists" })) }),
    ).toThrow(/more than 64/);
    expect(() => test({ field: "json:__proto__.x", op: "exists" })).toThrow(/bad json path/);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid
    expect(() => test({ field: "cookies" as any, op: "exists" })).toThrow(/unknown field/);
    expect(() => test({ field: "json:amount", op: "gt", value: "big" })).toThrow(RuleError);
    expect(() =>
      compileRule({ id: "f", action: "flag", when: { field: "method", op: "exists" } }),
    ).toThrow(/weight/);
  });
});
