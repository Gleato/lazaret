import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Reads the deployed origin's D1 through wrangler (the operator's own Cloudflare
// login), so assertions look at what Tidewater actually stored, not at what Lazaret
// says it did. Read-only queries only.

const ORIGIN_CONFIG = fileURLToPath(
  new URL("../../apps/demo-origin/wrangler.jsonc", import.meta.url),
);
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function query<T>(sql: string): T[] {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error("d1.query is read-only");
  const out = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "tidewater",
      "--remote",
      "--json",
      "-c",
      ORIGIN_CONFIG,
      "--command",
      sql,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(out) as { results: T[] }[];
  return parsed[0]?.results ?? [];
}

/** Quote an id for SQL. Ids are UUIDs or seed ids, so anything else is refused. */
export function id(value: string): string {
  if (!ID.test(value)) throw new Error(`refusing to put ${JSON.stringify(value)} in SQL`);
  return `'${value}'`;
}

/** Did a request with this Lazaret id (an escrow receipt or a request id) reach origin? */
export function reachedOrigin(lazaretId: string): boolean {
  return (
    query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM lazaret_requests WHERE id = ${id(lazaretId)}`,
    )[0]?.n !== 0
  );
}
