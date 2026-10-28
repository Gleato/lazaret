// Author-only read overlay (tasks/todo.md §2.4).
//
// Escrow makes writes slow to land, which would make an app feel broken: you post
// a ticket and it isn't in your list. The overlay fixes that for the *author only*.
// When a session reads a route, its own pending writes are merged into origin's
// response. Everyone else sees only origin data, which by construction has passed
// review, so a stored-XSS payload can never reach another user before it's vetted.
//
// Mergers are pure functions over parsed JSON. Built-ins cover the common REST
// shapes. A custom function covers the rest.

/** One of the session's writes still in escrow, as a merger sees it. */
export interface PendingWrite {
  receipt: string;
  /** Parsed JSON body of the write, or undefined if it wasn't JSON. */
  json: unknown;
  /** Route params of the write, e.g. `{ id: "42" }` for `PATCH /api/tickets/:id`. */
  params: Record<string, string>;
  receivedAt: number;
}

export interface MergeContext {
  /** Route params of the read being served. */
  params: Record<string, string>;
}

export type MergeFn = (body: unknown, pending: PendingWrite[], ctx: MergeContext) => unknown;

export type BuiltinMerge = "append-json-array" | "patch-json-by-id" | "merge-json-object";

export interface OverlayConfig {
  /** The read route to decorate, e.g. "GET /api/tickets". */
  on: string;
  merge: BuiltinMerge | MergeFn;
  /** Dot path to the array/object inside the response, e.g. "data.tickets". Default: the root. */
  path?: string;
  /** For `patch-json-by-id`: the item field to match. Default "id". */
  idField?: string;
  /** For `patch-json-by-id`: the write's route param holding the id. Default "id". */
  idParam?: string;
}

/** Marker added to every overlaid item so the client can render it as "pending review". */
export const PENDING_MARKER = "_lazaret";

const annotate = (value: unknown, receipt: string): unknown =>
  isRecord(value) ? { ...value, [PENDING_MARKER]: { pending: true, receipt } } : value;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Apply `fn` to the value at `path` inside `body`, returning a new body (no mutation). */
function updateAt(
  body: unknown,
  path: string | undefined,
  fn: (target: unknown) => unknown,
): unknown {
  if (!path) return fn(body);
  const [head, ...rest] = path.split(".");
  if (!head || !isRecord(body) || !Object.hasOwn(body, head)) return body;
  return { ...body, [head]: updateAt(body[head], rest.join(".") || undefined, fn) };
}

export function builtinMerge(config: OverlayConfig & { merge: BuiltinMerge }): MergeFn {
  const idField = config.idField ?? "id";
  const idParam = config.idParam ?? "id";
  switch (config.merge) {
    case "append-json-array":
      return (body, pending) =>
        updateAt(body, config.path, (target) =>
          Array.isArray(target)
            ? [
                ...target,
                ...pending.filter((p) => isRecord(p.json)).map((p) => annotate(p.json, p.receipt)),
              ]
            : target,
        );
    case "patch-json-by-id":
      return (body, pending) =>
        updateAt(body, config.path, (target) => {
          if (!Array.isArray(target)) return target;
          return target.map((item) => {
            if (!isRecord(item)) return item;
            let out: unknown = item;
            for (const p of pending) {
              if (isRecord(p.json) && String(item[idField]) === p.params[idParam]) {
                out = annotate({ ...(out as Record<string, unknown>), ...p.json }, p.receipt);
              }
            }
            return out;
          });
        });
    case "merge-json-object":
      return (body, pending) =>
        updateAt(body, config.path, (target) => {
          if (!isRecord(target)) return target;
          let out: unknown = target;
          for (const p of pending) {
            if (isRecord(p.json))
              out = annotate({ ...(out as Record<string, unknown>), ...p.json }, p.receipt);
          }
          return out;
        });
    default: {
      const unknownMerge: never = config.merge;
      throw new Error(`unknown overlay merge ${String(unknownMerge)}`);
    }
  }
}
