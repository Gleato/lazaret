// HTTP plumbing for the gateway: capped body reads and header hygiene.

export class BodyTooLarge extends Error {}

/** Read a body without ever buffering more than `max` bytes. */
export async function readBodyCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return null;
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (declared > max) throw new BodyTooLarge();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

const TEXTUAL =
  /^(?:text\/|application\/(?:json|[\w.+-]*\+json|x-www-form-urlencoded|xml|[\w.+-]*\+xml|graphql))/i;

export function isTextual(contentType: string): boolean {
  return contentType === "" || TEXTUAL.test(contentType);
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * Headers safe to forward or escrow. Strips hop-by-hop headers and Cloudflare's own
 * headers, and above all any client-supplied `x-lazaret-*`: the Committer signs
 * requests with those (M3), so a client must never be able to pre-set them.
 */
export function forwardableHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k.startsWith("cf-") || k.startsWith("x-lazaret-")) return;
    out[k] = value;
  });
  return out;
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
