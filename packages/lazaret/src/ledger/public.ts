import type { LedgerEvent, LedgerEventType, StoredEvent } from "./events";
import type { BatchStatus, EntryState, EntryStatus, SealReason, VerdictRecord } from "./types";

export type { BatchStatus, EntryStatus, SealReason, VerdictRecord };

// The public projection of the Ledger (M7), for the live visualiser and the read-only
// views under `/__lazaret/`. Anyone on the internet can read it, and other visitors'
// writes are in it, so it is built field by field from an allow-list, never by
// deleting fields from the original (a field added to an event later stays private
// until someone decides to show it):
//
//   - no request headers, queries, tokens, IPs or operator names;
//   - session ids cut to 8 hex chars (they are already SHA-256 hashes, see
//     gateway/session.ts), enough to tell sessions apart and to draw taint;
//   - bodies cut to `previewChars`, and binary bodies replaced by their size;
//   - free text from the system (errors, reasons) capped in length.
//
// Also exported on its own as `@gleator/lazaret/public`, with no runtime imports, so a
// browser client (the gleator.com visualiser) can share these types without pulling
// in Workers code.
//
// Every string in a frame can contain attacker text (bodies, paths, model rationales
// quoting a payload). Clients must render frames as text, never as HTML.

const SESSION_CHARS = 8;
const TEXT_CAP = 400;

export interface PublicSignal {
  id: string;
  category: string;
  weight: number;
}

export interface PublicEntry {
  entryId: string;
  batchId: string;
  route: string;
  method: string;
  path: string;
  session: string;
  risk: number;
  signals: PublicSignal[];
  resources: string[];
  body: string | null;
  bodyTruncated: boolean;
  status?: EntryStatus;
  verdict?: VerdictRecord;
}

/** One Ledger event, projected. `seq` is the log position, so clients resume by it. */
export type PublicEvent = { seq: number; at: number } & (
  | { type: "BATCH_OPENED"; batchId: string }
  | { type: "ENTRY_APPENDED"; entry: PublicEntry }
  | { type: "BATCH_SEALED"; batchId: string; reason: SealReason }
  | { type: "REVIEW_STARTED"; batchId: string; attempt: number }
  | { type: "REVIEW_FAILED"; batchId: string; attempt: number; error: string }
  | { type: "ENTRY_VERDICT"; entryId: string; verdict: VerdictRecord }
  | { type: "COMMIT_STARTED"; batchId: string }
  | { type: "ENTRY_COMMITTED"; entryId: string; originStatus: number | null }
  | { type: "BATCH_SETTLED"; batchId: string }
  | { type: "BATCH_QUARANTINED"; batchId: string; reason: string }
  | { type: "SESSION_FLAGGED"; session: string; reason: string }
  | { type: "ENTRY_RESOLVED"; entryId: string; decision: "release" | "drop" }
  | { type: "ENTRY_REPORTED"; entryId: string }
);

/**
 * Something the gateway decided without the Ledger (inline review, a gate block). Not
 * part of the event log, which stays the source of truth for escrow; shown so the
 * visualiser covers every route policy. Never carries a body: inline routes are
 * logins, keys and payments.
 */
export interface ObservedInput {
  kind: "inline" | "gate_block";
  route: string;
  method: string;
  /** Full session hash; cut on the way out. */
  sessionId: string;
  risk: number;
  signals: string[];
  /** `allow`, `deny`, `degraded` (allowed on gate rules), `unavailable`. */
  outcome: "allow" | "deny" | "degraded" | "unavailable";
  category?: string;
  /** Why the reviewer gave no verdict (`timeout`, `error`, `budget`, ...). */
  cause?: string;
  latencyMs?: number;
}

export interface PublicObservation {
  type: "OBSERVED";
  at: number;
  kind: ObservedInput["kind"];
  route: string;
  method: string;
  session: string;
  risk: number;
  signals: string[];
  outcome: ObservedInput["outcome"];
  category: string | null;
  cause: string | null;
  latencyMs: number | null;
}

/** What a live socket receives. */
export type LiveFrame =
  | { type: "HELLO"; shard: string; head: number; previewChars: number }
  | PublicEvent
  | PublicObservation
  /** The demo rolled over to a fresh Ledger: reconnect from seq 0. */
  | { type: "RESET" };

const cap = (s: string, n = TEXT_CAP) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const shortSession = (id: string) => id.slice(0, SESSION_CHARS);
const round = (n: number) => Math.round(n * 1000) / 1000;

function publicVerdict(v: VerdictRecord): VerdictRecord {
  return {
    verdict: v.verdict,
    category: cap(v.category, 64),
    confidence: round(v.confidence),
    rationale: cap(v.rationale),
  };
}

