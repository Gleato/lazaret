import { json } from "./http";

// Exactly-once writes on top of Lazaret's at-least-once Committer.
//
// The Committer retries on 5xx or network failure, and a Workflow step can crash
// after origin accepted a write but before the step checkpointed. Either way the
// same write arrives again with the same `x-lazaret-id`. So each write handler
// returns its response *and* the statements that perform it. They run in one D1
// batch (a transaction) together with the row that records the response. A
// re-send finds that row and gets the original response back, byte for byte, with
// no second side effect.

export interface WriteResult {
  status: number;
  body: unknown;
  /** The side effects. Empty for a definitive refusal (4xx), which is recorded too. */
  statements: D1PreparedStatement[];
}

export const REPLAYED_HEADER = "x-tidewater-replayed";

export async function onceByLazaretId(
  db: D1Database,
  req: { id: string; method: string; path: string; now: number },
  run: () => Promise<WriteResult>,
): Promise<Response> {
  const previous = await lookup(db, req.id);
  if (previous) return previous;

  const result = await run();
  const body = JSON.stringify(result.body);
  const record = db
    .prepare(
      "INSERT INTO lazaret_requests (id, method, path, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(req.id, req.method, req.path, result.status, body, req.now);
  try {
    // The record goes first: if two copies race, the loser's batch fails on the
    // primary key before any of its side effects apply.
    await db.batch([record, ...result.statements]);
  } catch (err) {
    const raced = await lookup(db, req.id);
    if (raced) return raced;
    throw err;
  }
  return json(result.status, result.body);
}

async function lookup(db: D1Database, id: string): Promise<Response | null> {
  const row = await db
    .prepare("SELECT status, body FROM lazaret_requests WHERE id = ?")
    .bind(id)
    .first<{ status: number; body: string }>();
  if (!row) return null;
  return new Response(row.body, {
    status: row.status,
    headers: { "content-type": "application/json", [REPLAYED_HEADER]: "1" },
  });
}
