import type { ResolvedConfig } from "../config/define";

// Who is making an inline-reviewed request, according to origin.
//
// The first live eval quarantined small, legitimate credits because the reviewer
// "can't tell if the submitter is authorised" (tasks/todo.md, M6 review). Telling
// the reviewer that origin enforces authorisation would make it stop judging fraud
// on exactly the routes that need it. So instead the gateway asks origin, which
// already knows: a signed GET with the client's own headers (e.g. `/api/me`), and a
// few picked fields. Origin is the trusted side of Lazaret, so nothing new is trusted.
//
// The answer is a fact, not client data, so it goes in the prompt outside the
// untrusted block. Only short, identifier-like values survive, so a free-text field
// (a display name, say) can't carry an injection into that trusted position.

export type Actor = Record<string, string | number | boolean>;

const SAFE_VALUE = /^[\w.:@+-]{1,64}$/;

/**
 * `{ authenticated: true, ...fields }` on a 200, `{ authenticated: false }` on a 401
 * or 403, and null (unknown) on anything else, including a timeout. Never throws:
 * an unknown actor means the reviewer judges without one, as before.
 */
export async function lookupActor(
  actor: NonNullable<ResolvedConfig["review"]["actor"]>,
  send: (signal: AbortSignal) => Promise<Response>,
): Promise<Actor | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, actor.timeoutMs);
  });
  const lookup = async (): Promise<Actor | null> => {
    const res = await send(controller.signal);
    if (res.status === 401 || res.status === 403) return { authenticated: false };
    if (res.status !== 200) return null;
    const body: unknown = await res.json();
    const out: Actor = { authenticated: true };
    for (const [name, path] of Object.entries(actor.fields)) {
      const value = pick(body, path);
      if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
        out[name] = value;
      } else if (typeof value === "string" && SAFE_VALUE.test(value)) {
        out[name] = value;
      }
    }
    return out;
  };
  try {
    return await Promise.race([lookup(), deadline]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `a.b.c` over own properties only, so `__proto__` and friends resolve to nothing. */
function pick(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
