import type { ReviewUsage } from "./client";

// List prices in USD per million tokens (claude-api skill, cached 2026-10-06; Opus 4.8
// cache reads assumed at the usual 0.1x of input). Cache writes are 1.25x input
// (5-minute TTL). Re-check before publishing numbers.
//
// One table for the spend cap (review/budget.ts) and the evals (evals/src/pricing.ts),
// so the cost the site reports and the cost the cap enforces can't drift apart.
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  // Seen as the server-side refusal fallback for Opus 5.5 escalations.
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
};
const CACHE_WRITE_MULTIPLIER = 1.25;
const UNKNOWN = PRICES["claude-opus-5-5"] as (typeof PRICES)[string];

/**
 * Cost of one call. Unknown models (e.g. a server-side fallback) price as Opus 5.5, to
 * err high: the cap should trip early rather than late. Dated snapshot ids match their
 * alias by prefix.
 */
export function costUsd(model: string, usage: ReviewUsage): { usd: number; priced: boolean } {
  const known = Object.entries(PRICES).find(([id]) => model.startsWith(id));
  const p = known?.[1] ?? UNKNOWN;
  const usd =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000;
  return { usd, priced: Boolean(known) };
}
