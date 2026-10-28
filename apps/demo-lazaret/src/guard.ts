import {
  costUsd,
  type LazaretLedger,
  matchPattern,
  normalizePath,
  type ResolvedConfig,
  signRequest,
} from "@gleator/lazaret";

// The public demo's guard (M7). It wraps the Lazaret gateway with what only a public,
// pay-per-call demo needs. The library knows nothing about it.
//
//   Turnstile        Every write costs model calls, so writes need a demo pass: a
//                    30-minute HMAC token from POST /demo/pass after a Turnstile check,
//                    sent as a cookie (the Tidewater UI, same origin) or the
//                    `x-demo-pass` header (the gleator.com console). Reads, the live
//                    stream and the status endpoints are free and need no pass.
//   Rate limits      Workers Rate Limiting, per IP: writes per minute, passes per minute.
//   Per-IP budget    $0.25 a day per IP, charged from estimates (escrowed writes are
//                    reviewed later, in batches, with no IP attached) and, for agent
//                    runs, from the run's real usage. An engaged visitor costs 2–3¢, so
//                    this only stops one client draining the shared $10 for everyone.
//   Agent runs       Tidewater's AI agent spends model calls that Lazaret's reviewer
//                    doesn't see. They are checked against the global cap, limited to
//                    5 a day per IP, and charged from the usage origin reports.
//   Hourly reset     The Ledger shard is named by the hour (config.ts), so a fresh one
//                    takes over on the hour by itself. The cron then retires the old
//                    shard's viewers (RESET frame) and re-seeds origin.
//   CORS             For the site's origins only, with credentials.
//
// Everything here fails toward "no": a guard check that throws refuses the request.

const PASS_TTL_MS = 30 * 60_000;
const PASS_COOKIE = "demo_pass";
const PER_IP_DAILY_USD = 0.25;
const AGENT_RUNS_PER_IP_PER_DAY = 5;
const CONSOLE_MAX_BODY_BYTES = 16 * 1024;
/**
 * What one write costs, for per-IP accounting. Live eval run 8 measured $2.28 per 1,000
 * reviewed entries across all tiers; these round up so the per-IP cap errs early.
 */
export const ESTIMATE_USD = { escrow: 0.003, inline: 0.002 } as const;
/** Cloudflare's published always-pass test secret. Local dev only: no network call. */
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";

export interface GuardEnv {
  LAZARET_LEDGER: DurableObjectNamespace<LazaretLedger>;
  ORIGIN: Fetcher;
  LAZARET_SIGNING_SECRET: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  /** Comma-separated origins allowed to call the demo from a browser (the site). */
  DEMO_SITE_ORIGINS?: string;
  WRITE_LIMIT?: RateLimit;
  PASS_LIMIT?: RateLimit;
}

interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface GuardOptions {
  config: ResolvedConfig;
  now?: () => number;
  /** Turnstile siteverify. Injected in tests. */
  verifyTurnstile?: (token: string, ip: string, secret: string) => Promise<boolean>;
  /** Rate limiters. Default: the WRITE_LIMIT / PASS_LIMIT bindings (allow if absent). */
  limiters?: (env: GuardEnv) => { write: Limiter; pass: Limiter };
}

interface Gateway {
  fetch(request: Request, env: object, ctx?: ExecutionContext): Promise<Response>;
  scheduled(controller: ScheduledController, env: object): Promise<void>;
}

