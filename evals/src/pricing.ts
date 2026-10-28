import { costUsd } from "@gleator/lazaret";
import type { CallRecord } from "./types";

// Prices live in the library (review/pricing.ts) so the evals and the spend cap use
// one table. The scripted reviewer costs nothing and counts as priced.
export { PRICES } from "@gleator/lazaret";

/** Cost of one call. Unknown models (e.g. a server-side fallback) price as Opus, to err high. */
export function callCostUsd(call: CallRecord): { usd: number; priced: boolean } {
  const { usd, priced } = costUsd(call.model, call);
  return { usd, priced: priced || call.model === "scripted" };
}
