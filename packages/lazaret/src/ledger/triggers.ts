import type { SealReason } from "./types";

// When does the open batch stop accepting writes and go to review? Three triggers
// (tasks/todo.md §2): a timer, a size cap, and a risk spike. The risk trigger means an
// attack *shortens* the time malicious data sits in escrow instead of filling it.

export interface CycleConfig {
  /** Seal the open batch this many seconds after it opened. */
  intervalSec: number;
  /** Seal as soon as the open batch holds this many entries. */
  maxEntries: number;
  /** Seal immediately when an entry's gate risk score reaches this value. */
  riskSpikeThreshold: number;
}

export const DEFAULT_CYCLE: CycleConfig = {
  intervalSec: 300,
  maxEntries: 500,
  riskSpikeThreshold: 0.8,
};

export function validateCycleConfig(config: CycleConfig): CycleConfig {
  const { intervalSec, maxEntries, riskSpikeThreshold } = config;
  if (!(intervalSec > 0)) throw new RangeError("cycle.intervalSec must be > 0");
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("cycle.maxEntries must be a positive integer");
  }
  if (!(riskSpikeThreshold > 0 && riskSpikeThreshold <= 1)) {
    throw new RangeError("cycle.riskSpikeThreshold must be in (0, 1]");
  }
  return config;
}

/**
 * Decided as part of an append, so the seal lands in the same transaction.
 * `entryCount` includes the entry being appended. Risk wins over size.
 */
export function sealReasonAfterAppend(
  entryCount: number,
  appendedRiskScore: number,
  config: CycleConfig,
): SealReason | null {
  if (appendedRiskScore >= config.riskSpikeThreshold) return "risk";
  if (entryCount >= config.maxEntries) return "size";
  return null;
}

/** When the timer trigger fires for a batch opened at `openedAt`, in epoch ms. */
export function sealDeadline(openedAt: number, config: CycleConfig): number {
  return openedAt + config.intervalSec * 1000;
}
