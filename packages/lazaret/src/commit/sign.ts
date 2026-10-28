// Request signing between Lazaret and origin (tasks/todo.md §2.6).
//
// Escrow is only meaningful if origin refuses writes that didn't come through
// Lazaret. Otherwise an attacker just skips the edge and calls origin directly. So
// every request Lazaret sends (committed writes and forwarded reads alike) carries
// an HMAC over a canonical form of the request, and origin verifies it with
// `verifyLazaretRequest` (exported from `@gleator/lazaret/origin`).
//
// Canonical string (v1), newline-joined:
//   v1, unix-seconds timestamp, request id, METHOD, path?query, sha256(body) hex
// The request id is the Ledger entry id for committed writes, which doubles as an
// idempotency key: origin can dedupe a Committer replay after a crash.

export const SIGNATURE_VERSION = "v1";
export const HEADER_SIGNATURE = "x-lazaret-signature";
export const HEADER_TIMESTAMP = "x-lazaret-timestamp";
export const HEADER_ID = "x-lazaret-id";

export interface SignableRequest {
  id: string;
  method: string;
  /** Path plus query string, exactly as sent, e.g. `/api/tickets?x=1`. */
  target: string;
  body: Uint8Array | null;
  /** Unix seconds. */
  timestamp: number;
}

const encoder = new TextEncoder();

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (!secret || secret.length < 16)
    throw new Error("Lazaret signing secret must be at least 16 characters");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function canonical(req: SignableRequest): Promise<Uint8Array> {
  const bodyHash = await sha256Hex(req.body ?? new Uint8Array());
  return encoder.encode(
    [
      SIGNATURE_VERSION,
      String(req.timestamp),
      req.id,
      req.method.toUpperCase(),
      req.target,
      bodyHash,
    ].join("\n"),
  );
}

/** Headers to add to an outgoing request. */
export async function signRequest(
  req: SignableRequest,
  secret: string,
): Promise<Record<string, string>> {
  const key = await hmacKey(secret, "sign");
  const mac = await crypto.subtle.sign("HMAC", key, await canonical(req));
  return {
    [HEADER_SIGNATURE]: `${SIGNATURE_VERSION}=${toHex(new Uint8Array(mac))}`,
    [HEADER_TIMESTAMP]: String(req.timestamp),
    [HEADER_ID]: req.id,
  };
}

export type VerifyResult =
  | { ok: true; id: string; body: Uint8Array }
  | { ok: false; reason: "missing_headers" | "bad_signature" | "stale" | "malformed" };

/**
 * Verify a request from Lazaret. Reads the body (from a clone, so the original is
 * still usable) and returns it, so callers don't have to read it twice.
 * Comparison uses `crypto.subtle.verify`, which is constant-time.
 */
export async function verifyLazaretRequest(
  request: Request,
  secret: string,
  options: { maxSkewSec?: number; now?: number } = {},
): Promise<VerifyResult> {
  const signature = request.headers.get(HEADER_SIGNATURE);
  const timestamp = request.headers.get(HEADER_TIMESTAMP);
  const id = request.headers.get(HEADER_ID);
  if (!signature || !timestamp || !id) return { ok: false, reason: "missing_headers" };

  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return { ok: false, reason: "malformed" };
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(now - ts) > (options.maxSkewSec ?? 300)) return { ok: false, reason: "stale" };

  const [version, hex] = signature.split("=", 2);
  const mac = version === SIGNATURE_VERSION && hex ? fromHex(hex) : null;
  if (!mac) return { ok: false, reason: "malformed" };

  const url = new URL(request.url);
  const body = new Uint8Array(await request.clone().arrayBuffer());
  const data = await canonical({
    id,
    method: request.method,
    target: url.pathname + url.search,
    body: body.byteLength ? body : null,
    timestamp: ts,
  });
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), mac, data);
  return valid ? { ok: true, id, body } : { ok: false, reason: "bad_signature" };
}
