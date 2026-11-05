import type { Verdict } from "./types.ts";

// Linked history (M10, tasks/todo.md). Lazaret used to judge each write against its own
// batch only, so fraud split across batches (five believable refund claims, each alone
// in its 30 s batch) never looked like a pattern: the live "quiet heist" of 2026-11-04
// paid out $190. Now every write carries link keys, and the reviewer sees the recent
// writes that share a key with it, with the verdicts they got.
//
// Keys, built by the gateway (linkKeys below):
//   session:<id>    the same login
//   actor:<id>      the same account, as origin reports it (survives a new sign-in)
//   resource:<key>  the same resource, e.g. `account:acct_mara` on a credit, which links
//                   credits paid to one customer whoever issues them
//
// The history lives in its own table in the Ledger, outside the event log. It is a
// derived index, not state: compaction prunes settled entries, and this has to outlive
// them for the length of the window. Batch verdicts are written to it in the same
// transaction as the verdict events; inline decisions as they happen.

export type LinkKind = "session" | "actor" | "resource";

/** What the reviewer is told about one earlier linked write. */
export interface LinkedWrite {
  entryId: string;
  at: number;
  route: string;
  method: string;
  /**
   * The request path, e.g. `/api/accounts/acct_ines/credits`. The route pattern alone
   * hides which customer a credit went to, and a support agent crediting four different
   * customers then looked like four credits to one (first live M10 run, 2026-11-05).
   */
  path: string;
  /** The start of the body, or null for none or binary. */
  preview: string | null;
  verdict: Verdict;
  category: string;
  /** Which keys it shares with the write under review, e.g. ["same signed-in account"]. */
  linkedBy: string[];
  /** Held by a `hold` rule rather than judged by a reviewer (M11). */
  held?: boolean;
}

export interface LinkRow {
  entryId: string;
  keys: string[];
  at: number;
  route: string;
  method: string;
  path: string;
  preview: string | null;
  verdict: Verdict;
  category: string;
  /** Held by a `hold` rule rather than judged by a reviewer (M11). */
  held?: boolean;
}

/** Rows are kept this long whatever the window, so a longer window later still has data. */
export const LINK_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_LINK_KEYS = 16;
const MAX_KEY_CHARS = 200;
const MAX_PREVIEW_CHARS = 400;

