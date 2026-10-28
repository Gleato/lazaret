import { DurableObject } from "cloudflare:workers";
import { combineRisk } from "../gate/signals";
import { type BudgetStatus, GLOBAL_BUDGET_KEY, SpendTable } from "../review/budget";
import { RECEIPT_PLACEHOLDER } from "../routing/matcher";
import type { LedgerEvent, StoredEvent } from "./events";
import { applyEvent, initialState, nextBatchId } from "./machine";
import {
  type LiveFrame,
  type ObservedInput,
  type PublicEntry,
  publicEntry,
  publicEvent,
  publicObservation,
} from "./public";
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
  OperatorDecision,
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

/** Live sockets per Ledger shard (M7). Over this, new viewers get a 503. */
const MAX_LIVE_SOCKETS = 100;
/** Gateway observations kept for the live view and the status line. */
const KEEP_OBSERVATIONS = 200;
/** Observations a new viewer is sent on connect, so the side rail isn't empty. */
const OBSERVATIONS_ON_CONNECT = 30;

interface SocketAttachment {
  previewChars: number;
}

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

/** An operator action's result. `reason` is safe to show the operator. */
export type OperatorResult =
  | { ok: true; entry: EntryState; cascaded: string[] }
  | { ok: false; reason: string };

export interface ReviewDispatch {
  /** Durable Object id of the Ledger, so the Workflow can find its way back. */
  ledgerId: string;
  batchId: string;
}

