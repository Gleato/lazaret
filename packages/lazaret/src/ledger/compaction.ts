import type { BatchState, EntryState, LedgerState } from "./types.ts";

// Log compaction (M8, decision-log #11). Without it, startup replay is O(log length)
// and the log grows forever. With it:
//
//   - the projection is snapshotted at the head seq, and replay is snapshot + tail;
//   - events at or before the snapshot are deleted, except a short tail kept so live
//     viewers that reconnect a little behind still get events, not a SNAPSHOT frame;
//   - terminal batches older than `retainSettledMs` are pruned from the projection,
//     so the snapshot stays bounded too.
//
// Pruning is the only thing here that changes state, and it only removes batches
// nothing can act on any more: SETTLED, every entry COMMITTED or DROPPED (nothing held,
// nothing released and waiting to commit), settled long enough ago. Their verdicts
// already went to the Memory archive, which the pipeline writes *before* commit
// (review/pipeline.ts), so the Memory never depended on the Ledger keeping them.
//
// What pruning does cost, by design: an operator report (`ENTRY_REPORTED`) on a pruned
// entry is refused as not found, and taint can no longer link a new write to a dropped
// one from a pruned batch. Keep `retainSettledMs` above the Memory's
// `trustAllowsAfterMs` (3 days by default) so a report is possible for as long as the
// Memory still treats the write as unconfirmed.

export interface CompactionConfig {
  /** Compact once the stored log holds more than this many events. */
  minEvents: number;
  /** Events kept after compaction, for live viewers resuming a little behind. */
  keepEvents: number;
  /** Terminal batches settled longer ago than this are pruned from the projection. */
  retainSettledMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_COMPACTION: CompactionConfig = {
  minEvents: 2_000,
  keepEvents: 500,
  retainSettledMs: 7 * DAY_MS,
};

export function validateCompactionConfig(config: CompactionConfig): CompactionConfig {
  const { minEvents, keepEvents, retainSettledMs } = config;
  if (!Number.isInteger(minEvents) || minEvents < 1) {
    throw new RangeError("compaction.minEvents must be a positive integer");
  }
  if (!Number.isInteger(keepEvents) || keepEvents < 0 || keepEvents >= minEvents) {
    throw new RangeError("compaction.keepEvents must be an integer in [0, minEvents)");
  }
  if (!(retainSettledMs >= 0)) throw new RangeError("compaction.retainSettledMs must be >= 0");
  return config;
}

/** Batches that can be dropped from the projection at `now`, oldest first. */
export function prunableBatches(
  state: LedgerState,
  now: number,
  retainSettledMs: number,
): BatchState[] {
  const n = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1));
  return Object.values(state.batches)
    .filter(
      (b) =>
        b.status === "SETTLED" &&
        b.settledAt !== undefined &&
        now - b.settledAt >= retainSettledMs &&
        b.entryIds.every((id) => {
          const s = state.entries[id]?.status;
          return s === "COMMITTED" || s === "DROPPED";
        }),
    )
    .sort((a, b) => n(a.id) - n(b.id));
}

/**
 * Remove prunable batches (and their entries) and expired session flags. Mutates
 * `state`, like `applyEvent`. Returns what was removed, for logging.
 */
export function pruneState(
  state: LedgerState,
  now: number,
  retainSettledMs: number,
  flagTtlMs: number,
): { batches: number; entries: number; flags: number } {
  let entries = 0;
  const batches = prunableBatches(state, now, retainSettledMs);
  for (const b of batches) {
    for (const id of b.entryIds) {
      delete state.entries[id];
      entries += 1;
    }
    delete state.batches[b.id];
  }
  // A flag only matters while it boosts risk (SESSION_FLAG_TTL_MS in the Ledger).
  let flags = 0;
  for (const [session, flag] of Object.entries(state.flaggedSessions)) {
    if (now - flag.at >= flagTtlMs) {
      delete state.flaggedSessions[session];
      flags += 1;
    }
  }
  return { batches: batches.length, entries, flags };
}

// ── Snapshot storage ────────────────────────────────────────────────────────────
// A Durable Object SQLite row is capped at 2 MB, and one batch can hold 500 entries of
// up to 96 KiB each, so the projection is stored one row per entry and per batch
// rather than as a single JSON blob.

export function migrateSnapshot(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS ledger_snapshot (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      seq               INTEGER NOT NULL,
      open_batch_id     TEXT,
      next_batch_number INTEGER NOT NULL,
      at                INTEGER NOT NULL
    )
  `);
  sql.exec(
    "CREATE TABLE IF NOT EXISTS ledger_snapshot_batches (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS ledger_snapshot_entries (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ledger_snapshot_flags (
       session_id TEXT PRIMARY KEY, at INTEGER NOT NULL, reason TEXT NOT NULL
     )`,
  );
}

/** Replace the stored snapshot with `state`. Call inside a transaction. */
export function writeSnapshot(sql: SqlStorage, state: LedgerState, at: number): void {
  sql.exec("DELETE FROM ledger_snapshot_batches");
  sql.exec("DELETE FROM ledger_snapshot_entries");
  sql.exec("DELETE FROM ledger_snapshot_flags");
  sql.exec(
    `INSERT OR REPLACE INTO ledger_snapshot (id, seq, open_batch_id, next_batch_number, at)
     VALUES (1, ?, ?, ?, ?)`,
    state.seq,
    state.openBatchId,
    state.nextBatchNumber,
    at,
  );
  for (const b of Object.values(state.batches)) {
    sql.exec(
      "INSERT INTO ledger_snapshot_batches (id, data) VALUES (?, ?)",
      b.id,
      JSON.stringify(b),
    );
  }
  for (const e of Object.values(state.entries)) {
    sql.exec(
      "INSERT INTO ledger_snapshot_entries (id, data) VALUES (?, ?)",
      e.id,
      JSON.stringify(e),
    );
  }
  for (const [session, flag] of Object.entries(state.flaggedSessions)) {
    sql.exec(
      "INSERT INTO ledger_snapshot_flags (session_id, at, reason) VALUES (?, ?, ?)",
      session,
      flag.at,
      flag.reason,
    );
  }
}

/** The stored snapshot, or null when the log has never been compacted. */
export function readSnapshot(sql: SqlStorage): LedgerState | null {
  const head = sql
    .exec<{ seq: number; open_batch_id: string | null; next_batch_number: number }>(
      "SELECT seq, open_batch_id, next_batch_number FROM ledger_snapshot WHERE id = 1",
    )
    .toArray()[0];
  if (!head) return null;
  const batches: Record<string, BatchState> = {};
  for (const row of sql.exec<{ id: string; data: string }>(
    "SELECT id, data FROM ledger_snapshot_batches ORDER BY rowid",
  )) {
    batches[row.id] = JSON.parse(row.data) as BatchState;
  }
  const entries: Record<string, EntryState> = {};
  for (const row of sql.exec<{ id: string; data: string }>(
    "SELECT id, data FROM ledger_snapshot_entries ORDER BY rowid",
  )) {
    entries[row.id] = JSON.parse(row.data) as EntryState;
  }
  const flaggedSessions: LedgerState["flaggedSessions"] = {};
  for (const row of sql.exec<{ session_id: string; at: number; reason: string }>(
    "SELECT session_id, at, reason FROM ledger_snapshot_flags ORDER BY rowid",
  )) {
    flaggedSessions[row.session_id] = { at: row.at, reason: row.reason };
  }
  return {
    seq: head.seq,
    openBatchId: head.open_batch_id,
    nextBatchNumber: head.next_batch_number,
    batches,
    entries,
    flaggedSessions,
  };
}