export function migrateLinks(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS linked_writes (
      entry_id TEXT    NOT NULL,
      link_key TEXT    NOT NULL,
      at       INTEGER NOT NULL,
      payload  TEXT    NOT NULL,
      PRIMARY KEY (link_key, entry_id)
    )
  `);
  sql.exec("CREATE INDEX IF NOT EXISTS linked_writes_at ON linked_writes (at)");
}

/** Shape check at the RPC boundary: keys come from the gateway, built from client input. */
export function validLinkKeys(keys: unknown): keys is string[] {
  return (
    Array.isArray(keys) &&
    keys.length <= MAX_LINK_KEYS &&
    keys.every((k) => typeof k === "string" && k.length > 0 && k.length <= MAX_KEY_CHARS)
  );
}

/** Index decided writes under each of their keys. Re-recording an entry overwrites it. */
export function recordLinks(sql: SqlStorage, rows: LinkRow[], now: number): void {
  for (const row of rows) {
    if (!row.keys.length) continue;
    const payload = JSON.stringify({
      route: row.route.slice(0, 200),
      method: row.method.slice(0, 16),
      path: row.path.slice(0, 300),
      preview: row.preview?.slice(0, MAX_PREVIEW_CHARS) ?? null,
      verdict: row.verdict,
      category: row.category.slice(0, 64),
      ...(row.held ? { held: true } : {}),
    });
    for (const key of new Set(row.keys)) {
      sql.exec(
        "INSERT OR REPLACE INTO linked_writes (entry_id, link_key, at, payload) VALUES (?, ?, ?, ?)",
        row.entryId,
        key,
        row.at,
        payload,
      );
    }
  }
  sql.exec("DELETE FROM linked_writes WHERE at < ?", now - LINK_RETAIN_MS);
}

/**
 * Recent writes sharing any of `keys`, newest first, one per entry with every key it
 * matched. `exclude` keeps out the write itself and the rest of its batch, which the
 * reviewer already sees in full.
 */
export function readLinks(
  sql: SqlStorage,
  keys: string[],
  options: { since: number; limit: number; exclude?: Set<string> },
): LinkedWrite[] {
  if (options.limit <= 0) return [];
  return relevantLinks(sql, keys, options)
    .slice(0, options.limit)
    .map(({ fromSender: _s, viaResource: _r, ...w }) => w);
}

/** Linked writes, how they link, already filtered to the ones that count as evidence. */
function relevantLinks(
  sql: SqlStorage,
  keys: string[],
  options: { since: number; exclude?: Set<string> },
): (LinkedWrite & { fromSender: boolean; viaResource: boolean })[] {
  if (!keys.length) return [];
  const placeholders = keys.map(() => "?").join(", ");
  const rows = sql
    .exec<{ entry_id: string; link_key: string; at: number; payload: string }>(
      `SELECT entry_id, link_key, at, payload FROM linked_writes
       WHERE link_key IN (${placeholders}) AND at >= ?
       ORDER BY at DESC, entry_id`,
      ...keys,
      options.since,
    )
    .toArray();
  const byEntry = new Map<string, LinkedWrite & { fromSender: boolean; viaResource: boolean }>();
  for (const row of rows) {
    if (options.exclude?.has(row.entry_id)) continue;
    const viaResource = row.link_key.startsWith("resource:");
    const seen = byEntry.get(row.entry_id);
    if (seen) {
      seen.linkedBy.push(describeKey(row.link_key));
      seen.fromSender ||= !viaResource;
      seen.viaResource ||= viaResource;
      continue;
    }
    const p = JSON.parse(row.payload) as Omit<LinkedWrite, "entryId" | "at" | "linkedBy">;
    byEntry.set(row.entry_id, {
      entryId: row.entry_id,
      at: row.at,
      ...p,
      linkedBy: [describeKey(row.link_key)],
      fromSender: !viaResource,
      viaResource,
    });
  }
  // Someone else's write on the same resource counts only if it was allowed. Their
  // dropped or held attempts say nothing about this sender, and showing them let an
  // attacker poison a victim's account: the first full live run (2026-11-05) held four
  // honest writes, each because other senders had just attacked the same customer
  // account or ticket. What got through to that resource is still evidence (several
  // credits paid to one customer), and a sender's own failures still count against it.
  return [...byEntry.values()].filter((w) => w.fromSender || w.verdict === "allow");
}

/**
 * Most writes one sender may have held by rules in an hour (M11). Past it, a matching
 * write goes to the reviewer instead: a wrong rule can delay a customer's writes, but
 * can't quietly swallow all of them.
 */
export const HOLD_CAP_PER_HOUR = 5;

/** Window of the count signals (M11). One hour, decided at check-in (tasks/todo.md). */
export const LINK_COUNT_WINDOW_MS = 60 * 60 * 1000;

export interface LinkCounts {
  /** Earlier writes on this route from the same login session or signed-in account. */
  senderRoute: number;
  /** Earlier writes on this route acting on the same resource (others': allowed only). */
  resourceRoute: number;
  /** This sender's writes held by a `hold` rule in the hour, on any route (the cap). */
  heldSender: number;
}

/**
 * The numbers behind the `linked.*` count signals (M11), over the last hour: how many
 * earlier decided writes on the same route share a sender key, and how many share a
 * resource key, filtered exactly as the reviewer's history is. A rule can then say
 * "a third refund claim from one sender in an hour" without a new rule language.
 */
export function countLinks(
  sql: SqlStorage,
  keys: string[],
  route: string,
  now: number,
): LinkCounts {
  const hour = relevantLinks(sql, keys, { since: now - LINK_COUNT_WINDOW_MS });
  const linked = hour.filter((w) => w.route === route);
  return {
    senderRoute: linked.filter((w) => w.fromSender).length,
    resourceRoute: linked.filter((w) => w.viaResource).length,
    heldSender: hour.filter((w) => w.fromSender && w.held).length,
  };
}

/**
 * What a key tells the reviewer, in words it can't misread. The first live run labelled
 * an actor link "account", and the reviewer took a support agent's own account for the
 * customer being credited: four credits to four customers read as four to one. So the
 * signed-in account is named as the one making the request, and a resource as the
 * thing acted on. Session ids are hashes and mean nothing to it, so they aren't shown.
 */
function describeKey(key: string): string {
  if (key.startsWith("session:")) return "same login session";
  if (key.startsWith("actor:")) return "sent by the same signed-in account";
  return `acts on the same ${key.slice("resource:".length)}`;
}

/**
 * The keys for one write. Resources link only when their template names a parameter:
 * a constant like `account:me` would otherwise link every user's profile update to
 * everyone else's.
 */
export function linkKeys(
  by: LinkKind[],
  input: {
    sessionId: string | null;
    actorId?: string | null;
    resourceTemplates: string[];
    resources: string[];
  },
): string[] {
  const keys: string[] = [];
  if (by.includes("session") && input.sessionId) keys.push(`session:${input.sessionId}`);
  if (by.includes("actor") && input.actorId) keys.push(`actor:${input.actorId}`);
  if (by.includes("resource")) {
    input.resources.forEach((r, i) => {
      if (input.resourceTemplates[i]?.includes("{")) keys.push(`resource:${r}`);
    });
  }
  return keys.slice(0, MAX_LINK_KEYS).map((k) => k.slice(0, MAX_KEY_CHARS));
}
