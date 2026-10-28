import { DurableObject } from "cloudflare:workers";
import type { LedgerEvent, StoredEvent } from "./events";
import { applyEvent, initialState, nextBatchId } from "./machine";
import {
  type CycleConfig,
  DEFAULT_CYCLE,
  sealDeadline,
  sealReasonAfterAppend,
  validateCycleConfig,
} from "./triggers";
import type { EntryInput, LedgerState, SealReason, VerdictRecord } from "./types";

// The Ledger is the harness (principle 1): it owns the escrow loop and the state
// machine, and is the only thing allowed to change batch/entry state. Reviewers and
// committers (M3) drive it through these RPC methods; they never touch storage.
//
// Durability model (principle 3):
//   - Every change is an event appended to `ledger_events` in this object's SQLite.
//   - In-memory state is a projection rebuilt by replaying the log on startup, so an
//     eviction or crash loses nothing that was acknowledged.
//   - Multi-event operations run in one transaction: all events land or none do.
//
// Alarm invariant: an alarm is scheduled iff a batch is OPEN, at that batch's timer
// deadline. Sealing deletes it; opening sets it; startup repairs it if missing. So
// when `alarm()` fires, the open batch (if any) is due.
//
// Subclass to configure, e.g.
//   export class Ledger extends LazaretLedger {
//     protected override cycleConfig() { return { ...DEFAULT_CYCLE, intervalSec: 30 }; }
//   }

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
    const events: LedgerEvent[] = [];

    const opening = this.#state.openBatchId === null;
    const batchId = this.#state.openBatchId ?? nextBatchId(this.#state);
    if (opening) events.push({ type: "BATCH_OPENED", batchId, at });

    const entryId = crypto.randomUUID();
    events.push({ type: "ENTRY_APPENDED", entryId, batchId, entry: input, at });

    // Seal in the same transaction as the append, so a crash can never leave a
    // risk-spike entry sitting in an open batch waiting for the timer.
    const entryCount = (this.#state.batches[batchId]?.entryIds.length ?? 0) + 1;
    const sealed = sealReasonAfterAppend(entryCount, input.riskScore, this.#cycle);
    if (sealed) events.push({ type: "BATCH_SEALED", batchId, reason: sealed, at });
    this.#commit(events);

    if (sealed) await this.#afterSeal();
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

  // ── Review / commit protocol (driven by the Review Workflow in M3) ───────────

  /** Begin (or retry) review of a sealed batch. Returns the attempt number. */
  startReview(batchId: string): number {
    const attempt = (this.#state.batches[batchId]?.reviewAttempts ?? 0) + 1;
    this.#commit([{ type: "REVIEW_STARTED", batchId, attempt, at: this.now() }]);
    return attempt;
  }

  failReview(batchId: string, attempt: number, error: string): void {
    this.#commit([{ type: "REVIEW_FAILED", batchId, attempt, error, at: this.now() }]);
  }

  /**
   * Record verdicts for a whole batch in one transaction. Requiring exactly one
   * verdict per pending entry means a review is never half-applied: a crash leaves
   * either no verdicts or all of them, so retries start from a clean checkpoint.
   */
  recordVerdicts(batchId: string, verdicts: Record<string, VerdictRecord>): void {
    const batch = this.#state.batches[batchId];
    if (!batch) throw new Error(`unknown batch ${batchId}`);
    const pending = batch.entryIds.filter((id) => this.#state.entries[id]?.status === "PENDING");
    const given = Object.keys(verdicts);
    const missing = pending.filter((id) => !(id in verdicts));
    const extra = given.filter((id) => !pending.includes(id));
    if (missing.length || extra.length) {
      throw new Error(
        `verdicts must cover exactly the pending entries of ${batchId} ` +
          `(missing: ${missing.length}, unexpected: ${extra.length})`,
      );
    }
    const at = this.now();
    this.#commit(
      pending.map((entryId) => ({
        type: "ENTRY_VERDICT",
        entryId,
        verdict: validateVerdict(verdicts[entryId]),
        at,
      })),
    );
  }

  startCommit(batchId: string): void {
    this.#commit([{ type: "COMMIT_STARTED", batchId, at: this.now() }]);
  }

  /**
   * Mark one entry as written to origin. Idempotent: the Committer may replay after a
   * crash without knowing which writes landed (principle 4), so a repeat is a no-op.
   */
  markCommitted(entryId: string): { duplicate: boolean } {
    if (this.#state.entries[entryId]?.status === "COMMITTED") return { duplicate: true };
    this.#commit([{ type: "ENTRY_COMMITTED", entryId, at: this.now() }]);
    return { duplicate: false };
  }

  settle(batchId: string): void {
    this.#commit([{ type: "BATCH_SETTLED", batchId, at: this.now() }]);
  }

  /** Fail closed: hold the whole batch for second review instead of committing. */
  quarantine(batchId: string, reason: string): void {
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

  async #seal(batchId: string, reason: SealReason): Promise<void> {
    this.#commit([{ type: "BATCH_SEALED", batchId, reason, at: this.now() }]);
    await this.#afterSeal();
  }

  async #afterSeal(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    // M3: hand the sealed batch to the Review Workflow here.
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
