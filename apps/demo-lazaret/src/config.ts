import { defineLazaret, type LazaretConfig } from "@gleator/lazaret";

// Lazaret's view of Tidewater Support (tasks/todo.md §6). This file is the whole
// policy: which routes are escrowed, which are reviewed inline, which never reach
// origin, what each write touches (for taint), and how authors see their own
// pending writes. Tidewater's code doesn't change when this does.

export const TIDEWATER_ROUTES: LazaretConfig["routes"] = [
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

  // User content is escrowed. A new ticket's resource is its own receipt, because
  // Tidewater uses the receipt as the ticket id. Replies and attachments addressed to
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

  // Starts Tidewater's AI agent over already-committed tickets. A write with no body
  // and no user content, staff-only at origin, so there is nothing for a reviewer to
  // judge: it passes. (Its cost is capped in M7 with the demo's spend guard.)
  { match: "POST /api/agent/run", policy: "PASS" },

  // Nothing under /admin is reachable from the internet, whatever the method.
  { match: "* /admin/*", policy: "BLOCK" },

  // Reads (API and the static UI) pass through, signed, with the author-only overlay.
  { match: "GET /api/*", policy: "PASS" },
  { match: "GET /*", policy: "PASS" },
];

/** The Tidewater config, with overrides for tests (e.g. a per-test Ledger shard). */
export function tidewaterConfig(overrides: Partial<LazaretConfig> = {}): LazaretConfig {
  return {
    // Reached through the ORIGIN service binding; the host is never resolved.
    origin: "https://tidewater.internal",
    routes: TIDEWATER_ROUTES,
    // Lazaret's session is Tidewater's login: the bearer token, hashed.
    session: { header: "authorization" },
    // Demo pacing (§7): a 30 s cycle, so visitors see a batch go through review.
    cycle: { intervalSec: 30, maxEntries: 50, riskSpikeThreshold: 0.8 },
    gate: { maxBodyBytes: 96 * 1024 },
    // Inline review is told who is asking, from Tidewater itself, so a support agent's
    // small credit isn't quarantined as "can't tell if the submitter is authorised".
    review: {
      dailyBudgetUsd: 5,
      actor: { path: "/api/me", fields: { id: "account.id", role: "account.role" } },
    },
    ...overrides,
  };
}

export const config = defineLazaret(tidewaterConfig());