const ALLOW = { limit: async () => ({ success: true }) };
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createGuard(gateway: Gateway, options: GuardOptions) {
  const { config } = options;
  const now = options.now ?? Date.now;
  const verifyTurnstile = options.verifyTurnstile ?? siteverify;
  const limiters =
    options.limiters ??
    ((env: GuardEnv) => ({ write: env.WRITE_LIMIT ?? ALLOW, pass: env.PASS_LIMIT ?? ALLOW }));
  const inlineRoutes = config.routes.filter((r) => r.route.policy === "INLINE_REVIEW");
  const budgetFor = (env: GuardEnv) =>
    env.LAZARET_LEDGER.get(env.LAZARET_LEDGER.idFromName(config.review.budgetShard));

  return {
    async fetch(request: Request, env: GuardEnv, ctx?: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      const cors = corsHeaders(request, env);
      const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        Response.json(body, {
          status,
          headers: { "cache-control": "no-store", ...cors, ...headers },
        });

      // Preflight for the site's console. Answered here; origin never sees it.
      if (method === "OPTIONS" && request.headers.has("access-control-request-method")) {
        return new Response(null, {
          status: cors["access-control-allow-origin"] ? 204 : 403,
          headers: {
            ...cors,
            "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
            "access-control-allow-headers": "authorization, content-type, x-demo-pass",
            "access-control-max-age": "600",
          },
        });
      }

      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const ipKey = `ip:${await hashHex(ip)}`;

      if (url.pathname === "/demo/pass" && method === "POST") {
        const { pass: passLimit } = limiters(env);
        if (!(await passLimit.limit({ key: ipKey })).success) {
          return reply(429, { error: "too_many_passes" });
        }
        const secret = env.TURNSTILE_SECRET;
        if (!secret) return reply(503, { error: "demo_closed" });
        const token = await readToken(request);
        if (!token || !(await verifyTurnstile(token, ip, secret).catch(() => false))) {
          return reply(403, { error: "turnstile_failed" });
        }
        const expires = now() + PASS_TTL_MS;
        const pass = await mintPass(env.LAZARET_SIGNING_SECRET, expires);
        return reply(
          200,
          { pass, expires },
          {
            "set-cookie": `${PASS_COOKIE}=${pass}; Path=/; Max-Age=${PASS_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`,
          },
        );
      }

      if (url.pathname === "/demo/verify" && method === "GET") {
        return new Response(
          verifyPage(env.TURNSTILE_SITE_KEY ?? "", url.searchParams.get("return")),
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy":
                "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'",
            },
          },
        );
      }

      // The demo cookie is the guard's business: it never reaches the Ledger or origin.
      const pass = readPass(request);
      const headers = new Headers(request.headers);
      headers.delete("x-demo-pass");
      const cookie = stripCookie(headers.get("cookie"), PASS_COOKIE);
      if (cookie) headers.set("cookie", cookie);
      else headers.delete("cookie");

      const isWrite = !READ_METHODS.has(method);
      const isOperator = url.pathname.startsWith("/__lazaret/operator/");
      if (!isWrite || isOperator) {
        return withCors(await gateway.fetch(new Request(request, { headers }), env, ctx), cors);
      }

      // ── A write: it will cost model calls ─────────────────────────────────────
      if (!pass || !(await checkPass(env.LAZARET_SIGNING_SECRET, pass, now()))) {
        return reply(401, { error: "demo_pass_required", verify: "/demo/verify" });
      }
      if (!(await limiters(env).write.limit({ key: ipKey })).success) {
        return reply(429, { error: "slow_down" }, { "retry-after": "60" });
      }
      const body = request.body ? await request.arrayBuffer() : null;
      if (body && body.byteLength > CONSOLE_MAX_BODY_BYTES) {
        return reply(413, { error: "payload_too_large", maxBytes: CONSOLE_MAX_BODY_BYTES });
      }

      const budget = budgetFor(env);
      if ((await budget.budgetStatus(PER_IP_DAILY_USD, ipKey)).exhausted) {
        return reply(429, { error: "ip_budget_spent", resetsAt: nextMidnight(now()) });
      }
      const isAgentRun = url.pathname === "/api/agent/run";
      if (isAgentRun) {
        const global = await budget.budgetStatus(config.review.dailyBudgetUsd);
        if (global.exhausted)
          return reply(503, { error: "budget_spent", resetsAt: global.resetsAt });
        const runs = await budget.budgetStatus(AGENT_RUNS_PER_IP_PER_DAY, `agent:${ipKey}`);
        if (runs.exhausted)
          return reply(429, { error: "agent_runs_spent", resetsAt: runs.resetsAt });
      }

      const res = await gateway.fetch(new Request(request, { headers, body }), env, ctx);

      // Charge this IP's share. Best effort: accounting must not fail a request that
      // already happened.
      const charges: Promise<unknown>[] = [];
      if (isAgentRun) {
        charges.push(Promise.resolve(budget.chargeSpend(1, `agent:${ipKey}`)));
        const usd = agentUsageUsd(res.headers.get("x-tidewater-usage"));
        if (usd > 0) {
          charges.push(Promise.resolve(budget.chargeSpend(usd)));
          charges.push(Promise.resolve(budget.chargeSpend(usd, ipKey)));
        }
      } else if (res.headers.has("x-lazaret-receipt")) {
        charges.push(Promise.resolve(budget.chargeSpend(ESTIMATE_USD.escrow, ipKey)));
      } else if (isInline(inlineRoutes, method, url.pathname)) {
        charges.push(Promise.resolve(budget.chargeSpend(ESTIMATE_USD.inline, ipKey)));
      }
      const charging = Promise.all(charges).catch((err: unknown) =>
        console.error(JSON.stringify({ demo: "charge_failed", error: String(err) })),
      );
      if (ctx) ctx.waitUntil(charging);
      else await charging;

      const out = withCors(res, cors);
      out.headers.delete("x-tidewater-usage");
      return out;
    },

    async scheduled(controller: ScheduledController, env: GuardEnv): Promise<void> {
      const at = controller.scheduledTime || now();
      if (controller.cron === "0 * * * *") {
        await hourlyReset(env, config, at);
        return;
      }
      await gateway.scheduled(controller, env);
      // Batches sealed just before the hour finish in the previous shard; keep
      // sweeping it so none is stranded by the rollover.
      const previous = config.ledger.shardAt(at - 3_600_000);
      if (previous !== config.ledger.shardAt(at)) {
        await env.LAZARET_LEDGER.get(env.LAZARET_LEDGER.idFromName(previous)).sweep();
      }
    },
  };
}

