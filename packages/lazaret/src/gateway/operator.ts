import { type Committer, TransientCommitError } from "../commit/committer";
import type { ResolvedConfig } from "../config/define";
import type { LazaretLedger, OperatorResult } from "../ledger/durable-object";
import type { EntryState } from "../ledger/types";
import { archiveRecord } from "../memory/sample";
import type { LazaretMemory } from "../memory/store";
import { json } from "./http";
import { sha256Hex } from "./session";

// The human review queue (M6.7). Quarantine said "held for a human", but until now
// nothing let a human act on it, so a held write was a silent drop. Under
// `/__lazaret/operator/`, with a bearer token from the operator secret:
//
//   GET  /__lazaret/operator/queue              held entries, oldest first
//   POST /__lazaret/operator/entries/:id        { action: "release" | "drop" | "report",
//                                                 note?, category? }
//
//   release  commits the held write to origin (signed, with the entry's idempotency key)
//   drop     discards it and the held writes that depend on it
//   report   marks a committed write as an attack the reviewer missed
//
// Every decision is labelled into the Memory as ground truth, so the system also
// learns from the writes its reviewer got wrong (see LazaretMemory.label).
//
// Caveat for release: the Committer replays the author's original headers, so a
// release after their session token has expired reaches origin unauthenticated and
// is refused there (the response says so). Resolve the queue within a token lifetime.

const MAX_BODY_PREVIEW = 4000;
const SAFE_NAME = /^[\w.@-]{1,64}$/;
const SAFE_CATEGORY = /^[a-z][a-z0-9_]{0,31}$/;
/** Reviewer categories that say nothing about the attack itself. */
const UNINFORMATIVE = new Set(["review_declined", "tainted", "benign", "uncertain"]);

export interface OperatorDeps {
  config: ResolvedConfig;
  env: object;
  ledger: DurableObjectStub<LazaretLedger>;
  memory: DurableObjectStub<LazaretMemory> | null;
  committer: () => Committer;
  now: () => number;
  waitUntil: (p: Promise<unknown>) => void;
}

export async function handleOperator(
  request: Request,
  segments: string[],
  deps: OperatorDeps,
): Promise<Response> {
  const { config, env } = deps;
  const secret = (env as Record<string, unknown>)[config.operator.tokenBinding];
  // No secret configured: the operator API doesn't exist.
  if (typeof secret !== "string" || secret.length < 16) return json(404, { error: "not_found" });
  if (!(await authorised(request.headers.get("authorization"), secret))) {
    return json(401, { error: "unauthorised" }, { "www-authenticate": "Bearer" });
  }
  const method = request.method.toUpperCase();
  const headers = { "cache-control": "no-store" };

  if (method === "GET" && segments.length === 3 && segments[2] === "queue") {
    const entries = await deps.ledger.getQuarantine();
    return json(200, { entries: entries.map(queueView) }, headers);
  }

  const id = segments[3];
  if (method !== "POST" || segments.length !== 4 || segments[2] !== "entries" || !id) {
    return json(404, { error: "not_found" });
  }
  let input: { action?: unknown; note?: unknown; category?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return json(400, { error: "body must be JSON" });
  }
  const action = input.action;
  if (action !== "release" && action !== "drop" && action !== "report") {
    return json(400, { error: 'action must be "release", "drop" or "report"' });
  }
  const note = typeof input.note === "string" ? input.note.slice(0, 400) : "";
  const named = request.headers.get("x-lazaret-operator") ?? "";
  const operator = SAFE_NAME.test(named) ? named : "operator";

  const result: OperatorResult =
    action === "report"
      ? await deps.ledger.reportEntry(id, operator, note)
      : await deps.ledger.resolveEntry(id, action, operator, note);
  if (!result.ok) {
    return json(result.reason === "not_found" ? 404 : 409, { error: result.reason }, headers);
  }
  console.log(
    JSON.stringify({
      lazaret: "operator",
      action,
      entryId: id,
      operator,
      cascaded: result.cascaded,
    }),
  );

  // Label before committing: the human's judgment stands whether or not origin is up.
  const category =
    typeof input.category === "string" && SAFE_CATEGORY.test(input.category)
      ? input.category
      : undefined;
  labelInMemory(deps, result.entry, action, operator, note, category);

  if (action !== "release") {
    return json(200, { entry: queueView(result.entry), cascaded: result.cascaded }, headers);
  }
  try {
    const originStatus = await deps.committer().commit(result.entry);
    await deps.ledger.markCommitted(id, originStatus);
    return json(200, { status: "committed", entryId: id, originStatus }, headers);
  } catch (err) {
    if (!(err instanceof TransientCommitError)) throw err;
    // Released but not delivered. Repeating the release retries the commit.
    return json(502, { status: "released", entryId: id, error: err.message }, headers);
  }
}

async function authorised(header: string | null, secret: string): Promise<boolean> {
  const token = /^Bearer\s+(\S+)$/.exec(header ?? "")?.[1];
  if (!token) return false;
  // Compare digests, so the comparison's timing doesn't leak a prefix of the secret.
  const [a, b] = await Promise.all([sha256Hex(token), sha256Hex(secret)]);
  return a === b;
}

function labelInMemory(
  deps: OperatorDeps,
  entry: EntryState,
  action: "release" | "drop" | "report",
  operator: string,
  note: string,
  category: string | undefined,
): void {
  const { memory } = deps;
  if (!memory) return;
  const reviewed = entry.verdict?.category;
  const verdict = action === "release" ? ("allow" as const) : ("drop" as const);
  const labelled: EntryState = {
    ...entry,
    verdict: {
      verdict,
      category:
        verdict === "allow"
          ? "benign"
          : (category ?? (reviewed && !UNINFORMATIVE.has(reviewed) ? reviewed : "attack")),
      confidence: 1,
      rationale: `Operator ${operator} chose ${action}.${note ? ` ${note}` : ""}`,
    },
  };
  const labelling = Promise.resolve(
    memory.label(archiveRecord(labelled, "operator", deps.now())),
  ).catch((err: unknown) =>
    console.error(JSON.stringify({ lazaret: "memory_label_failed", error: String(err) })),
  );
  deps.waitUntil(labelling);
}

/**
 * What an operator needs to decide. The body is attacker-controlled text: a UI must
 * render it as text, never as HTML. Credentials (authorization, cookie) are left out.
 */
function queueView(e: EntryState) {
  const body =
    e.request.bodyEncoding === "base64"
      ? `[binary body, ${Math.floor(((e.request.body ?? "").length * 3) / 4)} bytes]`
      : (e.request.body ?? "").slice(0, MAX_BODY_PREVIEW);
  return {
    id: e.id,
    batchId: e.batchId,
    status: e.status,
    route: e.route,
    receivedAt: e.receivedAt,
    session: e.sessionId.slice(0, 8),
    riskScore: Number(e.riskScore.toFixed(3)),
    signals: e.signals.map((s) => ({ id: s.id, weight: s.weight, evidence: s.evidence })),
    verdict: e.verdict ?? null,
    resolution: e.resolution ?? null,
    request: {
      method: e.request.method,
      path: e.request.path,
      query: e.request.query,
      contentType: e.request.headers["content-type"] ?? null,
      body,
    },
  };
}
