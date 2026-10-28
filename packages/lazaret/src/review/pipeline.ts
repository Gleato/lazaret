import type { Committer } from "../commit/committer";
import type { ResolvedConfig } from "../config/define";
import type { ReviewSnapshot } from "../ledger/durable-object";
import type { EntryState, VerdictRecord } from "../ledger/types";
import { FatalReviewError, type Reviewer, type ReviewTier } from "./client";
import { buildBatchPrompt, buildEscalationPrompt } from "./prompt";
import { MalformedReviewError, parseVerdicts } from "./schema";

// The review → commit pipeline for one sealed batch, written against a minimal
// `StepRunner` rather than Cloudflare Workflows directly. In production the
// runner is a Workflow step (durable, checkpointed, retried). In tests it is an
// in-memory runner that can simulate a crash between any two steps. The harness
// owns the loop (principle 1), and every step is a checkpoint (principles 3 and 4).
//
//   snapshot → [begin-review-n → review chunks → escalate] → record-verdicts
//            → begin-commit → commit each approved entry → settle
//
// Failure handling:
//   - Transient errors (429, overload, network) throw inside a step, so the step
//     retries with backoff. If retries run out, the attempt is recorded as failed,
//     the Workflow sleeps durably, and the next attempt starts.
//   - Fatal results (refusal, malformed output, bad request) are *returned* from the
//     step, not thrown, so they survive serialisation across the Workflow boundary.
//     They quarantine the batch immediately. Retrying a reviewer that produced a
//     malformed answer just gives an attacker another roll of the dice.

export interface StepOptions {
  retries?: number;
  retryDelayMs?: number;
}

export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>, options?: StepOptions): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

type Awaitable<T> = T | Promise<T>;

/** The Ledger RPC surface the pipeline uses (a Durable Object stub satisfies it). */
export interface LedgerPort {
  getReviewSnapshot(batchId: string): Awaitable<ReviewSnapshot>;
  beginReview(batchId: string): Awaitable<number>;
  failReview(batchId: string, attempt: number, error: string): Awaitable<void>;
  recordVerdicts(batchId: string, verdicts: Record<string, VerdictRecord>): Awaitable<unknown>;
  beginCommit(batchId: string): Awaitable<void>;
  getCommitPlan(batchId: string): Awaitable<EntryState[]>;
  markCommitted(entryId: string, originStatus?: number): Awaitable<unknown>;
  settle(batchId: string): Awaitable<void>;
  quarantine(batchId: string, reason: string): Awaitable<void>;
}

export interface PipelineDeps {
  ledger: LedgerPort;
  reviewer: Reviewer;
  committer: Committer;
  config: ResolvedConfig;
  /** Base delay between whole review attempts. Default 30s, doubling. */
  attemptBackoffMs?: number;
}

export type PipelineResult =
  | { outcome: "settled"; committed: number }
  | { outcome: "quarantined"; reason: string }
  | { outcome: "already_quarantined" };

type StepVerdicts =
  | { ok: true; verdicts: Record<string, VerdictRecord> }
  | { ok: false; reason: string };

const CHUNK_MAX_ENTRIES = 25;
const CHUNK_MAX_CHARS = 100_000;
const LOW_CONFIDENCE_ALLOW = 0.5;
const ESCALATION_ALLOW_CONFIDENCE = 0.9;

export async function runReviewPipeline(
  step: StepRunner,
  deps: PipelineDeps,
  batchId: string,
): Promise<PipelineResult> {
  const { ledger } = deps;
  const snapshot = await step.do("snapshot", async () => ledger.getReviewSnapshot(batchId));
  if (snapshot.status === "QUARANTINED") return { outcome: "already_quarantined" };

  // If verdicts already landed (e.g. a replay after a crash mid-commit), go straight to commit.
  if (snapshot.entries.length > 0 && snapshot.status !== "SETTLED") {
    const result = await reviewWithAttempts(step, deps, snapshot);
    if (!result.ok) {
      await step.do("quarantine", async () => ledger.quarantine(batchId, result.reason));
      return { outcome: "quarantined", reason: result.reason };
    }
    await step.do("record-verdicts", async () => {
      await ledger.recordVerdicts(batchId, result.verdicts);
      return true;
    });
  }

  await step.do("begin-commit", async () => ledger.beginCommit(batchId));
  const plan = await step.do("commit-plan", async () => ledger.getCommitPlan(batchId));
  for (const entry of plan) {
    // Send + record in one step: if we crash after origin accepted but before the
    // step checkpointed, the replay re-sends with the same idempotency key and
    // `markCommitted` is a no-op the second time.
    await step.do(
      `commit-${entry.id}`,
      async () => {
        const status = await deps.committer.commit(entry);
        await ledger.markCommitted(entry.id, status);
        return status;
      },
      { retries: 5, retryDelayMs: 2_000 },
    );
  }
  await step.do("settle", async () => ledger.settle(batchId));
  return { outcome: "settled", committed: plan.length };
}