/**
 * On the hour: the new shard is already live (shards are named by the hour). Tell the
 * old shard's viewers to reconnect, and put origin back to its seed.
 */
export async function hourlyReset(env: GuardEnv, config: ResolvedConfig, at: number) {
  const previous = config.ledger.shardAt(at - 1);
  const closed = await env.LAZARET_LEDGER.get(env.LAZARET_LEDGER.idFromName(previous)).closeLive();
  const signature = await signRequest(
    {
      id: `reset-${crypto.randomUUID()}`,
      method: "POST",
      target: "/admin/reset",
      body: null,
      // Signed with the real clock: `at` is the cron's scheduled time, which only
      // names the shard and can be off by the cron's delay.
      timestamp: Math.floor(Date.now() / 1000),
    },
    env.LAZARET_SIGNING_SECRET,
  );
  const res = await env.ORIGIN.fetch(
    new Request(new URL("/admin/reset", config.origin), { method: "POST", headers: signature }),
  );
  console.log(
    JSON.stringify({ demo: "hourly_reset", previous, viewersClosed: closed, origin: res.status }),
  );
  if (!res.ok) throw new Error(`origin reset failed: ${res.status}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function corsHeaders(request: Request, env: GuardEnv): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = (env.DEMO_SITE_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-expose-headers":
      "x-lazaret-receipt, x-lazaret-review, x-lazaret-request-id, retry-after",
    vary: "origin",
  };
}

function withCors(res: Response, cors: Record<string, string>): Response {
  // A 101 carries a WebSocket; its headers can't change and CORS doesn't apply.
  if (res.status === 101 || !Object.keys(cors).length) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

function isInline(routes: ResolvedConfig["routes"], method: string, pathname: string): boolean {
  const { segments } = normalizePath(pathname);
  return routes.some((r) => matchPattern(r.pattern, method, segments) !== null);
}

/** Price an agent run from the usage origin reported. Malformed → 0 (and logged). */
export function agentUsageUsd(header: string | null): number {
  if (!header) return 0;
  try {
    const u = JSON.parse(header) as {
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
    return costUsd(String(u.model), {
      inputTokens: Number(u.inputTokens) || 0,
      outputTokens: Number(u.outputTokens) || 0,
      cacheReadTokens: Number(u.cacheReadTokens) || 0,
      cacheWriteTokens: Number(u.cacheWriteTokens) || 0,
    }).usd;
  } catch {
    console.error(JSON.stringify({ demo: "bad_usage_header" }));
    return 0;
  }
}

async function readToken(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { token?: unknown };
    return typeof body.token === "string" && body.token.length <= 2048 ? body.token : null;
  } catch {
    return null;
  }
}

async function siteverify(token: string, ip: string, secret: string): Promise<boolean> {
  // The published always-pass test secret: accept without a network call, so the
  // offline stack runs with no internet. It can't pass in production, where the real
  // secret is set (and Cloudflare's test secret would pass anyway).
  if (secret === TURNSTILE_TEST_SECRET) return true;
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  form.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  return res.ok && ((await res.json()) as { success?: boolean }).success === true;
}

function readPass(request: Request): string | null {
  const header = request.headers.get("x-demo-pass");
  if (header) return header;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === PASS_COOKIE) return v.join("=") || null;
  }
  return null;
}

function stripCookie(header: string | null, name: string): string {
  return (header ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${name}=`))
    .join("; ");
}