export function publicEntry(
  e: Pick<
    EntryState,
    "sessionId" | "route" | "riskScore" | "signals" | "resources" | "request" | "batchId"
  > & { id: string; status?: EntryStatus; verdict?: VerdictRecord },
  previewChars: number,
): PublicEntry {
  const { body, bodyEncoding } = e.request;
  let preview: string | null = null;
  let truncated = false;
  if (body !== null && previewChars > 0) {
    if (bodyEncoding === "base64") {
      preview = `[binary, ${Math.floor((body.length * 3) / 4)} bytes]`;
    } else {
      truncated = body.length > previewChars;
      preview = truncated ? body.slice(0, previewChars) : body;
    }
  }
  return {
    entryId: e.id,
    batchId: e.batchId,
    route: cap(e.route, 120),
    method: e.request.method,
    path: cap(e.request.path, 200),
    session: shortSession(e.sessionId),
    risk: round(e.riskScore),
    signals: e.signals.map((s) => ({ id: s.id, category: s.category, weight: round(s.weight) })),
    resources: e.resources.map((r) => cap(r, 120)),
    body: preview,
    bodyTruncated: truncated || (body !== null && previewChars === 0),
    ...(e.status ? { status: e.status } : {}),
    ...(e.verdict ? { verdict: publicVerdict(e.verdict) } : {}),
  };
}

export function publicEvent(stored: StoredEvent, previewChars: number): PublicEvent {
  const { seq } = stored;
  const ev: LedgerEvent = stored.event;
  const base = { seq, at: ev.at };
  switch (ev.type) {
    case "BATCH_OPENED":
    case "COMMIT_STARTED":
    case "BATCH_SETTLED":
      return { ...base, type: ev.type, batchId: ev.batchId };
    case "ENTRY_APPENDED":
      return {
        ...base,
        type: ev.type,
        entry: publicEntry({ ...ev.entry, id: ev.entryId, batchId: ev.batchId }, previewChars),
      };
    case "BATCH_SEALED":
      return { ...base, type: ev.type, batchId: ev.batchId, reason: ev.reason };
    case "REVIEW_STARTED":
      return { ...base, type: ev.type, batchId: ev.batchId, attempt: ev.attempt };
    case "REVIEW_FAILED":
      return {
        ...base,
        type: ev.type,
        batchId: ev.batchId,
        attempt: ev.attempt,
        error: cap(ev.error, 200),
      };
    case "ENTRY_VERDICT":
      return { ...base, type: ev.type, entryId: ev.entryId, verdict: publicVerdict(ev.verdict) };
    case "ENTRY_COMMITTED":
      return {
        ...base,
        type: ev.type,
        entryId: ev.entryId,
        originStatus: ev.originStatus ?? null,
      };
    case "BATCH_QUARANTINED":
      return { ...base, type: ev.type, batchId: ev.batchId, reason: cap(ev.reason, 200) };
    case "SESSION_FLAGGED":
      return {
        ...base,
        type: ev.type,
        session: shortSession(ev.sessionId),
        reason: cap(ev.reason, 200),
      };
    case "ENTRY_RESOLVED":
      return { ...base, type: ev.type, entryId: ev.entryId, decision: ev.decision };
    case "ENTRY_REPORTED":
      return { ...base, type: ev.type, entryId: ev.entryId };
    default: {
      // A new event type is private until it gets a projection here.
      const unknown: never = ev;
      throw new Error(`no public projection for ${(unknown as { type: string }).type}`);
    }
  }
}

export function publicObservation(o: ObservedInput, at: number): PublicObservation {
  return {
    type: "OBSERVED",
    at,
    kind: o.kind,
    route: cap(o.route, 120),
    method: o.method,
    session: shortSession(o.sessionId),
    risk: round(o.risk),
    signals: o.signals.slice(0, 12).map((s) => cap(s, 64)),
    outcome: o.outcome,
    category: o.category ? cap(o.category, 64) : null,
    cause: o.cause ? cap(o.cause, 32) : null,
    latencyMs: o.latencyMs ?? null,
  };
}

/** Event types the projection covers (used by tests to prove it is exhaustive). */
export const PUBLIC_EVENT_TYPES: readonly LedgerEventType[] = [
  "BATCH_OPENED",
  "ENTRY_APPENDED",
  "BATCH_SEALED",
  "REVIEW_STARTED",
  "REVIEW_FAILED",
  "ENTRY_VERDICT",
  "COMMIT_STARTED",
  "ENTRY_COMMITTED",
  "BATCH_SETTLED",
  "BATCH_QUARANTINED",
  "SESSION_FLAGGED",
  "ENTRY_RESOLVED",
  "ENTRY_REPORTED",
];
