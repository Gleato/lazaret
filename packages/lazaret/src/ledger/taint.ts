import type { EntryState, VerdictRecord } from "./types";

// Taint propagation (tasks/todo.md §2.3). Dropping a write is not enough if later
// writes build on it. Example: a session's PATCH to ticket:42 is dropped as
// malicious, so that session's follow-up reply to ticket:42 must not land either.
//
// Rules, applied in batch order so dependencies always point backwards:
//   - Entry B depends on an earlier entry A when both come from the same session
//     and share a resource key. `:new` keys (creations) never link entries.
//     Cross-session links are deliberately excluded: an honest user's reply to
//     ticket 42 shouldn't be punished because an attacker's edit to it was dropped.
//   - An allowed B that depends on a dropped A is dropped (category "tainted"). One
//     that depends on a quarantined A is quarantined. Taint is transitive.
//   - Any session with a reviewer drop (not a taint drop) is flagged. Its future
//     writes arrive with a risk boost and get strict review.
//   - Links also reach back into earlier batches (`prior`). Found by the evals: a
//     high-risk ticket trips the risk-spike seal, so its batch closes before the
//     follow-up reply arrives, and in-batch taint alone would let the reply through.

export interface TaintResult {
  verdicts: Record<string, VerdictRecord>;
  flaggedSessions: { sessionId: string; reason: string }[];
  tainted: number;
}

export function applyTaint(
  entries: EntryState[],
  reviewed: Record<string, VerdictRecord>,
  /** Entries from earlier batches that were already dropped or quarantined. */
  prior: EntryState[] = [],
): TaintResult {
  const verdicts: Record<string, VerdictRecord> = {};
  const dropped = new Map<string, Map<string, string>>(); // session → resource → entry id
  const held = new Map<string, Map<string, string>>();
  const flagged = new Map<string, string>();
  let tainted = 0;

  const linkedEntry = (index: Map<string, Map<string, string>>, entry: EntryState) => {
    const keys = index.get(entry.sessionId);
    if (!keys) return null;
    for (const r of entry.resources) {
      const source = keys.get(r);
      if (source && !r.endsWith(":new")) return { source, resource: r };
    }
    return null;
  };
  const remember = (index: Map<string, Map<string, string>>, entry: EntryState) => {
    const keys = index.get(entry.sessionId) ?? new Map<string, string>();
    for (const r of entry.resources) keys.set(r, entry.id);
    index.set(entry.sessionId, keys);
  };

  for (const entry of prior) {
    if (entry.verdict?.verdict === "drop") remember(dropped, entry);
    else if (entry.verdict?.verdict === "quarantine") remember(held, entry);
  }

  for (const entry of entries) {
    let verdict = reviewed[entry.id];
    if (!verdict) continue;
    if (
      verdict.verdict === "drop" &&
      verdict.category !== "tainted" &&
      !flagged.has(entry.sessionId)
    ) {
      flagged.set(entry.sessionId, `${verdict.category} in entry ${entry.id}`);
    }
    if (verdict.verdict !== "drop") {
      const viaDrop = linkedEntry(dropped, entry);
      const viaHold = viaDrop ? null : linkedEntry(held, entry);
      const link = viaDrop ?? viaHold;
      if (link) {
        tainted += 1;
        verdict = {
          verdict: viaDrop ? "drop" : "quarantine",
          category: "tainted",
          confidence: 1,
          rationale: `Depends on ${viaDrop ? "dropped" : "quarantined"} entry ${link.source} via ${link.resource}.`,
        };
      }
    }
    if (verdict.verdict === "drop") remember(dropped, entry);
    if (verdict.verdict === "quarantine") remember(held, entry);
    verdicts[entry.id] = verdict;
  }

  return {
    verdicts,
    flaggedSessions: [...flagged].map(([sessionId, reason]) => ({ sessionId, reason })),
    tainted,
  };
}
