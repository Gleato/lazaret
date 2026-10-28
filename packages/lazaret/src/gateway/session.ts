import type { ResolvedConfig } from "../config/define";

// Session identity drives two things: the author-only read overlay (M4) and
// per-session behaviour/taint. Raw cookies and tokens are hashed before use, so
// credentials never become Ledger keys or show up in the visualiser.

export async function deriveSessionId(
  request: Request,
  config: ResolvedConfig,
): Promise<{ sessionId: string; ip: string }> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  let material: string | null = null;
  if (config.session.cookie)
    material = readCookie(request.headers.get("cookie"), config.session.cookie);
  if (!material && config.session.header) material = request.headers.get(config.session.header);
  // Fallback: IP + user agent. Coarse, but stable enough for read-your-writes.
  material ??= `anon|${ip}|${request.headers.get("user-agent") ?? ""}`;
  return { sessionId: await sha256Hex(material, 32), ip };
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

export async function sha256Hex(input: string, length = 64): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}
