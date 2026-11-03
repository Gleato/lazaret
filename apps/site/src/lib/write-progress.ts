import type { BatchView, EntryView } from "./ledger-view";

// One write's journey for the compact demo on the Projects sheet: four steps a
// visitor can follow without knowing the Ledger's state machine. Derived from the
// same ledger view the long page draws, so the two can't disagree.

export const STEPS = ["Held", "Sealed", "Reviewed", "Settled"] as const;

export type Outcome = "delivered" | "dropped" | "held" | null;

export interface Progress {
  /** Index into STEPS of the last step reached; -1 before the gateway answered. */
  step: number;
  outcome: Outcome;
  /** The last step's label, worded for the outcome ("Delivered" rather than "Settled"). */
  finalLabel: string;
}

export function progressOf(entry: EntryView | undefined, batch: BatchView | undefined): Progress {
  if (!entry) return { step: 0, outcome: null, finalLabel: STEPS[3] };
  const outcome: Outcome =
    entry.status === "COMMITTED"
      ? "delivered"
      : entry.status === "DROPPED"
        ? "dropped"
        : entry.status === "QUARANTINED"
          ? "held"
          : null;
  const finalLabel =
    outcome === "delivered"
      ? "Delivered"
      : outcome === "dropped"
        ? "Dropped"
        : outcome === "held"
          ? "Held for a human"
          : STEPS[3];
  if (outcome) return { step: 3, outcome, finalLabel };
  if (entry.verdict || entry.status === "APPROVED") return { step: 2, outcome, finalLabel };
  const sealed = batch && batch.status !== "OPEN";
  return { step: sealed ? 1 : 0, outcome, finalLabel };
}
