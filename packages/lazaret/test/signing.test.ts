import { describe, expect, it } from "vitest";
import { signRequest } from "../src";
import { verifyLazaretRequest } from "../src/origin";
import { SECRET } from "./fakes";

const NOW = 1_800_000_000_000;

async function signed(
  init: { method?: string; path?: string; body?: string; secret?: string; at?: number } = {},
) {
  const method = init.method ?? "POST";
  const path = init.path ?? "/api/tickets?x=1";
  const body = init.body ?? '{"a":1}';
  const headers = await signRequest(
    {
      id: "entry-1",
      method,
      target: path,
      body: new TextEncoder().encode(body),
      timestamp: Math.floor((init.at ?? NOW) / 1000),
    },
    init.secret ?? SECRET,
  );
  return { method, path, body, headers };
}

const toRequest = (
  s: Awaited<ReturnType<typeof signed>>,
  tweak: Partial<{ method: string; path: string; body: string }> = {},
) =>
  new Request(`https://origin.test${tweak.path ?? s.path}`, {
    method: tweak.method ?? s.method,
    headers: s.headers,
    body: tweak.body ?? s.body,
  });

describe("request signing", () => {
  it("round-trips and returns the id and body", async () => {
    const s = await signed();
    const result = await verifyLazaretRequest(toRequest(s), SECRET, { now: NOW });
    expect(result).toMatchObject({ ok: true, id: "entry-1" });
    if (result.ok) expect(new TextDecoder().decode(result.body)).toBe('{"a":1}');
  });

  it.each([
    ["body", { body: '{"a":2}' }],
    ["path", { path: "/api/admin?x=1" }],
    ["query", { path: "/api/tickets?x=2" }],
    ["method", { method: "PUT" }],
  ])("rejects a tampered %s", async (_name, tweak) => {
    const s = await signed();
    expect(await verifyLazaretRequest(toRequest(s, tweak), SECRET, { now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects the wrong secret, stale timestamps, and missing headers", async () => {
    const s = await signed();
    expect(
      (await verifyLazaretRequest(toRequest(s), "another-secret-0123456789", { now: NOW })).ok,
    ).toBe(false);
    expect(await verifyLazaretRequest(toRequest(s), SECRET, { now: NOW + 301_000 })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(
      await verifyLazaretRequest(new Request("https://origin.test/x", { method: "POST" }), SECRET, {
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("refuses weak secrets", async () => {
    await expect(signed({ secret: "short" })).rejects.toThrow(/at least 16/);
  });
});
