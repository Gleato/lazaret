import { canonicalize } from "../gate/inspect";
import type { EntryState } from "../ledger/types";
import type { ArchiveInput } from "./store";
import { type JsonValue, MEMORY_SIGNAL_PREFIX, type RuleSample } from "./types";

// Build the sample a rule would have seen at the gate for this entry, using the
// same canonicalisation as the live gate, so backtests and production agree.

const SAMPLE_HEADERS = [
  "user-agent",
  "content-type",
  "referer",
  "origin",
  "accept-language",
  "x-requested-with",
];
const MAX_SAMPLE_BODY = 4096;

export function sampleFromEntry(entry: EntryState): RuleSample {
  const { request } = entry;
  const text = request.bodyEncoding === "utf8" ? (request.body ?? "") : "";
  let json: JsonValue | undefined;
  if (text && /\bjson\b/i.test(request.headers["content-type"] ?? "")) {
    try {
      json = JSON.parse(text) as JsonValue;
    } catch {
      json = undefined;
    }
  }
  const headers: Record<string, string> = {};
  for (const h of SAMPLE_HEADERS) {
    const v = request.headers[h];
    if (v) headers[h] = v.slice(0, 300);
  }
  return {
    method: request.method,
    path: canonicalize(request.path),
    query: canonicalize(request.query.replaceAll("+", " ")),
    body: canonicalize(text).slice(0, MAX_SAMPLE_BODY),
    headers,
    json,
    // Memory hits are excluded so a rule is never judged by its own earlier firing.
    signals: entry.signals.filter((s) => !s.id.startsWith(MEMORY_SIGNAL_PREFIX)),
  };
}

/** Archive record for an entry that has a verdict. */
export function archiveRecord(
  entry: EntryState,
  source: "batch" | "inline",
  at: number,
): ArchiveInput {
  const verdict = entry.verdict;
  if (!verdict) throw new Error(`entry ${entry.id} has no verdict`);
  return {
    entryId: entry.id,
    route: entry.route,
    sessionId: entry.sessionId,
    verdict: verdict.verdict,
    category: verdict.category,
    confidence: verdict.confidence,
    rationale: verdict.rationale,
    source,
    at,
    sample: sampleFromEntry(entry),
    memoryHits: entry.signals
      .filter((s) => s.id.startsWith(MEMORY_SIGNAL_PREFIX))
      .map((s) => s.id.slice(MEMORY_SIGNAL_PREFIX.length)),
  };
}
