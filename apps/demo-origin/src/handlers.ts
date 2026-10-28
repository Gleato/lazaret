import { runAgent, SCENARIOS, type ScenarioId, simulateLazaretOff } from "./agent/run";
import type { AgentTicket, SupportAgent } from "./agent/types";
import { type Account, authenticate, getAccount, login, randomToken, sha256Hex } from "./auth";
import { onceByLazaretId, type WriteResult } from "./dedupe";
import { HttpError, json, parseJsonObject, str } from "./http";
import type { Route } from "./router";
import { resetDemo } from "./seed";

// Tidewater's API (tasks/todo.md §6). Policies are Lazaret's business, set in
// apps/demo-lazaret. This file is just a helpdesk, written the way you'd write one
// anyway: validate input, check ownership, keep an allow-list for profile fields.
// That is defence in depth: Lazaret should drop a mass-assignment attempt, and if
// it ever didn't, origin would still ignore `role`.

export interface Ctx {
  db: D1Database;
  request: Request;
  /** The verified Lazaret request id. For committed writes, the Ledger entry id. */
  lazaretId: string;
  body: Uint8Array;
  path: string;
  now: number;
  /** Tidewater's AI support agent, or null if it isn't configured (no API key). */
  agent: () => SupportAgent | null;
}

const MAX_ATTACHMENT_BYTES = 64 * 1024;
const MAX_CREDIT_CENTS = 50_000;
const ATTACHMENT_TYPES = new Set(["text/plain", "image/png", "image/jpeg", "application/pdf"]);

async function requireAccount(ctx: Ctx): Promise<Account> {
  const account = await authenticate(ctx.db, ctx.request, ctx.now);
  if (!account) throw new HttpError(401, "sign in required");
  return account;
}

const isStaff = (a: Account) => a.role === "agent" || a.role === "admin";

/** Open tickets as the agent sees them. Only committed rows exist, so all were vetted. */
const AGENT_QUEUE_SQL = `SELECT t.id, t.account_id, a.display_name AS customer, t.subject, t.body
  FROM tickets t JOIN accounts a ON a.id = t.account_id WHERE t.status = 'open'`;

/** Wrap a write handler in Lazaret-id dedupe. A thrown HttpError becomes a recorded refusal. */
function write(fn: (ctx: Ctx, params: Record<string, string>) => Promise<WriteResult>) {
  return (ctx: Ctx, params: Record<string, string>) =>
    onceByLazaretId(
      ctx.db,
      { id: ctx.lazaretId, method: ctx.request.method, path: ctx.path, now: ctx.now },
      async () => {
        try {
          return await fn(ctx, params);
        } catch (err) {
          if (err instanceof HttpError && err.status < 500)
            return { status: err.status, body: { error: err.message }, statements: [] };
          throw err;
        }
      },
    );
}

interface TicketRow {
  id: string;
  account_id: string;
  subject: string;
  body: string;
  status: string;
  created_at: number;
  updated_at: number;
}

async function loadTicket(ctx: Ctx, account: Account, id: string): Promise<TicketRow> {
  const ticket = await ctx.db
    .prepare("SELECT * FROM tickets WHERE id = ?")
    .bind(id)
    .first<TicketRow>();
  // Someone else's ticket is a 404, not a 403, so ticket ids can't be probed.
  if (!ticket || (!isStaff(account) && ticket.account_id !== account.id))
    throw new HttpError(404, "ticket not found");
  return ticket;
}

