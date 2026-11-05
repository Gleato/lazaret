// The labelled corpus format (evals/corpus/*.jsonl), one case per line.
//
// A case is a short sequence of requests from one client. Every request but the
// last is setup (a login burst, or the ticket a reply depends on); the last one is
// the *target*, and only its outcome is scored. That lets a case test things a
// single request can't: rate-based detection, and taint from an earlier write.

export interface CaseRequest {
  method: string;
  /** May reference an earlier step's receipt: `/api/tickets/{receipt:0}/replies`. */
  path: string;
  /** JSON body as written in the corpus. */
  body?: unknown;
  /**
   * The body serialised on the Node side by the loader, and what's actually sent.
   * Passing objects into workerd would lose keys like `__proto__` in transit (the
   * first live run never tested its prototype-pollution case because of that).
   */
  bodyText?: string;
  headers?: Record<string, string>;
  /** Send this request N times; `{n}` in string fields becomes 1..N. */
  repeat?: number;
  /**
   * Wait out the review cycle first: everything sent so far is sealed and reviewed
   * before this request, so it lands in a later batch, as when a client waits 30 s
   * between writes. Lets a case spread a split attack across batches, which is how
   * the live "quiet heist" (2026-11-04, M10 in tasks/todo.md) beat batch review.
   */
  newBatch?: boolean;
  /**
   * Send as a different login of the same account: a new session token, same actor.
   * Tests linking that survives a fresh sign-in.
   */
  session?: string;
}

export interface EvalCase {
  id: string;
  label: "attack" | "benign";
  /** Attack class (e.g. "xss", "downstream_injection") or benign kind ("hard_negative"). */
  class: string;
  note: string;
  /** Client IP. Defaults to one derived from the case id, so cases don't share rate state. */
  ip?: string;
  /**
   * Who the client is logged in as, which the stub origin reports on `GET /api/me` for
   * the gateway's actor lookup. Default "customer". Credit cases, benign and fraud alike,
   * run as an agent: only staff can issue credits, so that's where fraud would come from.
   */
  actor?: "customer" | "agent";
  requests: CaseRequest[];
}

/** Where a target request ended up. */
export type Stage =
  | "gate" // blocked by the deterministic gate (or a BLOCK route) before any model call
  | "inline" // denied by inline review
  | "inline_unavailable" // inline review failed closed (timeout, refusal, error)
  | "review" // dropped or quarantined by batch review
  | "escalation" // decided by the second-opinion reviewer
  | "taint" // dropped because it depended on a dropped write
  | "parent_stopped" // never sent: the write it builds on was stopped at the edge (M7.1)
  | "delivered"; // reached origin

export interface CaseResult {
  id: string;
  label: EvalCase["label"];
  class: string;
  /** Escrowed: the Ledger entry id. Inline: the gateway request id. Null if neither. */
  entryId?: string | null;
  route: string | null;
  status: number;
  stopped: boolean;
  stage: Stage;
  gateRisk: number | null;
  signals: string[];
  verdict: { verdict: string; category: string; confidence: number; rationale: string } | null;
  /** Escrowed targets only: whether the escalation model saw it (the M6.6 invariant). */
  escalated?: boolean;
}

export interface CallRecord {
  tier: string;
  model: string;
  latencyMs: number;
  /** For single-entry calls (inline review), the route under review. */
  route?: string | undefined;
  outcome: string;
  /** For refusals: the API's decline category (`cyber`, `bio`, ...), or null if it gave none. */
  refusalCategory?: string | null;
  entries: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
