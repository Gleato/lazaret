// A signal is one piece of explainable evidence from the gate. Signals are
// stored with each escrowed entry, so the reviewer starts from pre-digested
// features instead of raw bytes (principle 2: a smaller, sharper context). They
// also feed the disagreement guard in M3, and the visualiser shows them.

export type SignalSource = "signature" | "rule" | "behaviour" | "request";

export interface GateSignal {
  source: SignalSource;
  /** Stable id, e.g. `sqli.union_select` or `path.encoded_separator`. */
  id: string;
  category: string;
  /** Contribution to risk, in [0, 1]. */
  weight: number;
  /** Short excerpt of what matched (≤ 80 chars). Untrusted: escape before rendering. */
  evidence?: string;
}

/**
 * Combine independent signals using "noisy-OR": risk = 1 − Π(1 − wᵢ). Two medium
 * signals add up to more than either alone, but the result never exceeds 1, and
 * many weak signals can't drown out one certain signal.
 */
export function combineRisk(weights: number[]): number {
  let clean = 1;
  for (const w of weights) clean *= 1 - Math.min(Math.max(w, 0), 1);
  return 1 - clean;
}
