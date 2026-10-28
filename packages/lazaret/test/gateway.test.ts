import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGateway, defineLazaret, type LazaretConfig, type Reviewer } from "../src";
import { verifyLazaretRequest } from "../src/origin";
import { fakeReviewer, SECRET, verdict } from "./fakes";

// End-to-end through the Gateway with a real Ledger Durable Object and a fake
// origin. Each test gets its own Ledger shard so batches don't interleave.

const origin = vi.fn(async (req: Request) =>
  Response.json(
    { origin: true, path: new URL(req.url).pathname },
    { headers: { "x-origin": "1" } },
  ),
);

let shardCounter = 0;
function setup(
  overrides: Partial<LazaretConfig> = {},
  { now, reviewer }: { now?: () => number; reviewer?: Reviewer } = {},
) {
  const shard = `gateway-${++shardCounter}`;
  const config = defineLazaret({
    origin: "https://origin.test/base",
    ledger: { binding: "LEDGER", shard },
    routes: [
      { match: "GET /api/*", policy: "PASS" },
      { match: "POST /api/tickets", policy: "ESCROW", resources: ["ticket:new"] },
      { match: "PATCH /api/tickets/:id", policy: "ESCROW", resources: ["ticket:{id}"] },
      { match: "POST /api/tickets/:id/attachments", policy: "ESCROW", resources: ["ticket:{id}"] },
      { match: "PATCH /api/me", policy: "ESCROW" },
      { match: "POST /api/login", policy: "INLINE_REVIEW" },
      { match: "* /admin/*", policy: "BLOCK" },
    ],
    gate: { maxBodyBytes: 4096 },
    ...overrides,
  });
  const gateway = createGateway(config, {
    fetchOrigin: origin,
    ...(now ? { now } : {}),
    ...(reviewer ? { reviewer } : {}),
  });
  const ledger = env.LEDGER.get(env.LEDGER.idFromName(shard));
  const send = (path: string, init: RequestInit = {}) =>
    gateway.fetch(
      new Request(`https://edge.test${path}`, {
        ...init,
        headers: {
          "user-agent": "Mozilla/5.0 (test)",
          "cf-connecting-ip": "203.0.113.9",
          ...init.headers,
        },
      }),
      env,
    );
  const post = (path: string, body: unknown, method = "POST") =>
    send(path, {
      method,
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  return { send, post, ledger };
}

beforeEach(() => {
  origin.mockClear();
});

describe("Gateway", () => {
  it("forwards reads to origin on the normalised path, signed, with spoofed signatures replaced", async () => {
    const { send } = setup();
    const res = await send("/api/tickets/../tickets?page=2", {
      headers: { "x-lazaret-signature": "forged" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-lazaret-request-id")).toBeTruthy();
    const forwarded = origin.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://origin.test/base/api/tickets?page=2");
    expect(forwarded.headers.get("x-lazaret-signature")).not.toBe("forged");
    expect(await verifyLazaretRequest(forwarded, SECRET)).toMatchObject({ ok: true });
    expect(forwarded.headers.get("x-forwarded-for")).toBe("203.0.113.9");
  });

  it("escrows a write: 202 + receipt, nothing reaches origin, entry is in the Ledger", async () => {
    const { post, ledger } = setup();
    const res = await post("/api/tickets", { subject: "Printer on fire", body: "Please help" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { receipt: string; batchId: string };
    expect(res.headers.get("x-lazaret-receipt")).toBe(body.receipt);
    expect(origin).not.toHaveBeenCalled();

    const entry = (await ledger.getState()).entries[body.receipt];
    expect(entry).toMatchObject({
      route: "POST /api/tickets",
      resources: ["ticket:new"],
      status: "PENDING",
      request: { method: "POST", path: "/api/tickets", bodyEncoding: "utf8" },
    });
    expect(entry?.riskScore).toBeLessThan(0.3);
  });

  it("fills resource keys from route params for taint tracking", async () => {
    const { post, ledger } = setup();
    const { receipt } = (await (
      await post("/api/tickets/42", { status: "closed" }, "PATCH")
    ).json()) as {
      receipt: string;
    };
    expect((await ledger.getState()).entries[receipt]?.resources).toEqual(["ticket:42"]);
  });

  it.each(["/admin/users", "/ADMIN/users", "/admin", "/api/..%2fadmin/users", "/api\\..\\admin"])(
    "blocks %s before reading the body",
    async (path) => {
      const { send } = setup();
      const res = await send(path, { method: "DELETE" });
      expect(res.status).toBe(403);
      expect(origin).not.toHaveBeenCalled();
    },
  );

  it("blocks a SQL injection on a read, since nothing reviews reads", async () => {
    const { send } = setup();
    const res = await send("/api/tickets?q=1%20UNION%20SELECT%20password%20FROM%20users");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", requestId: expect.any(String) });
    expect(origin).not.toHaveBeenCalled();
  });

  it("escrows an ambiguous attack for the reviewer and seals the batch on the risk spike", async () => {
    const { post, ledger } = setup();
    const res = await post("/api/tickets", { subject: "hi", body: "<script>steal()</script>" });
    expect(res.status).toBe(202);
    const { batchId } = (await res.json()) as { batchId: string };
    const state = await ledger.getState();
    expect(state.batches[batchId]?.sealReason).toBe("risk");
  });

  it("hard-blocks stacked, near-certain evidence at the edge", async () => {
    const { post } = setup();
    const res = await post("/api/tickets", {
      body: "<script>x()</script><img src=x onerror=alert(1)>",
    });
    expect(res.status).toBe(403);
  });

  it("records mass-assignment evidence on the escrowed entry", async () => {
    const { post, ledger } = setup();
    const { receipt } = (await (
      await post("/api/me", { name: "Ann", role: "admin" }, "PATCH")
    ).json()) as {
      receipt: string;
    };
    const signals = (await ledger.getState()).entries[receipt]?.signals ?? [];
    expect(signals.map((s) => s.id)).toContain("body.mass_assignment");
  });

  it("escrows unmatched writes via the fallback instead of waving them through", async () => {
    const { post, ledger } = setup();
    const { receipt } = (await (await post("/api/unknown-endpoint", { a: 1 })).json()) as {
      receipt: string;
    };
    expect((await ledger.getState()).entries[receipt]?.route).toBe("fallback:write");
  });

  it("stores binary uploads as base64 so the bytes survive", async () => {
    const { send, ledger } = setup();
    const bytes = new Uint8Array([0, 255, 1, 254]);
    const res = await send("/api/tickets/7/attachments", {
      method: "POST",
      body: bytes,
      headers: { "content-type": "image/png" },
    });
    const { receipt } = (await res.json()) as { receipt: string };
    const request = (await ledger.getState()).entries[receipt]?.request;
    expect(request).toMatchObject({ bodyEncoding: "base64", body: "AP8B/g==" });
  });

  it("fails closed on INLINE_REVIEW when no reviewer is configured", async () => {
    const { post } = setup();
    expect((await post("/api/login", { user: "a", pass: "b" })).status).toBe(503);
    expect(origin).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies without buffering them", async () => {
    const { post } = setup();
    expect((await post("/api/tickets", { body: "x".repeat(5000) })).status).toBe(413);
  });

  it("rejects null bytes in the path", async () => {
    const { send } = setup();
    expect((await send("/api/file%00.png")).status).toBe(400);
  });

  it("applies custom block rules from config", async () => {
    const { post } = setup({
      gate: {
        rules: [
          {
            id: "no-huge-credits",
            action: "block",
            when: {
              all: [
                { field: "path", op: "startsWith", value: "/api/tickets" },
                { field: "json:priority", op: "eq", value: "p0" },
              ],
            },
          },
        ],
      },
    });
    expect((await post("/api/tickets", { priority: "p0" })).status).toBe(403);
    expect((await post("/api/tickets", { priority: "p2" })).status).toBe(202);
  });

  it("starts blocking a scraping agent once its behaviour gives it away", async () => {
    let t = 1_000_000;
    const { send } = setup({}, { now: () => (t += 100) }); // exactly 10 req/s, forever
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) statuses.push((await send(`/api/tickets/${i}`)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(403);
  });

  describe("INLINE_REVIEW", () => {
    const login = { user: "ann@example.com", password: "correct horse" };

    it("forwards a confidently allowed write to origin, signed", async () => {
      const { reviewer, calls } = fakeReviewer(() => verdict("allow", 0.96));
      const { post } = setup({}, { reviewer });
      const res = await post("/api/login", login);
      expect(res.status).toBe(200);
      expect(calls[0]?.tier).toBe("inline");
      const forwarded = origin.mock.calls[0]?.[0] as Request;
      expect(await verifyLazaretRequest(forwarded, SECRET)).toMatchObject({ ok: true });
    });

    it("rejects a dropped write without touching origin", async () => {
      const { reviewer } = fakeReviewer(() => verdict("drop", 0.9, "credential_attack"));
      const { post } = setup({}, { reviewer });
      expect((await post("/api/login", login)).status).toBe(403);
      expect(origin).not.toHaveBeenCalled();
    });

    it("treats a low-confidence allow as a rejection", async () => {
      const { reviewer } = fakeReviewer(() => verdict("allow", 0.6));
      const { post } = setup({}, { reviewer });
      expect((await post("/api/login", login)).status).toBe(403);
    });

    it("fails closed when the reviewer misses its deadline", async () => {
      const slow: Reviewer = { review: () => new Promise(() => {}) }; // never answers
      const { post } = setup({ review: { inlineTimeoutMs: 150 } }, { reviewer: slow });
      const started = Date.now();
      const res = await post("/api/login", login);
      expect(res.status).toBe(503);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(origin).not.toHaveBeenCalled();
    });

    it("fails closed on a reviewer refusal or malformed answer", async () => {
      const refusing = fakeReviewer(
        () => verdict("allow"),
        () => ({ kind: "refusal", category: "cyber", model: "x" }),
      );
      expect(
        (await setup({}, { reviewer: refusing.reviewer }).post("/api/login", login)).status,
      ).toBe(503);
      const garbled = fakeReviewer(
        () => verdict("allow"),
        () => ({ kind: "output", model: "x", output: { verdicts: [] } }),
      );
      expect(
        (await setup({}, { reviewer: garbled.reviewer }).post("/api/login", login)).status,
      ).toBe(503);
    });
  });
});
