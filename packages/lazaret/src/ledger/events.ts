import type { EntryInput, SealReason, VerdictRecord } from "./types";

// The append-only event log is the source of truth (principle 3). Every state change
// is one of these events; the in-memory state is a fold over them. Events carry
// their own timestamp so replay is deterministic and never consults the clock.

export type LedgerEvent =
  | { type: "BATCH_OPENED"; batchId: string; at: number }
  | { type: "ENTRY_APPENDED"; entryId: string; batchId: string; entry: EntryInput; at: number }
  | { type: "BATCH_SEALED"; batchId: string; reason: SealReason; at: number }
  | { type: "REVIEW_STARTED"; batchId: string; attempt: number; at: number }
  | { type: "REVIEW_FAILED"; batchId: string; attempt: number; error: string; at: number }
  | { type: "ENTRY_VERDICT"; entryId: string; verdict: VerdictRecord; at: number }
  | { type: "COMMIT_STARTED"; batchId: string; at: number }
  | { type: "ENTRY_COMMITTED"; entryId: string; originStatus?: number; at: number }
  | { type: "BATCH_SETTLED"; batchId: string; at: number }
  | { type: "BATCH_QUARANTINED"; batchId: string; reason: string; at: number }
  | { type: "SESSION_FLAGGED"; sessionId: string; reason: string; at: number };

export type LedgerEventType = LedgerEvent["type"];

/** An event as stored in the log, with its position. */
export interface StoredEvent {
  seq: number;
  event: LedgerEvent;
}
