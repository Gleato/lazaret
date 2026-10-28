import type { CallRecord } from "./types";

// List prices in USD per million tokens (claude-api skill, cached 2026-10-06; Opus 4.8
// cache reads assumed at the usual 0.1x of input).
// Cache writes are 1.25x input (5-minute TTL). Re-check before publishing numbers.
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  // Seen as the server-side refusal fallback for Opus 5.5 escalations.
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
};
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Cost of one call. Unknown models (e.g. a server-side fallback) price as Opus, to err high. */
export function callCostUsd(call: CallRecord): { usd: number; priced: boolean } {
  const known = Object.entries(PRICES).find(([id]) => call.model.startsWith(id));
  const p = known?.[1] ?? (PRICES["claude-opus-5-5"] as (typeof PRICES)[string]);
  const usd =
    (call.inputTokens * p.input +
      call.outputTokens * p.output +
      call.cacheReadTokens * p.cacheRead +
      call.cacheWriteTokens * p.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000;
  return { usd, priced: Boolean(known) || call.model === "scripted" };
}
