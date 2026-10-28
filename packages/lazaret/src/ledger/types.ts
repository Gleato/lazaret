import type { GateSignal } from "../gate/signals";

// Core vocabulary of the Ledger. Everything here is plain JSON-serialisable data so
// it can cross Durable Object RPC, live in the SQLite event log, and be streamed to
// the live visualiser unchanged.

/**
 * Batch lifecycle (see tasks/todo.md §2.1):
 *   OPEN → SEALED → REVIEWING → COMMITTING → SETTLED
 *   REVIEWING → REVIEW_FAILED → REVIEWING (retry from checkpoint, principle 4)
 *   SEALED | REVIEWING | REVIEW_FAILED → QUARANTINED (fail closed)
 */
export type BatchStatus =
  | "OPEN"
  | "SEALED"
  | "REVIEWING"
  | "REVIEW_FAILED"
  | "COMMITTING"
  | "SETTLED"
  | "QUARANTINED";

/** Entry lifecycle: PENDING → APPROVED → COMMITTED, or PENDING → DROPPED | QUARANTINED. */
export type EntryStatus = "PENDING" | "APPROVED" | "DROPPED" | "QUARANTINED" | "COMMITTED";

/** Why a batch stopped accepting entries. `manual` is for operators and tests. */
export type SealReason = "timer" | "size" | "risk" | "manual";

export type Verdict = "allow" | "drop" | "quarantine";

/** The parts of an HTTP request the Committer needs to replay it to origin later. */
export interface CapturedRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string | null;
  /** Text bodies are stored as-is; anything else is base64 so bytes survive JSON. */
  bodyEncoding: "utf8" | "base64";
}

/** What the Gateway hands the Ledger for each escrowed write. */
export interface EntryInput {
  sessionId: string;
  request: CapturedRequest;
  /** Deterministic gate score in [0, 1]; drives the risk-spike seal trigger. */
  riskScore: number;
  /** Resource keys (e.g. `ticket:42`) used for taint propagation in M3. */
  resources: string[];
  /** The route pattern that matched, e.g. `POST /api/tickets`, or `fallback:write`. */
  route: string;
  /** Gate evidence, handed to the reviewer as pre-digested context. */
  signals: GateSignal[];
}

export interface VerdictRecord {
  verdict: Verdict;
  category: string;
  confidence: number;
  rationale: string;
}

export interface EntryState extends EntryInput {
  id: string;
  batchId: string;
  status: EntryStatus;
  receivedAt: number;
  verdict?: VerdictRecord;
  /** HTTP status origin returned when the Committer replayed this entry. */
  originStatus?: number;
}

export interface BatchState {
  id: string;
  status: BatchStatus;
  openedAt: number;
  entryIds: string[];
  reviewAttempts: number;
  sealedAt?: number;
  sealReason?: SealReason;
  lastError?: string;
  quarantineReason?: string;
  settledAt?: number;
}

/** The projection of the event log. Never persisted directly — always rebuilt by replay. */
export interface LedgerState {
  /** Number of events applied; equals the `seq` of the last event. */
  seq: number;
  openBatchId: string | null;
  nextBatchNumber: number;
  batches: Record<string, BatchState>;
  entries: Record<string, EntryState>;
  /** Sessions caught submitting a malicious write, and when (taint propagation, §2.3). */
  flaggedSessions: Record<string, { at: number; reason: string }>;
}