// A pass is `v1.<expires>.<sig>`, sig = HMAC-SHA256 over `demo-pass.v1.<expires>`,
// keyed by a key derived from the signing secret (a separate label, so a pass can
// never double as a request signature).
async function passKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    new TextEncoder().encode("lazaret-demo-pass-key"),
  );
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function mintPass(secret: string, expires: number): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await passKey(secret),
    new TextEncoder().encode(`demo-pass.v1.${expires}`),
  );
  return `v1.${expires}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function checkPass(secret: string, pass: string, at: number): Promise<boolean> {
  const [version, exp, sig] = pass.split(".");
  const expires = Number(exp);
  if (version !== "v1" || !sig || !Number.isSafeInteger(expires) || expires < at) return false;
  if (expires > at + PASS_TTL_MS) return false; // minted for longer than we ever mint
  const bytes = fromBase64Url(sig);
  if (!bytes) return false;
  return crypto.subtle.verify(
    "HMAC",
    await passKey(secret),
    bytes,
    new TextEncoder().encode(`demo-pass.v1.${expires}`),
  );
}

async function hashHex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest).slice(0, 12)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function nextMidnight(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The Turnstile interstitial for the Tidewater UI (same origin as this Worker). On
 * success it gets a pass cookie and returns to `next`, which must be a local path.
 */
function verifyPage(siteKey: string, next: string | null): string {
  const target = next?.startsWith("/") && !next.startsWith("//") ? next : "/";
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>One quick check</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f1e7; --ink: #1d2a33; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1a21; --ink: #e8e1d3; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg);
         color: var(--ink); font: 16px/1.5 system-ui, sans-serif; padding: 16px; }
  main { max-width: 32rem; }
</style>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head><body><main>
<h1>One quick check</h1>
<p>This demo calls a real AI reviewer, which costs money per request. A short check keeps bots from spending it.</p>
<div class="cf-turnstile" data-sitekey="${esc(siteKey)}" data-callback="onPass"></div>
<p id="msg" role="status"></p>
<script>
  async function onPass(token) {
    const res = await fetch("/demo/pass", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    if (res.ok) location.replace(${JSON.stringify(target).replaceAll("<", "\\u003c")});
    else document.getElementById("msg").textContent = "That didn't work. Reload the page to try again.";
  }
</script>
</main></body></html>`;
}
