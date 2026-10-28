import { env } from "cloudflare:test";
import { defineLazaret } from "@gleator/lazaret";
import { describe, expect, it, vi } from "vitest";
import { hourlyShard, tidewaterConfig } from "../src/config";
import {
  agentUsageUsd,
  checkPass,
  createGuard,
  ESTIMATE_USD,
  type GuardEnv,
  hourlyReset,
  mintPass,
} from "../src/guard";
import { originFetch } from "./worker";

// The public demo's guard (src/guard.ts) in front of a stub gateway, so each check is
// tested on its own: the pass, CORS, rate limits, the per-IP and agent budgets, the
// body cap, and the hourly reset against the real Tidewater origin.

const SECRET = env.LAZARET_SIGNING_SECRET;
let counter = 0;

function setup(
  opts: {
    gatewayResponse?: (req: Request) => Response;
    turnstile?: boolean;
    writeAllowed?: boolean;
    now?: number;
  } = {},
) {
  const n = ++counter;
  const config = defineLazaret(
    tidewaterConfig({
      ledger: { shard: `guard-${n}` },
      review: { dailyBudgetUsd: 1, budgetShard: `guard-budget-${n}` },
    }),
  );
  const seen: Request[] = [];
  const gateway = {
    fetch: vi.fn(async (req: Request) => {
      seen.push(req);
      return opts.gatewayResponse?.(req) ?? Response.json({ ok: true });
    }),
    scheduled: vi.fn(async () => {}),
  };
  const now = opts.now ?? Date.now();
  const guard = createGuard(gateway, {
    config,
    now: () => now,
    verifyTurnstile: async () => opts.turnstile ?? true,
    limiters: () => ({
      write: { limit: async () => ({ success: opts.writeAllowed ?? true }) },
      pass: { limit: async () => ({ success: true }) },
    }),
  });
  const guardEnv = {
    ...env,
    ORIGIN: { fetch: originFetch },
    TURNSTILE_SECRET: "real-looking-secret",
    DEMO_SITE_ORIGINS: "https://gleator.com",
  } as unknown as GuardEnv;
  const send = (path: string, init: RequestInit = {}) =>
    guard.fetch(
      new Request(`https://demo.gleator.com${path}`, {
        ...init,
        headers: { "cf-connecting-ip": `203.0.113.${n}`, ...init.headers },
      }),
      guardEnv,
    );
  const budget = env.LAZARET_LEDGER.get(env.LAZARET_LEDGER.idFromName(`guard-budget-${n}`));
  const getPass = async () => {
    const res = await send("/demo/pass", { method: "POST", body: JSON.stringify({ token: "t" }) });
    return ((await res.json()) as { pass: string }).pass;
  };
  return { send, seen, gateway, budget, getPass, config, guardEnv, ip: `203.0.113.${n}` };
}

const post = (pass: string | null, body: unknown = { subject: "s", body: "b" }) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    ...(pass ? { "x-demo-pass": pass } : {}),
  },
});

describe("demo pass", () => {
  it("is minted after Turnstile, as a cookie and in the body, and expires", async () => {
    const at = Date.UTC(2026, 9, 28, 12);
    const { send } = setup({ now: at });
    const res = await send("/demo/pass", { method: "POST", body: JSON.stringify({ token: "t" }) });
    expect(res.status).toBe(200);
    const { pass, expires } = (await res.json()) as { pass: string; expires: number };
    expect(res.headers.get("set-cookie")).toContain(
      `demo_pass=${pass}; Path=/; Max-Age=1800; HttpOnly`,
    );
    expect(expires).toBe(at + 30 * 60_000);
    expect(await checkPass(SECRET, pass, at)).toBe(true);
    expect(await checkPass(SECRET, pass, expires + 1)).toBe(false);
  });

  it("is refused when Turnstile fails", async () => {
    const { send } = setup({ turnstile: false });
    expect(
      (await send("/demo/pass", { method: "POST", body: JSON.stringify({ token: "t" }) })).status,
    ).toBe(403);
  });

  it("can't be forged, stretched, or minted with another secret", async () => {
    const at = Date.now();
    const good = await mintPass(SECRET, at + 60_000);
    const [, exp, sig] = good.split(".");
    expect(await checkPass(SECRET, `v1.${Number(exp) + 1}.${sig}`, at)).toBe(false);
    expect(await checkPass(SECRET, await mintPass(SECRET, at + 24 * 3_600_000), at)).toBe(false);
    expect(
      await checkPass(SECRET, await mintPass("another-secret-0123456789", at + 60_000), at),
    ).toBe(false);
    expect(await checkPass(SECRET, "garbage", at)).toBe(false);
  });
});

