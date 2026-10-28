// Small HTTP helpers. Every API response is JSON, and every error is a thrown
// HttpError that the top-level handler turns into `{ error }` with a status.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/** Parse a JSON object body. Anything else (including arrays) is a 400. */
export function parseJsonObject(body: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "body must be a JSON object");
  return value as Record<string, unknown>;
}

/** A required string field, trimmed, with a length range. */
export function str(
  obj: Record<string, unknown>,
  field: string,
  { min = 1, max }: { min?: number; max: number },
): string {
  const v = obj[field];
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  const s = v.trim();
  if (s.length < min || s.length > max)
    throw new HttpError(400, `${field} must be ${min}-${max} characters`);
  return s;
}