export const routes: Route<Ctx>[] = [
  {
    // Not deduped: login is INLINE_REVIEW, so the gateway forwards it exactly once, and
    // its response holds a fresh token that must never be stored in plain text.
    method: "POST",
    path: "/api/login",
    handler: async (ctx) => {
      const input = parseJsonObject(ctx.body);
      const result = await login(
        ctx.db,
        str(input, "email", { max: 254 }),
        str(input, "password", { max: 200 }),
        ctx.now,
      );
      return json(200, result);
    },
  },
  {
    // Same reasoning as login: the plaintext key is shown once and never stored.
    method: "POST",
    path: "/api/keys",
    handler: async (ctx) => {
      const account = await requireAccount(ctx);
      const label = str(parseJsonObject(ctx.body), "label", { max: 60 });
      const key = randomToken("twk");
      await ctx.db
        .prepare(
          "INSERT INTO api_keys (id, account_id, label, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(ctx.lazaretId, account.id, label, key.slice(0, 10), await sha256Hex(key), ctx.now)
        .run();
      return json(201, { id: ctx.lazaretId, label, key });
    },
  },
  {
    method: "GET",
    path: "/api/me",
    handler: async (ctx) => json(200, { account: await requireAccount(ctx) }),
  },
  {
    method: "PATCH",
    path: "/api/me",
    handler: write(async (ctx) => {
      const account = await requireAccount(ctx);
      const input = parseJsonObject(ctx.body);
      // Allow-list. Anything else (`role`, `balance_cents`, ...) is ignored and reported.
      const updates: { display_name?: string; email_notifications?: number } = {};
      if ("display_name" in input) updates.display_name = str(input, "display_name", { max: 80 });
      if ("email_notifications" in input) {
        if (typeof input.email_notifications !== "boolean")
          throw new HttpError(400, "email_notifications must be a boolean");
        updates.email_notifications = input.email_notifications ? 1 : 0;
      }
      const ignored = Object.keys(input).filter((k) => !(k in updates));
      const next = { ...account, ...updates };
      return {
        status: 200,
        body: { account: next, ignored },
        statements: [
          ctx.db
            .prepare("UPDATE accounts SET display_name = ?, email_notifications = ? WHERE id = ?")
            .bind(next.display_name, next.email_notifications, account.id),
        ],
      };
    }),
  },
  {
    method: "GET",
    path: "/api/tickets",
    handler: async (ctx) => {
      const account = await requireAccount(ctx);
      const base = `SELECT t.id, t.account_id, a.display_name AS customer, t.subject, t.body, t.status,
                    t.created_at, t.updated_at,
                    (SELECT COUNT(*) FROM replies r WHERE r.ticket_id = t.id) AS reply_count
                    FROM tickets t JOIN accounts a ON a.id = t.account_id`;
      const { results } = isStaff(account)
        ? await ctx.db.prepare(`${base} ORDER BY t.created_at DESC LIMIT 100`).all()
        : await ctx.db
            .prepare(`${base} WHERE t.account_id = ? ORDER BY t.created_at DESC LIMIT 100`)
            .bind(account.id)
            .all();
      return json(200, { tickets: results });
    },
  },
  {
    method: "GET",
    path: "/api/tickets/:id",
    handler: async (ctx, { id }) => {
      const account = await requireAccount(ctx);
      const ticket = await loadTicket(ctx, account, id as string);
      const [replies, attachments] = await ctx.db.batch([
        ctx.db
          .prepare(
            `SELECT r.id, r.body, r.created_at, a.display_name AS author, a.role AS author_role
             FROM replies r JOIN accounts a ON a.id = r.author_id
             WHERE r.ticket_id = ? ORDER BY r.created_at`,
          )
          .bind(ticket.id),
        ctx.db
          .prepare(
            "SELECT id, filename, content_type, size, created_at FROM attachments WHERE ticket_id = ? ORDER BY created_at",
          )
          .bind(ticket.id),
      ]);
      return json(200, {
        ticket,
        replies: replies?.results ?? [],
        attachments: attachments?.results ?? [],
      });
    },
  },
  {
    method: "POST",
    path: "/api/tickets",
    handler: write(async (ctx) => {
      const account = await requireAccount(ctx);
      const input = parseJsonObject(ctx.body);
      const ticket = {
        // Receipt id convention: the ticket's id is the Lazaret entry id that created it.
        id: ctx.lazaretId,
        account_id: account.id,
        subject: str(input, "subject", { max: 120 }),
        body: str(input, "body", { max: 5000 }),
        status: "open",
        created_at: ctx.now,
        updated_at: ctx.now,
      };
      return {
        status: 201,
        body: { ticket },
        statements: [
          ctx.db
            .prepare(
              "INSERT INTO tickets (id, account_id, subject, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(...Object.values(ticket)),
        ],
      };
    }),
  },
  {
    method: "POST",
    path: "/api/tickets/:id/replies",
    handler: write(async (ctx, { id }) => {
      const account = await requireAccount(ctx);
      // If `id` is the receipt of a ticket that hasn't committed yet, this is a 404.
      // Within one batch that can't happen (commits replay in order); across batches
      // it can, and is a documented limit (tasks/todo.md, M6 review).
      const ticket = await loadTicket(ctx, account, id as string);
      const reply = {
        id: ctx.lazaretId,
        ticket_id: ticket.id,
        author_id: account.id,
        body: str(parseJsonObject(ctx.body), "body", { max: 5000 }),
        created_at: ctx.now,
      };
      return {
        status: 201,
        body: { reply },
        statements: [
          ctx.db
            .prepare(
              "INSERT INTO replies (id, ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(...Object.values(reply)),
          ctx.db
            .prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?")
            .bind(isStaff(account) ? "answered" : "open", ctx.now, ticket.id),
        ],
      };
    }),
  },
  {
    method: "POST",
    path: "/api/tickets/:id/attachments",
    handler: write(async (ctx, { id }) => {
      const account = await requireAccount(ctx);
      const ticket = await loadTicket(ctx, account, id as string);
      const input = parseJsonObject(ctx.body);
      const filename = str(input, "filename", { max: 100 });
      if (!/^[\w. -]+$/.test(filename) || filename.startsWith("."))
        throw new HttpError(400, "filename has unsupported characters");
      const contentType = str(input, "content_type", { max: 100 });
      if (!ATTACHMENT_TYPES.has(contentType))
        throw new HttpError(415, "unsupported attachment type");
      const content = str(input, "content_base64", {
        max: Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4,
      });
      let size: number;
      try {
        size = atob(content).length;
      } catch {
        throw new HttpError(400, "content_base64 is not valid base64");
      }
      const attachment = {
        id: ctx.lazaretId,
        ticket_id: ticket.id,
        author_id: account.id,
        filename,
        content_type: contentType,
        size,
        content_base64: content,
        created_at: ctx.now,
      };
      const { content_base64: _, ...summary } = attachment;
      return {
        status: 201,
        body: { attachment: summary },
        statements: [
          ctx.db
            .prepare(
              `INSERT INTO attachments (id, ticket_id, author_id, filename, content_type, size, content_base64, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(...Object.values(attachment)),
        ],
      };
    }),
  },
  {
    method: "POST",
    path: "/api/accounts/:id/credits",
    handler: write(async (ctx, { id }) => {
      const account = await requireAccount(ctx);
      if (!isStaff(account)) throw new HttpError(403, "only support agents can issue credits");
      const target = await getAccount(ctx.db, id as string);
      if (target?.role !== "customer") throw new HttpError(404, "customer not found");
      const input = parseJsonObject(ctx.body);
      const amount = input.amount_cents;
      if (
        !Number.isInteger(amount) ||
        (amount as number) <= 0 ||
        (amount as number) > MAX_CREDIT_CENTS
      )
        throw new HttpError(400, `amount_cents must be an integer from 1 to ${MAX_CREDIT_CENTS}`);
      const credit = {
        id: ctx.lazaretId,
        account_id: target.id,
        amount_cents: amount as number,
        reason: str(input, "reason", { max: 500 }),
        issued_by: account.id,
        created_at: ctx.now,
      };
      return {
        status: 201,
        body: { credit, balance_cents: target.balance_cents + credit.amount_cents },
        statements: [
          ctx.db
            .prepare(
              "INSERT INTO credits (id, account_id, amount_cents, reason, issued_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(...Object.values(credit)),
          ctx.db
            .prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?")
            .bind(credit.amount_cents, target.id),
        ],
      };
    }),
  },
  {
    // Run the AI agent over open, committed tickets that have no proposal yet. Every
    // ticket here has passed Lazaret's review: that's the point.
    method: "POST",
    path: "/api/agent/run",
    handler: async (ctx) => {
      const account = await requireAccount(ctx);
      if (!isStaff(account)) throw new HttpError(403, "staff only");
      const agent = ctx.agent();
      if (!agent) throw new HttpError(503, "support agent is not configured");
      const { results: queue } = await ctx.db
        .prepare(
          `${AGENT_QUEUE_SQL} AND NOT EXISTS (SELECT 1 FROM refund_proposals p WHERE p.ticket_id = t.id)
           ORDER BY t.created_at LIMIT 10`,
        )
        .all<AgentTicket>();
      const run = await runAgent(agent, queue);
      // The run's token usage, for the public demo's spend cap (apps/demo-lazaret
      // guard.ts charges it and strips the header before the response leaves).
      const usage = agent.usage
        ? { "x-tidewater-usage": JSON.stringify({ model: agent.model, ...agent.usage }) }
        : undefined;
      if (run.proposals.length) {
        await ctx.db.batch(
          run.proposals.map((p) =>
            ctx.db
              .prepare(
                `INSERT OR IGNORE INTO refund_proposals
                 (id, ticket_id, account_id, decision, amount_cents, reason, model, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                crypto.randomUUID(),
                p.ticket_id,
                p.account_id,
                p.decision,
                p.amount_cents,
                p.reason,
                run.agent,
                ctx.now,
              ),
          ),
        );
      }
      return json(200, run, usage);
    },
  },
  {
    method: "GET",
    path: "/api/agent/proposals",
    handler: async (ctx) => {
      const account = await requireAccount(ctx);
      if (!isStaff(account)) throw new HttpError(403, "staff only");
      const { results } = await ctx.db
        .prepare(
          `SELECT p.*, t.subject, a.display_name AS customer FROM refund_proposals p
           JOIN tickets t ON t.id = p.ticket_id JOIN accounts a ON a.id = p.account_id
           ORDER BY p.created_at DESC LIMIT 50`,
        )
        .all();
      return json(200, { proposals: results });
    },
  },
  {
    // The sandboxed "Lazaret off" replay. Read-only, canned scenarios, scripted agent.
    method: "GET",
    path: "/api/agent/simulate",
    handler: async (ctx) => {
      const account = await requireAccount(ctx);
      if (!isStaff(account)) throw new HttpError(403, "staff only");
      const scenario = new URL(ctx.request.url).searchParams.get("scenario") ?? "refund-hijack";
      if (!(scenario in SCENARIOS)) throw new HttpError(400, "unknown scenario");
      const { results: committed } = await ctx.db
        .prepare(`${AGENT_QUEUE_SQL} ORDER BY t.created_at DESC LIMIT 5`)
        .all<AgentTicket>();
      return json(200, await simulateLazaretOff(committed.reverse(), scenario as ScenarioId));
    },
  },
  {
    // The public demo's hourly reset (seed.ts). Lazaret BLOCKs `/admin/*` at the edge,
    // so only the demo guard, calling origin directly over the service binding with a
    // signed request, gets here. No account is involved: the signature is the check.
    method: "POST",
    path: "/admin/reset",
    handler: async (ctx) => {
      await resetDemo(ctx.db);
      return json(200, { reset: true, at: ctx.now });
    },
  },
  {
    // Lazaret BLOCKs `/admin/*` at the edge. Origin still checks the role.
    method: "GET",
    path: "/admin/accounts",
    handler: async (ctx) => {
      const account = await requireAccount(ctx);
      if (account.role !== "admin") throw new HttpError(403, "admin only");
      const { results } = await ctx.db
        .prepare("SELECT id, email, display_name, role, balance_cents FROM accounts")
        .all();
      return json(200, { accounts: results });
    },
  },
];