export class LazaretLedger<Env = unknown> extends DurableObject<Env> {
  #state: LedgerState = initialState();
  readonly #cycle: CycleConfig;
  #spendTable: SpendTable | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#cycle = validateCycleConfig(this.cycleConfig());
    // Answered by the runtime without waking a hibernated object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
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
    const entryId = crypto.randomUUID();
    // `{receipt}` resources name this entry itself (see RECEIPT_PLACEHOLDER). Filled
    // here, before the event is written, so replay sees the concrete key.
    const entry = this.#boostFlaggedSession(
      {
        ...input,
        resources: input.resources.map((r) => r.replaceAll(RECEIPT_PLACEHOLDER, entryId)),
      },
      at,
    );
    const events: LedgerEvent[] = [];

    const opening = this.#state.openBatchId === null;
    const batchId = this.#state.openBatchId ?? nextBatchId(this.#state);
    if (opening) events.push({ type: "BATCH_OPENED", batchId, at });

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

    // Earlier batches' dropped/held writes from the same sessions, so taint can link
    // across a batch boundary (dependencies only ever point backwards).
    const batchNumber = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1));
    const sessions = new Set(pending.map((e) => e.sessionId));
    const prior = Object.values(this.#state.entries).filter(
      (e) =>
        sessions.has(e.sessionId) &&
        (e.status === "DROPPED" || e.status === "QUARANTINED") &&
        batchNumber(e.batchId) < batchNumber(batchId),
    );
    const taint = applyTaint(pending, verdicts, prior);
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

  /** Entries of a batch that have a final verdict (for the Memory archive). */
  getReviewedEntries(batchId: string): EntryState[] {
    const batch = this.#state.batches[batchId];
    if (!batch) throw new Error(`unknown batch ${batchId}`);
    return structuredClone(
      batch.entryIds
        .map((id) => this.#state.entries[id])
        .filter((e): e is EntryState => e?.verdict !== undefined),
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

  // ── Operator (M6.7) ──────────────────────────────────────────────────────────
  //
  // "Held for a human" needs a human. These are the only ways out of QUARANTINED,
  // and the gateway exposes them only to an authenticated operator. Each decision is
  // an event, so the audit trail is the same log that rebuilds state.

  /** Held entries, plus released ones still waiting for their commit, oldest first. */
  getQuarantine(limit = 100): EntryState[] {
    const out = this.#appendOrder().filter(
      (e) =>
        e.status === "QUARANTINED" ||
        (e.status === "APPROVED" && e.resolution?.decision === "release"),
    );
    return structuredClone(out.slice(0, Math.min(Math.max(limit, 1), 500)));
  }

  /**
   * Release or drop a held entry. Idempotent: repeating a decision returns the entry
   * again, so a release whose commit failed can be retried.
   *   - release is refused while a held write it depends on is still held: origin
   *     would get a reply to a ticket that doesn't exist yet. Release the parent first.
   *   - drop also drops the held writes that depend on it (the same rule as taint),
   *     and flags the session, as a reviewer's drop would.
   */
  resolveEntry(
    entryId: string,
    decision: OperatorDecision,
    operator: string,
    note: string,
  ): OperatorResult {
    const entry = this.#state.entries[entryId];
    if (!entry) return { ok: false, reason: "not_found" };
    const decided = decision === "release" ? "APPROVED" : "DROPPED";
    if (entry.resolution?.decision === decision && entry.status !== "QUARANTINED") {
      return { ok: true, entry: structuredClone(entry), cascaded: [] };
    }
    if (entry.status !== "QUARANTINED") return { ok: false, reason: `entry is ${entry.status}` };
    const batch = this.#state.batches[entry.batchId];
    if (batch?.status !== "SETTLED" && batch?.status !== "QUARANTINED") {
      return { ok: false, reason: "batch is still under review" };
    }

    const at = this.now();
    if (decision === "release") {
      const parent = this.#heldParent(entry);
      if (parent) return { ok: false, reason: `release held entry ${parent.id} first` };
      this.#commit([{ type: "ENTRY_RESOLVED", entryId, decision, operator, note, at }]);
    } else {
      const cascaded = this.#heldDependents(entry);
      this.#commit([
        { type: "ENTRY_RESOLVED", entryId, decision, operator, note, at },
        ...cascaded.map(
          (d): LedgerEvent => ({
            type: "ENTRY_RESOLVED",
            entryId: d.id,
            decision,
            operator,
            note: `Depends on entry ${entryId}, dropped by ${operator}.`,
            at,
          }),
        ),
        {
          type: "SESSION_FLAGGED",
          sessionId: entry.sessionId,
          reason: `operator drop of entry ${entryId}`,
          at,
        },
      ]);
      const updated = this.#state.entries[entryId] as EntryState;
      return {
        ok: true,
        entry: structuredClone(updated),
        cascaded: cascaded.map((d) => d.id),
      };
    }
    const updated = this.#state.entries[entryId] as EntryState;
    if (updated.status !== decided) return { ok: false, reason: "decision did not apply" };
    return { ok: true, entry: structuredClone(updated), cascaded: [] };
  }

  /**
   * Mark a committed write as an attack the reviewer missed. Origin already has it,
   * so nothing is undone here (that's origin's job); the point is the label. The
   * Memory learns from it, and the session is flagged. Idempotent.
   */
  reportEntry(entryId: string, operator: string, note: string): OperatorResult {
    const entry = this.#state.entries[entryId];
    if (!entry) return { ok: false, reason: "not_found" };
    if (entry.resolution?.decision === "report") {
      return { ok: true, entry: structuredClone(entry), cascaded: [] };
    }
    if (entry.status !== "COMMITTED") return { ok: false, reason: `entry is ${entry.status}` };
    const at = this.now();
    this.#commit([
      { type: "ENTRY_REPORTED", entryId, operator, note, at },
      {
        type: "SESSION_FLAGGED",
        sessionId: entry.sessionId,
        reason: `operator report on entry ${entryId}`,
        at,
      },
    ]);
    return {
      ok: true,
      entry: structuredClone(this.#state.entries[entryId] as EntryState),
      cascaded: [],
    };
  }

  // ── Reads ────────────────────────────────────────────────────────────────────

  /**
   * A session's writes that origin doesn't have yet (PENDING, or APPROVED but not
   * committed), from the given routes, oldest first. Feeds the author-only read
   * overlay. Dropped and quarantined writes are excluded: the author shouldn't see
   * them "succeed".
   */
  getPendingForSession(sessionId: string, routes: string[], limit = 50): EntryState[] {
    const wanted = new Set(routes);
    const out: EntryState[] = [];
    for (const batch of Object.values(this.#state.batches)) {
      if (batch.status === "SETTLED" || batch.status === "QUARANTINED") continue;
      for (const id of batch.entryIds) {
        const e = this.#state.entries[id];
        if (
          e &&
          e.sessionId === sessionId &&
          wanted.has(e.route) &&
          (e.status === "PENDING" || e.status === "APPROVED")
        ) {
          out.push(e);
        }
      }
    }
    out.sort((a, b) => a.receivedAt - b.receivedAt);
    return structuredClone(out.slice(-limit));
  }

  /**
   * Status of a receipt, for its author only. A receipt from another session
   * returns null, the same as a missing one, so receipts can't be probed.
   */
  getReceipt(
    entryId: string,
    sessionId: string,
  ): { status: EntryState["status"]; batchStatus: BatchStatus; receivedAt: number } | null {
    const e = this.#state.entries[entryId];
    if (!e || e.sessionId !== sessionId) return null;
    const batch = this.#state.batches[e.batchId];
    return { status: e.status, batchStatus: batch?.status ?? "OPEN", receivedAt: e.receivedAt };
  }

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

  // ── Spend cap (M7, review/budget.ts) ──────────────────────────────────────────
  // Used on the dedicated budget instance (`review.budgetShard`), never the serving
  // shard, so the day's spend survives a shard rollover.

  budgetStatus(capUsd: number, key: string = GLOBAL_BUDGET_KEY): BudgetStatus {
    return this.#spend().status(capUsd, key);
  }

  chargeSpend(usd: number, key: string = GLOBAL_BUDGET_KEY): number {
    return this.#spend().charge(usd, key);
  }

  // ── Public view (M7, ledger/public.ts) ────────────────────────────────────────

  /**
   * Record something the gateway decided on its own (inline review, a gate block)
   * and push it to live viewers. Kept in a small ring, outside the event log: the
   * log is the source of truth for escrow and this is telemetry.
   */
  observe(input: ObservedInput): void {
    if (!input || typeof input.route !== "string" || typeof input.sessionId !== "string") {
      throw new TypeError("observation needs a route and a session");
    }
    const at = this.now();
    const frame = publicObservation(input, at);
    this.ctx.storage.sql.exec(
      "INSERT INTO observations (at, payload) VALUES (?, ?)",
      at,
      JSON.stringify(frame),
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM observations WHERE id <= (SELECT MAX(id) FROM observations) - ?",
      KEEP_OBSERVATIONS,
    );
    this.#broadcast(() => [frame]);
  }

  /** Inline review health over the last `windowMs`, for the demo's status line. */
  liveStatus(windowMs = 5 * 60_000): {
    head: number;
    openBatch: string | null;
    inline: { total: number; degraded: number; unavailable: number; p50LatencyMs: number | null };
  } {
    const since = this.now() - windowMs;
    const inline = this.#observations(since).filter((o) => o.kind === "inline");
    const latencies = inline
      .map((o) => o.latencyMs)
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    return {
      head: this.#state.seq,
      openBatch: this.#state.openBatchId,
      inline: {
        total: inline.length,
        degraded: inline.filter((o) => o.outcome === "degraded").length,
        unavailable: inline.filter((o) => o.outcome === "unavailable").length,
        p50LatencyMs: latencies.length
          ? (latencies[Math.floor((latencies.length - 1) / 2)] as number)
          : null,
      },
    };
  }

  /** The human queue, redacted for the public page. Acting on it needs the operator API. */
  getPublicQueue(previewChars: number, limit = 50): PublicEntry[] {
    return this.getQuarantine(limit).map((e) => publicEntry(e, previewChars));
  }

  /**
   * Live stream. The gateway forwards `GET /__lazaret/live?after=<seq>` here as a
   * WebSocket upgrade. Hibernatable: an idle viewer costs nothing. On connect the
   * viewer gets HELLO, the log after `after` (paged), and recent observations, then
   * every new event as it commits. All of that happens synchronously after
   * `acceptWebSocket`, and the object is single-threaded, so no event can slip in
   * between the replay and the live tail: no gap, no duplicate.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_LIVE_SOCKETS) {
      return new Response("too many viewers", { status: 503, headers: { "retry-after": "30" } });
    }
    const url = new URL(request.url);
    const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
    const previewChars = Math.min(
      2000,
      Math.max(0, Number.parseInt(url.searchParams.get("preview") ?? "280", 10) || 0),
    );
    const shard = (url.searchParams.get("shard") ?? "").slice(0, 64);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ previewChars } satisfies SocketAttachment);

    // A viewer ahead of this log (it came from a shard that has since rolled over)
    // starts from the beginning.
    const from = after > this.#state.seq ? 0 : after;
    const send = (frames: LiveFrame[]) => {
      if (frames.length) server.send(JSON.stringify(frames));
    };
    send([{ type: "HELLO", shard, head: this.#state.seq, previewChars }]);
    for (let cursor = from; ; ) {
      const page = this.getEvents(cursor, 500);
      if (!page.length) break;
      send(page.map((e) => publicEvent(e, previewChars)));
      cursor = (page[page.length - 1] as StoredEvent).seq;
    }
    send(this.#observations(0).slice(-OBSERVATIONS_ON_CONNECT));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Tell every viewer this shard is finished (the demo rolled over), then close. */
  closeLive(): number {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(JSON.stringify([{ type: "RESET" }] satisfies LiveFrame[]));
        ws.close(1000, "reset");
      } catch {
        // already gone
      }
    }
    return sockets.length;
  }

  // Viewers only listen. Anything they send (other than the auto-answered ping) is ignored.
  override webSocketMessage(): void {}

  override webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code === 1005 ? 1000 : code, "bye");
    } catch {
      // already closed
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /** Every entry in append order (batch number, then position in the batch). */
  #appendOrder(): EntryState[] {
    const n = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1));
    return Object.values(this.#state.batches)
      .sort((a, b) => n(a.id) - n(b.id))
      .flatMap((b) => b.entryIds.map((id) => this.#state.entries[id]))
      .filter((e): e is EntryState => e !== undefined);
  }

  /** Taint's link (same session, shared non-creation resource), as in taint.ts. */
  #linked(a: EntryState, b: EntryState): boolean {
    return (
      a.sessionId === b.sessionId &&
      a.resources.some((r) => !r.endsWith(":new") && b.resources.includes(r))
    );
  }

  /** The nearest earlier held write this entry depends on, if any. */
  #heldParent(entry: EntryState): EntryState | undefined {
    const order = this.#appendOrder();
    const before = order.slice(
      0,
      order.findIndex((e) => e.id === entry.id),
    );
    return before.reverse().find((e) => e.status === "QUARANTINED" && this.#linked(e, entry));
  }

  /** Later held writes that depend on this one, transitively. */
  #heldDependents(entry: EntryState): EntryState[] {
    const order = this.#appendOrder();
    const out: EntryState[] = [];
    const sources = [entry];
    for (const e of order.slice(order.findIndex((x) => x.id === entry.id) + 1)) {
      if (e.status === "QUARANTINED" && sources.some((src) => this.#linked(src, e))) {
        out.push(e);
        sources.push(e);
      }
    }
    return out;
  }

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
    // Only after the transaction holds: viewers never see an event that rolled back.
    // One frame per call, so a multi-event operation (append + seal) arrives together.
    const first = this.#state.seq - events.length + 1;
    this.#broadcast((previewChars) =>
      events.map((event, i) => publicEvent({ seq: first + i, event }, previewChars)),
    );
  }

  /** Send frames to every live viewer, projected once per preview length. */
  #broadcast(frames: (previewChars: number) => LiveFrame[]): void {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const byPreview = new Map<number, string>();
    for (const ws of sockets) {
      const previewChars =
        (ws.deserializeAttachment() as SocketAttachment | null)?.previewChars ?? 0;
      let payload = byPreview.get(previewChars);
      if (payload === undefined) {
        payload = JSON.stringify(frames(previewChars));
        byPreview.set(previewChars, payload);
      }
      try {
        ws.send(payload);
      } catch {
        // A socket closing mid-broadcast is not the writer's problem.
      }
    }
  }

  #spend(): SpendTable {
    this.#spendTable ??= new SpendTable(this.ctx.storage.sql, () => this.now());
    return this.#spendTable;
  }

  #observations(since: number) {
    return this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM observations WHERE at >= ? ORDER BY id",
        since,
      )
      .toArray()
      .map((row) => JSON.parse(row.payload) as ReturnType<typeof publicObservation>);
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
    // Gateway telemetry for the public view (observe); not part of the event log.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        at      INTEGER NOT NULL,
        payload TEXT    NOT NULL
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
  if (input.params !== undefined && (input.params === null || typeof input.params !== "object")) {
    throw new TypeError("entry.params must be an object");
  }
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
