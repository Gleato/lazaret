import type { RuleProposer } from "../memory/distill";
import type { Reviewer, ReviewOutcome, ReviewTier, ReviewUsage } from "./client";
import { costUsd } from "./pricing";

// The daily spend cap (M7; `review.dailyBudgetUsd` existed before but nothing enforced
// it). Every model call is metered from its real token usage, and every place that
// starts model work checks the budget first:
//
//   inline review   checked per request in the gateway. Spent → the reviewer counts as
//                   unavailable (cause `budget`), so the route's onReviewUnavailable
//                   rule decides: `gate` lets a spotless request through, `deny` waits.
//   batch review    checked once when a batch's review starts. Spent → the Workflow
//                   sleeps until the next UTC day, so the batch waits SEALED. Nothing
//                   commits unreviewed and nothing floods the human queue.
//   distillation    skipped while spent (learning can wait).
//
// Overshoot is bounded, not zero: calls already in flight when the cap is reached
// still land, and a batch that started under the cap finishes (at most one batch of
// chunk calls plus its escalations). Checking per call would cost a round trip per
// chunk and could strand a batch half-reviewed, which is worse than a few cents over.
//
// The counter lives in a dedicated Ledger instance (`review.budgetShard`), not the
// serving shard, because shards can roll over (the demo starts a fresh Ledger every
// hour) and the budget must not reset with them. A Durable Object is a single writer,
// so concurrent charges never lose an update.

type Awaitable<T> = T | Promise<T>;

export const GLOBAL_BUDGET_KEY = "global";

export interface BudgetStatus {
  /** UTC day the figures are for, `YYYY-MM-DD`. */
  day: string;
  spentUsd: number;
  capUsd: number;
  exhausted: boolean;
  /** Epoch ms of the next UTC midnight, when the day's spend resets. */
  resetsAt: number;
}

/** The Ledger RPC surface for the budget (a Durable Object stub satisfies it). */
export interface BudgetPort {
  budgetStatus(capUsd: number, key?: string): Awaitable<BudgetStatus>;
  chargeSpend(usd: number, key?: string): Awaitable<number>;
}

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function nextUtcMidnight(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Days of spend history kept; older rows are pruned on write. */
const KEEP_DAYS = 7;

/** The spend table, inside whichever Durable Object hosts the budget. */
export class SpendTable {
  readonly #sql: SqlStorage;
  readonly #now: () => number;

  constructor(sql: SqlStorage, now: () => number) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS spend (
        day TEXT NOT NULL,
        key TEXT NOT NULL,
        usd REAL NOT NULL,
        PRIMARY KEY (day, key)
      )
    `);
  }

  status(capUsd: number, key = GLOBAL_BUDGET_KEY): BudgetStatus {
    const at = this.#now();
    const day = utcDay(at);
    const row = this.#sql
      .exec<{ usd: number }>("SELECT usd FROM spend WHERE day = ? AND key = ?", day, key)
      .toArray()[0];
    const spentUsd = row?.usd ?? 0;
    return { day, spentUsd, capUsd, exhausted: spentUsd >= capUsd, resetsAt: nextUtcMidnight(at) };
  }

  /** Add to today's spend for `key`; returns the new total. Negative or NaN is ignored. */
  charge(usd: number, key = GLOBAL_BUDGET_KEY): number {
    const at = this.#now();
    const day = utcDay(at);
    if (Number.isFinite(usd) && usd > 0) {
      this.#sql.exec(
        `INSERT INTO spend (day, key, usd) VALUES (?, ?, ?)
         ON CONFLICT (day, key) DO UPDATE SET usd = usd + excluded.usd`,
        day,
        key,
        usd,
      );
      this.#sql.exec("DELETE FROM spend WHERE day < ?", utcDay(at - KEEP_DAYS * 86_400_000));
    }
    return this.status(Number.POSITIVE_INFINITY, key).spentUsd;
  }
}

/** Charge a call's usage to the budget. Never throws: metering must not fail a review. */
async function meter(
  charge: (usd: number) => Awaitable<unknown>,
  model: string,
  usage: ReviewUsage | undefined,
): Promise<void> {
  if (!usage) return;
  try {
    await charge(costUsd(model, usage).usd);
  } catch (err) {
    console.error(JSON.stringify({ lazaret: "budget_charge_failed", error: String(err) }));
  }
}

function outcomeModel(outcome: ReviewOutcome, fallback: string): string {
  return outcome.kind === "incomplete" ? fallback : outcome.model;
}

/**
 * Wrap a Reviewer so every call is charged to the budget from its real token usage.
 * It only meters; whether to call at all is decided by the caller (see the top of
 * this file for where each tier checks).
 */
export function meteredReviewer(
  reviewer: Reviewer,
  charge: (usd: number) => Awaitable<unknown>,
  modelFor: (tier: ReviewTier) => string,
): Reviewer {
  return {
    async review(call) {
      const outcome = await reviewer.review(call);
      await meter(charge, outcomeModel(outcome, modelFor(call.tier)), outcome.usage);
      return outcome;
    },
  };
}

export function meteredProposer(
  proposer: RuleProposer,
  charge: (usd: number) => Awaitable<unknown>,
  model: string,
): RuleProposer {
  return {
    async propose(input) {
      const outcome = await proposer.propose(input);
      await meter(charge, outcomeModel(outcome, model), outcome.usage);
      return outcome;
    },
  };
}

/** The model that answers a tier, for pricing calls that report no model. */
export function tierModel(
  review: { batchModel: string; escalationModel: string; inlineModel: string },
  tier: ReviewTier,
): string {
  return tier === "inline"
    ? review.inlineModel
    : tier === "escalation"
      ? review.escalationModel
      : review.batchModel;
}