async function reviewWithAttempts(
  step: StepRunner,
  deps: PipelineDeps,
  snapshot: ReviewSnapshot,
): Promise<StepVerdicts> {
  const { ledger, config } = deps;
  const { batchId } = snapshot;
  const max = config.review.maxAttempts;
  for (let n = 1; n <= max; n++) {
    const attempt = await step.do(`begin-review-${n}`, async () => ledger.beginReview(batchId));
    try {
      const first = await reviewInChunks(
        step,
        deps,
        "batch",
        snapshot.entries,
        (chunk) => buildBatchPrompt(chunk, snapshot.flaggedSessions),
        `review-${n}`,
      );
      if (!first.ok) return first;
      return await escalate(step, deps, snapshot, first.verdicts, n);
    } catch (err) {
      // Only transient failures reach here (retries exhausted). Record and back off.
      const message = (err as Error).message ?? String(err);
      await step.do(`fail-review-${n}`, async () => ledger.failReview(batchId, attempt, message));
      if (n < max)
        await step.sleep(`backoff-${n}`, (deps.attemptBackoffMs ?? 30_000) * 2 ** (n - 1));
    }
  }
  return { ok: false, reason: `review unavailable after ${max} attempts` };
}

/**
 * Disagreement guard (§2.5): when the reviewer allows something the gate scored as
 * high risk, or something from a session already caught attacking, a stronger
 * model takes an independent look. Allow survives only with high confidence.
 */
async function escalate(
  step: StepRunner,
  deps: PipelineDeps,
  snapshot: ReviewSnapshot,
  first: Record<string, VerdictRecord>,
  attempt: number,
): Promise<StepVerdicts> {
  const strong = deps.config.cycle.riskSpikeThreshold;
  const flagged = new Set(snapshot.flaggedSessions);
  const contested = snapshot.entries.filter(
    (e) => first[e.id]?.verdict === "allow" && (e.riskScore >= strong || flagged.has(e.sessionId)),
  );
  let second: Record<string, VerdictRecord> = {};
  if (contested.length) {
    const result = await reviewInChunks(
      step,
      deps,
      "escalation",
      contested,
      (chunk) => buildEscalationPrompt(chunk, first, snapshot.flaggedSessions),
      `escalate-${attempt}`,
    );
    if (!result.ok) return result;
    second = result.verdicts;
  }
  const verdicts: Record<string, VerdictRecord> = {};
  for (const entry of snapshot.entries) {
    verdicts[entry.id] = finalVerdict(first[entry.id] as VerdictRecord, second[entry.id]);
  }
  return { ok: true, verdicts };
}

export function finalVerdict(first: VerdictRecord, escalated?: VerdictRecord): VerdictRecord {
  if (escalated) {
    if (escalated.verdict === "allow" && escalated.confidence < ESCALATION_ALLOW_CONFIDENCE) {
      return {
        verdict: "quarantine",
        category: escalated.category,
        confidence: escalated.confidence,
        rationale: `Escalation allowed with low confidence; held. ${escalated.rationale}`.slice(
          0,
          400,
        ),
      };
    }
    return escalated;
  }
  if (first.verdict === "allow" && first.confidence < LOW_CONFIDENCE_ALLOW) {
    return {
      ...first,
      verdict: "quarantine",
      rationale: `Low-confidence allow; held. ${first.rationale}`.slice(0, 400),
    };
  }
  return first;
}

async function reviewInChunks(
  step: StepRunner,
  deps: PipelineDeps,
  tier: ReviewTier,
  entries: EntryState[],
  prompt: (chunk: EntryState[]) => string,
  stepPrefix: string,
): Promise<StepVerdicts> {
  const verdicts: Record<string, VerdictRecord> = {};
  const chunks = chunkEntries(entries);
  for (const [i, chunk] of chunks.entries()) {
    // One checkpoint per chunk, so a retry never re-pays for chunks that succeeded.
    const result = await step.do(
      `${stepPrefix}-chunk-${i}`,
      async (): Promise<StepVerdicts> => {
        try {
          const outcome = await deps.reviewer.review({ tier, prompt: prompt(chunk) });
          if (outcome.kind === "refusal") {
            return { ok: false, reason: `reviewer refused (${outcome.category ?? "unspecified"})` };
          }
          if (outcome.kind === "incomplete")
            return { ok: false, reason: `review incomplete: ${outcome.reason}` };
          return {
            ok: true,
            verdicts: parseVerdicts(
              outcome.output,
              chunk.map((e) => e.id),
            ),
          };
        } catch (err) {
          if (err instanceof FatalReviewError || err instanceof MalformedReviewError) {
            return { ok: false, reason: err.message };
          }
          throw err;
        }
      },
      { retries: 2, retryDelayMs: 5_000 },
    );
    if (!result.ok) return result;
    Object.assign(verdicts, result.verdicts);
  }
  return { ok: true, verdicts };
}

/** Split entries so each review call stays a sensible size. */
export function chunkEntries(entries: EntryState[]): EntryState[][] {
  const chunks: EntryState[][] = [];
  let current: EntryState[] = [];
  let size = 0;
  for (const entry of entries) {
    const cost = 600 + Math.min(entry.request.body?.length ?? 0, 6000);
    if (current.length && (current.length >= CHUNK_MAX_ENTRIES || size + cost > CHUNK_MAX_CHARS)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
