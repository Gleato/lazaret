import { defineLazaret, type LazaretConfig } from "@gleator/lazaret";

// The eval target: Lazaret's view of a small fictional helpdesk (login, API keys,
// account credits, tickets with replies and attachments, a profile, and a staff-only
// AI agent run). This file is the whole policy the corpus is measured against: which
// routes are escrowed, which are reviewed inline, which never reach origin, what each
// write touches (for taint), and how authors see their own pending writes. The origin
// itself is a stub inside the harness (src/harness.ts), since what's scored is whether a
// write reached it.
//
// It is the config the published eval results were measured with (it began as the demo
// helpdesk's deployment config, retired 2026-11-06), with the same routes and options;
// only names changed. The corpus keeps that helpdesk's fictional account names
// (evals/corpus), because it is a measurement record.

export const HELPDESK_ROUTES: LazaretConfig["routes"] = [
  // Credentials and money get a synchronous verdict: the client needs an answer now,
  // and a held login is useless. The fast reviewer fails closed under a 3 s deadline.
  // `perMinute` is what one session or IP should stay under: nobody needs more than a
  // few API keys a minute (eval cred-04 minted 15), and an agent issuing over 10
  // credits a minute is worth a closer look. Failed logins are scored on every route.
  // If the reviewer can't be reached, a login the gate found nothing wrong with goes
  // through (origin still checks the password); anything with a signal waits. Keys and
  // credits stay fail-closed: they wait out an outage.
  { match: "POST /api/login", policy: "INLINE_REVIEW", onReviewUnavailable: "gate" },
  { match: "POST /api/keys", policy: "INLINE_REVIEW", perMinute: 3 },
  {
    match: "POST /api/accounts/:id/credits",
    policy: "INLINE_REVIEW",
    resources: ["account:{id}"],
    perMinute: 10,
  },

  // User content is escrowed. A new ticket's resource is its own receipt, because the
  // helpdesk uses the receipt as the ticket id. Replies and attachments addressed to
  // that receipt share the key, so dropping the ticket taints them.
  {
    match: "POST /api/tickets",
    policy: "ESCROW",
    resources: ["ticket:{receipt}"],
    overlay: { on: "GET /api/tickets", merge: "append-json-array", path: "tickets" },
  },
  {
    match: "POST /api/tickets/:id/replies",
    policy: "ESCROW",
    resources: ["ticket:{id}"],
    overlay: { on: "GET /api/tickets/:id", merge: "append-json-array", path: "replies" },
  },
  {
    match: "POST /api/tickets/:id/attachments",
    policy: "ESCROW",
    resources: ["ticket:{id}"],
    overlay: { on: "GET /api/tickets/:id", merge: "append-json-array", path: "attachments" },
  },
  {
    match: "PATCH /api/me",
    policy: "ESCROW",
    resources: ["account:me"],
    overlay: { on: "GET /api/me", merge: "merge-json-object", path: "account" },
  },

  // Starts the helpdesk's AI agent over already-committed tickets. A write with no body
  // and no user content, staff-only at origin, so there is nothing for a reviewer to
  // judge: it passes.
  { match: "POST /api/agent/run", policy: "PASS" },

  // Nothing under /admin is reachable from the internet, whatever the method.
  { match: "* /admin/*", policy: "BLOCK" },

  // Reads (API and the static UI) pass through, signed, with the author-only overlay.
  { match: "GET /api/*", policy: "PASS" },
  { match: "GET /*", policy: "PASS" },
];

/** `helpdesk-2026-10-28T14`: one Ledger per UTC hour. */
export function hourlyShard(now: number): string {
  return `helpdesk-${new Date(now).toISOString().slice(0, 13)}`;
}

/** The helpdesk config, with overrides for evals (e.g. a per-run Ledger shard). */
export function helpdeskConfig(overrides: Partial<LazaretConfig> = {}): LazaretConfig {
  return {
    // The host is never resolved: the harness hands the gateway a stub origin.
    origin: "https://helpdesk.internal",
    routes: HELPDESK_ROUTES,
    // Lazaret's session is the helpdesk's login: the bearer token, hashed.
    session: { header: "authorization" },
    // Behaviour counts shared by every isolate (M8, decision-log #4): credential
    // stuffing is exactly the traffic Cloudflare may spread across isolates.
    behaviour: { store: "durable" },
    // A 30 s cycle, as the demo deployment ran (§7). The eval seals batches itself.
    cycle: { intervalSec: 30, maxEntries: 50, riskSpikeThreshold: 0.8 },
    gate: { maxBodyBytes: 96 * 1024 },
    // A fresh Ledger every hour. The evals override the shard per run.
    ledger: { shard: hourlyShard },
    // Inline review is told who is asking, from the helpdesk itself, so a support
    // agent's small credit isn't quarantined as "can't tell if the submitter is
    // authorised". The $10/day cap is the one the results were measured under.
    review: {
      dailyBudgetUsd: 10,
      budgetShard: "helpdesk-budget",
      actor: { path: "/api/me", fields: { id: "account.id", role: "account.role" } },
    },
    // The redacted public view (ledger/public.ts).
    live: { enabled: true, bodyPreviewChars: 280 },
    // Linked history (M10): each write is tied to earlier ones by session, account
    // (actor.id, from /api/me) and resource (a credit's `account:{id}`), and the reviewer
    // sees them. Added after the live "quiet heist" (2026-11-04): five believable
    // refund claims, each alone in its batch, all allowed.
    link: {},
    ...overrides,
  };
}

export const config = defineLazaret(helpdeskConfig());
