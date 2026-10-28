import { DurableObject } from "cloudflare:workers";
import { combineRisk } from "../gate/signals";
import type { LedgerEvent, StoredEvent } from "./events";
import { applyEvent, initialState, nextBatchId } from "./machine";
import { applyTaint } from "./taint";
import {
  type CycleConfig,
  DEFAULT_CYCLE,
  sealDeadline,
  sealReasonAfterAppend,
  validateCycleConfig,
} from "./triggers";
import type {
  BatchStatus,
  EntryInput,
  EntryState,
  LedgerState,
  SealReason,
  VerdictRecord,
} from "./types";

// The Ledger is the harness (principle 1): it owns the escrow loop and the state
// machine, and is the only thing allowed to change batch/entry state. The Review
// Workflow (brain) and Committer (hands) drive it through these RPC methods; they
// never touch storage.
//
// Durability model (principle 3):
//   - Every change is an event appended to `ledger_events` in this object's SQLite.
//   - In-memory state is a projection rebuilt by replaying the log on startup, so an
//     eviction or crash loses nothing that was acknowledged.
//   - Multi-event operations run in one transaction: all events land or none do.
//
// Retry model (principle 4): every method the Review Workflow calls is idempotent
// (begin*/record*/mark*/settle), because a Workflow step can re-run after a crash
// without knowing whether its last call landed.
//
// Alarm invariant: an alarm is scheduled iff a batch is OPEN, at that batch's timer
// deadline. Sealing deletes it; opening sets it; startup repairs it if missing.
//
// Subclass to configure, e.g.
//   export class Ledger extends LazaretLedger {
//     protected override cycleConfig() { return { ...DEFAULT_CYCLE, intervalSec: 30 }; }
//   }

/** How long a flagged session's writes carry a risk boost. */
const SESSION_FLAG_TTL_MS = 60 * 60 * 1000;
const SESSION_FLAG_WEIGHT = 0.6;

export interface ReviewSnapshot {
  batchId: string;
  status: BatchStatus;
  attempt: number;
  /** Entries still awaiting a verdict, in append order. */
  entries: EntryState[];
  /** Which of those entries' sessions are currently flagged. */
  flaggedSessions: string[];
}

export interface ReviewDispatch {
  /** Durable Object id of the Ledger, so the Workflow can find its way back. */
  ledgerId: string;
  batchId: string;
}

