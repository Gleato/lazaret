import { HttpError } from "./http";

// Accounts, passwords and bearer tokens. Ordinary app auth, with nothing
// Lazaret-specific. Lazaret derives its session id from the same `authorization`
// header (hashed), so "author-only overlay" means "this logged-in user".

export interface Account {
  id: string;
  email: string;
  display_name: string;
  role: "customer" | "agent" | "admin";
  balance_cents: number;
  email_notifications: number;
}

const ACCOUNT_COLUMNS = "id, email, display_name, role, balance_cents, email_notifications";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
// Workers caps PBKDF2 at 100k iterations.
const PBKDF2_ITERATIONS = 100_000;
const encoder = new TextEncoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

export function randomToken(prefix: string): string {
  return `${prefix}_${toHex(crypto.getRandomValues(new Uint8Array(24)))}`;
}

async function pbkdf2(password: string, salt: string, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Stored format: `pbkdf2$<iterations>$<salt>$<hex>`. */
export async function hashPassword(password: string, salt: string): Promise<string> {
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${toHex(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hex] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hex) return false;
  const actual = toHex(await pbkdf2(password, salt, Number(iter)));
  // Compare digests of the hex strings so the comparison time doesn't leak a prefix.
  const [a, b] = await Promise.all([sha256Hex(actual), sha256Hex(hex)]);
  return a === b;
}

// Hash of "not-a-real-password" under a fixed salt. Unknown emails still pay for one
// PBKDF2 run, so response time doesn't reveal which emails have accounts.
const DUMMY_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$dummy-salt$${"0".repeat(64)}`;

export async function login(
  db: D1Database,
  email: string,
  password: string,
  now: number,
): Promise<{ token: string; account: Account }> {
  const row = await db
    .prepare(`SELECT ${ACCOUNT_COLUMNS}, password_hash FROM accounts WHERE email = ?`)
    .bind(email.toLowerCase())
    .first<Account & { password_hash: string }>();
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) throw new HttpError(401, "invalid email or password");
  const token = randomToken("tw");
  await db
    .prepare(
      "INSERT INTO auth_tokens (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(await sha256Hex(token), row.id, now, now + TOKEN_TTL_MS)
    .run();
  const { password_hash: _, ...account } = row;
  return { token, account };
}

/** The account behind `authorization: Bearer <token>`, or null. */
export async function authenticate(
  db: D1Database,
  request: Request,
  now: number,
): Promise<Account | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(tw_[0-9a-f]{48})$/.exec(header);
  if (!match?.[1]) return null;
  return db
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS.split(", ")
        .map((c) => `a.${c}`)
        .join(", ")}
       FROM auth_tokens t JOIN accounts a ON a.id = t.account_id
       WHERE t.token_hash = ? AND t.expires_at > ?`,
    )
    .bind(await sha256Hex(match[1]), now)
    .first<Account>();
}

export function getAccount(db: D1Database, id: string): Promise<Account | null> {
  return db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).bind(id).first();
}
