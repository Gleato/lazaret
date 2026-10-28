import { env } from "cloudflare:test";
import { signRequest } from "@gleator/lazaret";
import worker from "../src";

// Requests as Lazaret would send them: HMAC-signed, with a request id that, for
// committed writes, is the Ledger entry id.

export const SECRET = env.LAZARET_SIGNING_SECRET;
export const PASSWORD = "tidewater-demo";

export interface CallOptions {
  body?: unknown;
  token?: string;
  /** Lazaret request id. Defaults to a fresh UUID; reuse one to simulate a Committer re-send. */
  id?: string;
  /** Skip signing, to call origin the way an attacker bypassing Lazaret would. */
  unsigned?: boolean;
  headers?: Record<string, string>;
}

export async function call(method: string, path: string, options: CallOptions = {}) {
  const id = options.id ?? crypto.randomUUID();
  const body =
    options.body === undefined ? null : new TextEncoder().encode(JSON.stringify(options.body));
  const url = new URL(path, "https://tidewater.internal");
  const signature = options.unsigned
    ? {}
    : await signRequest(
        {
          id,
          method,
          target: url.pathname + url.search,
          body,
          timestamp: Math.floor(Date.now() / 1000),
        },
        SECRET,
      );
  const headers: Record<string, string> = {
    ...signature,
    ...(body ? { "content-type": "application/json" } : {}),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...options.headers,
  };
  const res = await worker.fetch(new Request(url, { method, headers, body }), env);
  const text = await res.text();
  return { res, status: res.status, id, json: text ? JSON.parse(text) : null };
}

export async function loginAs(who: "mara" | "theo" | "sam"): Promise<string> {
  const { status, json } = await call("POST", "/api/login", {
    body: { email: `${who}@tidewater.test`, password: PASSWORD },
  });
  if (status !== 200) throw new Error(`login failed: ${status}`);
  return json.token as string;
}

export async function count(table: string, where = "1 = 1", ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