export class LazaretLedger<Env = unknown> extends DurableObject<Env> {
  #state: LedgerState = initialState();
  readonly #cycle: CycleConfig;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#cycle = validateCycleConfig(this.cycleConfig());
    ctx.blockConcurrencyWhile(async () => {
      this.#migrate();
      this.#state = this.#replayFromLog();
      await this.#repairAlarm();
    });
  }

  /** Override to change cycle triggers. Called once per instance. */
  protected cycleConfig(): CycleConfig {
    return DEFAULT_CYCLE;
  }

  /**
   * Workflow binding that reviews sealed batches. Return null to disable automatic
   * dispatch (e.g. when a test drives the review protocol by hand).
   */
  protected reviewWorkflowBinding(): string | null {
    return "LAZARET_REVIEW";
  }

  /** Overridable clock so tests can control event timestamps. */
  protected now(): number {
    return Date.now();
  }

  // ── Writes from the Gateway ───────────────────────────────────────────────────

  /** Escrow one write. Opens a batch if needed and seals it if a trigger fires. */
  async append(
    input: EntryInput,
  ): Promise<{ entryId: string; batchId: string; sealed: SealReason | null }> {
    validateEntryInput(input);
    const at = this.now();
    const entry = this.#boostFlaggedSession(input, at);
    const events: LedgerEvent[] = [];

    const opening = this.#state.openBatchId === null;
    const batchId = this.#state.openBatchId ?? nextBatchId(this.#state);
    if (opening) events.push({ type: "BATCH_OPENED", batchId, at });

    const entryId = crypto.randomUUID();
    events.push({ type: "ENTRY_APPENDED", entryId, batchId, entry, at });

    // Seal in the same transaction as the append, so a crash can never leave a
    // risk-spike entry sitting in an open batch waiting for the timer.
    const entryCount = (this.#state.batches[batchId]?.entryIds.length ?? 0) + 1;
    const sealed = sealReasonAfterAppend(entryCount, entry.riskScore, this.#cycle);
    if (sealed) events.push({ type: "BATCH_SEALED", batchId, reason: sealed, at });
    this.#commit(events);

    if (sealed) await this.#afterSeal(batchId);
    else if (opening) await this.ctx.storage.setAlarm(sealDeadline(at, this.#cycle));

    return { entryId, batchId, sealed };
  }

  /** Seal the open batch now (operator action / tests). Returns its id, or null. */
  async seal(): Promise<string | null> {
    const batchId = this.#state.openBatchId;
    if (batchId === null) return null;
    await this.#seal(batchId, "manual");
    return batchId;
  }

  override async alarm(): Promise<void> {
    // Per the alarm invariant, an open batch here has reached its deadline. A batch
    // can't be empty (it opens on first append), but guard anyway.
    const batchId = this.#state.openBatchId;
    if (batchId === null) return;
    if (this.#state.batches[batchId]?.entryIds.length) await this.#seal(batchId, "timer");
  }

  /**
   * Recovery sweep, called from the Gateway's cron trigger. Re-dispatches any
   * sealed batch whose Workflow never started (dispatch failed, or the object was
   * evicted in between). Workflow ids are deterministic, so this is idempotent.
   */
  async sweep(): Promise<{ redispatched: number }> {
    let redispatched = 0;
    for (const batch of Object.values(this.#state.batches)) {
      if (batch.status === "SEALED" && (await this.#dispatch(batch.id))) redispatched += 1;
    }
    return { redispatched };
  }

  // ── Review protocol (driven by the Review Workflow) ─────────────────────────

  /** What the reviewer needs: the pending entries and which sessions are flagged. */
  getReviewSnapshot(batchId: string): ReviewSnapshot {
    const batch = this.#state.batches[batchId];
    if (!batch) throw new Error(`unknown batch ${batchId}`);
    const entries = batch.entryIds
      .map((id) => this.#state.entries[id])
      .filter((e): e is EntryState => e?.status === "PENDING");
    const now = this.now();
    const flaggedSessions = [...new Set(entries.map((e) => e.sessionId))].filter((s) =>
      this.#isFlagged(s, now),
    );
    return {
      batchId,
      status: batch.status,
      attempt: batch.reviewAttempts,
      entries: structuredClone(entries),
      flaggedSessions,
    };
  }

  /** Begin (or retry) review of a sealed batch. Returns the attempt number. */
  startReview(batchId: string): number {
    const attempt = (this.#state.batches[batchId]?.reviewAttempts ?? 0) + 1;
    this.#commit([{ type: "REVIEW_STARTED", batchId, attempt, at: this.now() }]);
    return attempt;
  }

  /** Idempotent `startReview`: if the batch is already REVIEWING, return its attempt. */
  beginReview(batchId: string): number {
    const batch = this.#state.batches[batchId];
    if (batch?.status === "REVIEWING") return batch.reviewAttempts;
    return this.startReview(batchId);
  }

  /** Idempotent: a repeat for an attempt that already failed is a no-op. */
  failReview(batchId: string, attempt: number, error: string): void {
    const batch = this.#state.batches[batchId];
    if (batch?.status === "REVIEW_FAILED" && batch.reviewAttempts === attempt) return;
    this.#commit([{ type: "REVIEW_FAILED", batchId, attempt, error, at: this.now() }]);
  }

  /**
   * Record verdicts for a whole batch in one transaction, after taint propagation.
   * Requiring exactly one verdict per pending entry means a review is never
   * half-applied. A repeat after the verdicts landed is a no-op.
   */
  recordVerdicts(
    batchId: string,
    verdicts: Record<string, VerdictRecord>,
  ): { applied: boolean; tainted: number; flaggedSessions: number } {
    const batch = this.#state.batches[batchId];
    if (!batch) throw new Error(`unknown batch ${batchId}`);
    const entries = batch.entryIds
      .map((id) => this.#state.entries[id])
      .filter((e): e is EntryState => e !== undefined);
    const pending = entries.filter((e) => e.status === "PENDING");
    if (pending.length === 0 && batch.status !== "SEALED") {
      return { applied: false, tainted: 0, flaggedSessions: 0 };
    }

    const given = Object.keys(verdicts);
    const missing = pending.filter((e) => !(e.id in verdicts));
    const extra = given.filter((id) => !pending.some((e) => e.id === id));
    if (missing.length || extra.length) {
      throw new Error(
        `verdicts must cover exactly the pending entries of ${batchId} ` +
          `(missing: ${missing.length}, unexpected: ${extra.length})`,
      );
    }
    for (const id of given) validateVerdict(verdicts[id]);

    const taint = applyTaint(pending, verdicts);
    const at = this.now();
    this.#commit([
      ...pending.map(
        (e): LedgerEvent => ({
          type: "ENTRY_VERDICT",
          entryId: e.id,
          verdict: taint.verdicts[e.id] as VerdictRecord,
          at,
        }),
      ),
      ...taint.flaggedSessions.map((f): LedgerEvent => ({ type: "SESSION_FLAGGED", ...f, at })),
    ]);
    return { applied: true, tainted: taint.tainted, flaggedSessions: taint.flaggedSessions.length };
  }

  startCommit(batchId: string): void {
    this.#commit([{ type: "COMMIT_STARTED", batchId, at: this.now() }]);
  }

  /** Idempotent `startCommit`. */
  beginCommit(batchId: string): void {
    const status = this.#state.batches[batchId]?.status;
    if (status === "COMMITTING" || status === "SETTLED") return;
    this.startCommit(batchId);
  }

  /** Approved entries still to be replayed to origin, in append order (dependencies first). */
  getCommitPlan(batchId: string): EntryState[] {
    const batch = this.#state.batches[batchId];
    if (!batch) throw new Error(`unknown batch ${batchId}`);
    return structuredClone(
      batch.entryIds
        .map((id) => this.#state.entries[id])
        .filter((e): e is EntryState => e?.status === "APPROVED"),
    );
  }

  /**
   * Mark one entry as written to origin. Idempotent: the Committer may replay after a
   * crash without knowing which writes landed (principle 4), so a repeat is a no-op.
   */
  markCommitted(entryId: string, originStatus?: number): { duplicate: boolean } {
    if (this.#state.entries[entryId]?.status === "COMMITTED") return { duplicate: true };
    this.#commit([
      {
        type: "ENTRY_COMMITTED",
        entryId,
        ...(originStatus === undefined ? {} : { originStatus }),
        at: this.now(),
      },
    ]);
    return { duplicate: false };
  }

  /** Idempotent: settling a settled batch is a no-op. */
  settle(batchId: string): void {
    if (this.#state.batches[batchId]?.status === "SETTLED") return;
    this.#commit([{ type: "BATCH_SETTLED", batchId, at: this.now() }]);
  }

  /** Fail closed: hold the whole batch for second review instead of committing. Idempotent. */
  quarantine(batchId: string, reason: string): void {
    if (this.#state.batches[batchId]?.status === "QUARANTINED") return;
    this.#commit([{ type: "BATCH_QUARANTINED", batchId, reason, at: this.now() }]);
  }

  // ── Reads ────────────────────────────────────────────────────────────────────

  getState(): LedgerState {
    return structuredClone(this.#state);
  }

  /** Page through the event log (used by the live visualiser and by tests). */
  getEvents(afterSeq = 0, limit = 500): StoredEvent[] {
    return this.ctx.storage.sql
      .exec<{ seq: number; payload: string }>(
        "SELECT seq, payload FROM ledger_events WHERE seq > ? ORDER BY seq LIMIT ?",
        afterSeq,
        Math.min(Math.max(limit, 1), 1000),
      )
      .toArray()
      .map((row) => ({ seq: row.seq, event: JSON.parse(row.payload) as LedgerEvent }));
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  #isFlagged(sessionId: string, now: number): boolean {
    const flag = this.#state.flaggedSessions[sessionId];
    return flag !== undefined && now - flag.at < SESSION_FLAG_TTL_MS;
  }

  /**
   * A session caught attacking gets a cooling-off period. Its writes carry a risk
   * boost, so they tend to trip the risk-spike seal and reach review quickly with
   * the evidence attached.
   */
  #boostFlaggedSession(input: EntryInput, at: number): EntryInput {
    if (!this.#isFlagged(input.sessionId, at)) return input;
    const flag = this.#state.flaggedSessions[input.sessionId];
    return {
      ...input,
      riskScore: combineRisk([input.riskScore, SESSION_FLAG_WEIGHT]),
      signals: [
        ...input.signals,
        {
          source: "behaviour",
          id: "session.flagged",
          category: "repeat_offender",
          weight: SESSION_FLAG_WEIGHT,
          evidence: flag?.reason.slice(0, 80),
        },
      ],
    };
  }

  async #seal(batchId: string, reason: SealReason): Promise<void> {
    this.#commit([{ type: "BATCH_SEALED", batchId, reason, at: this.now() }]);
    await this.#afterSeal(batchId);
  }

  async #afterSeal(batchId: string): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.#dispatch(batchId);
  }

  /**
   * Start the Review Workflow for a batch. Never throws: a failed dispatch leaves the
   * batch SEALED, and `sweep()` picks it up later. The write itself is already safe
   * in escrow, so a dispatch failure must not fail the client's request.
   */
  async #dispatch(batchId: string): Promise<boolean> {
    const binding = this.reviewWorkflowBinding();
    if (!binding) return false;
    const workflow = (this.env as Record<string, unknown>)[binding] as
      | Workflow<ReviewDispatch>
      | undefined;
    if (!workflow) return false;
    const id = `${this.ctx.id.toString()}-${batchId}`;
    try {
      await workflow.create({ id, params: { ledgerId: this.ctx.id.toString(), batchId } });
      return true;
    } catch (err) {
      // Deterministic ids make a duplicate create harmless: the review is already running.
      try {
        await workflow.get(id);
        return false;
      } catch {
        console.error(JSON.stringify({ lazaret: "dispatch_failed", batchId, error: String(err) }));
        return false;
      }
    }
  }

  /**
   * Apply events to the projection and persist them atomically. Guards run inside
   * the transaction, so an illegal event rolls back every event in the call. The
   * projection may have been partly mutated by then, so it is rebuilt from the log —
   * the same recovery path used after a crash.
   */
  #commit(events: LedgerEvent[]): void {
    try {
      this.ctx.storage.transactionSync(() => {
        for (const event of events) {
          applyEvent(this.#state, event);
          this.ctx.storage.sql.exec(
            "INSERT INTO ledger_events (seq, type, payload, at) VALUES (?, ?, ?, ?)",
            this.#state.seq,
            event.type,
            JSON.stringify(event),
            event.at,
          );
        }
      });
    } catch (err) {
      this.#state = this.#replayFromLog();
      throw err;
    }
  }

  #migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        seq     INTEGER PRIMARY KEY,
        type    TEXT    NOT NULL,
        payload TEXT    NOT NULL,
        at      INTEGER NOT NULL
      )
    `);
  }

  // TODO(M5): replay is O(log length). Once settled batches are archived to R2 we can
  // snapshot the projection and replay only the tail.
  #replayFromLog(): LedgerState {
    const state = initialState();
    const rows = this.ctx.storage.sql.exec<{ seq: number; payload: string }>(
      "SELECT seq, payload FROM ledger_events ORDER BY seq",
    );
    for (const row of rows) {
      applyEvent(state, JSON.parse(row.payload) as LedgerEvent);
      // A gap or reorder means the log was tampered with or corrupted; refuse to run
      // on a state we can't vouch for.
      if (state.seq !== row.seq) throw new Error(`event log corrupt at seq ${row.seq}`);
    }
    return state;
  }

  async #repairAlarm(): Promise<void> {
    const open = this.#state.openBatchId ? this.#state.batches[this.#state.openBatchId] : null;
    const alarm = await this.ctx.storage.getAlarm();
    if (open && alarm === null) {
      await this.ctx.storage.setAlarm(sealDeadline(open.openedAt, this.#cycle));
    }
    if (!open && alarm !== null) await this.ctx.storage.deleteAlarm();
  }
}

// ── Boundary validation ─────────────────────────────────────────────────────────
// RPC callers are other Workers, but the payload originates from the internet, so
// shape is checked here rather than trusted.

function validateEntryInput(input: EntryInput): void {
  if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
    throw new TypeError("entry.sessionId is required");
  }
  if (!(input.riskScore >= 0 && input.riskScore <= 1)) {
    throw new RangeError("entry.riskScore must be in [0, 1]");
  }
  if (!Array.isArray(input.resources)) throw new TypeError("entry.resources must be an array");
  if (!Array.isArray(input.signals)) throw new TypeError("entry.signals must be an array");
  const { request } = input;
  if (!request || typeof request.method !== "string" || typeof request.path !== "string") {
    throw new TypeError("entry.request must include method and path");
  }
}

const VERDICTS = new Set(["allow", "drop", "quarantine"]);

function validateVerdict(record: VerdictRecord | undefined): VerdictRecord {
  if (!record || !VERDICTS.has(record.verdict)) throw new TypeError("invalid verdict");
  if (!(record.confidence >= 0 && record.confidence <= 1)) {
    throw new RangeError("verdict.confidence must be in [0, 1]");
  }
  return record;
}