describe("writes", () => {
  it("need a pass; reads, the live stream and status don't", async () => {
    const { send, getPass, seen } = setup();
    const refused = await send("/api/tickets", post(null));
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: "demo_pass_required" });
    expect((await send("/api/tickets")).status).toBe(200);
    expect((await send("/__lazaret/status")).status).toBe(200);
    expect((await send("/api/tickets", post(await getPass()))).status).toBe(200);
    expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /api/tickets",
      "GET /__lazaret/status",
      "POST /api/tickets",
    ]);
  });

  it("accept the pass as a cookie, and never forward it to Lazaret or origin", async () => {
    const { send, getPass, seen } = setup();
    const pass = await getPass();
    const res = await send("/api/tickets", {
      ...post(null),
      headers: { "content-type": "application/json", cookie: `theme=dark; demo_pass=${pass}` },
    });
    expect(res.status).toBe(200);
    expect(seen[0]?.headers.get("cookie")).toBe("theme=dark");
    expect(seen[0]?.headers.has("x-demo-pass")).toBe(false);
  });

  it("are rate limited per IP", async () => {
    const { send, getPass } = setup({ writeAllowed: false });
    expect((await send("/api/tickets", post(await getPass()))).status).toBe(429);
  });

  it("are capped at 16 KiB", async () => {
    const { send, getPass } = setup();
    const res = await send("/api/tickets", post(await getPass(), { body: "x".repeat(17_000) }));
    expect(res.status).toBe(413);
  });

  it("charge an estimate to the IP, and stop once the IP's $0.25 is spent", async () => {
    const { send, getPass, budget, ip } = setup({
      gatewayResponse: () =>
        Response.json({ receipt: "r" }, { status: 202, headers: { "x-lazaret-receipt": "r" } }),
    });
    const pass = await getPass();
    expect((await send("/api/tickets", post(pass))).status).toBe(202);
    const ipKey = await ipKeyOf(ip);
    expect((await budget.budgetStatus(0.25, ipKey)).spentUsd).toBeCloseTo(ESTIMATE_USD.escrow);
    await budget.chargeSpend(0.25, ipKey);
    const res = await send("/api/tickets", post(pass));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "ip_budget_spent" });
  });

  it("let the operator API through on its own token, without a pass", async () => {
    const { send, seen } = setup();
    await send("/__lazaret/operator/entries/x", post(null, { action: "drop" }));
    expect(seen).toHaveLength(1);
  });
});

describe("agent runs", () => {
  const usage = JSON.stringify({
    model: "claude-haiku-5-5",
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

  it("charge the run's real usage to the global and IP budgets, and hide the header", async () => {
    const { send, getPass, budget, ip } = setup({
      gatewayResponse: () =>
        Response.json({ proposals: [] }, { headers: { "x-tidewater-usage": usage } }),
    });
    const res = await send("/api/agent/run", post(await getPass(), {}));
    expect(res.status).toBe(200);
    expect(res.headers.has("x-tidewater-usage")).toBe(false);
    expect((await budget.budgetStatus(1)).spentUsd).toBeCloseTo(0.1);
    expect((await budget.budgetStatus(1, await ipKeyOf(ip))).spentUsd).toBeCloseTo(0.1);
  });

  it("stop when the day's global budget is spent", async () => {
    const { send, getPass, budget, seen } = setup();
    await budget.chargeSpend(1);
    const res = await send("/api/agent/run", post(await getPass(), {}));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "budget_spent" });
    expect(seen).toHaveLength(0);
  });

  it("are limited to five a day per IP", async () => {
    const { send, getPass } = setup();
    const pass = await getPass();
    for (let i = 0; i < 5; i++)
      expect((await send("/api/agent/run", post(pass, {}))).status).toBe(200);
    expect((await send("/api/agent/run", post(pass, {}))).status).toBe(429);
  });

  it("price a malformed usage header at zero rather than failing", () => {
    expect(agentUsageUsd("{not json")).toBe(0);
    expect(agentUsageUsd(null)).toBe(0);
  });
});

describe("CORS", () => {
  it("answers preflight for the site only, with credentials", async () => {
    const { send } = setup();
    const ok = await send("/api/tickets", {
      method: "OPTIONS",
      headers: { origin: "https://gleator.com", "access-control-request-method": "POST" },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://gleator.com");
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    const evil = await send("/api/tickets", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(evil.status).toBe(403);
    expect(evil.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("exposes Lazaret's headers to the site", async () => {
    const { send } = setup();
    const res = await send("/api/tickets", { headers: { origin: "https://gleator.com" } });
    expect(res.headers.get("access-control-expose-headers")).toContain("x-lazaret-receipt");
  });
});

describe("hourly reset", () => {
  it("names a fresh Ledger shard every UTC hour", () => {
    expect(hourlyShard(Date.UTC(2026, 9, 28, 14, 59))).toBe("tidewater-2026-10-28T14");
    expect(hourlyShard(Date.UTC(2026, 9, 28, 15, 0))).toBe("tidewater-2026-10-28T15");
  });

  it("retires the old shard's viewers and re-seeds origin", async () => {
    const { guardEnv } = setup();
    const at = Date.UTC(2026, 9, 28, 15);
    const config = defineLazaret(tidewaterConfig());
    await env.DB.prepare(
      "INSERT INTO tickets (id, account_id, subject, body, status, created_at, updated_at) VALUES ('tkt_visitor', 'acct_mara', 's', 'b', 'open', 0, 0)",
    ).run();
    await hourlyReset(guardEnv, config, at);
    expect(
      await env.DB.prepare("SELECT id FROM tickets WHERE id = 'tkt_visitor'").first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM tickets WHERE id = 'tkt_seed_1'").first(),
    ).not.toBeNull();
  });

  it("sweeps the previous hour's shard too, so no batch is stranded by the rollover", async () => {
    const { guardEnv, gateway } = setup();
    const config = defineLazaret(tidewaterConfig());
    const guard = createGuard(gateway, { config });
    const sweep = vi.fn(async (_shard: string) => ({ redispatched: 0 }));
    const ns = {
      idFromName: (name: string) => name,
      get: (name: string) => ({ sweep: () => sweep(name) }),
    };
    await guard.scheduled(
      { cron: "* * * * *", scheduledTime: Date.UTC(2026, 9, 28, 15, 1), noRetry() {} },
      { ...guardEnv, LAZARET_LEDGER: ns } as unknown as GuardEnv,
    );
    expect(gateway.scheduled).toHaveBeenCalled();
    expect(sweep).toHaveBeenCalledWith("tidewater-2026-10-28T14");
  });
});

async function ipKeyOf(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return `ip:${[...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
