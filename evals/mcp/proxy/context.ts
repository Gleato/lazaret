// lazaret-mcp step 5: the user's task, captured by the agent's host (tasks/todo.md, option 1).
//
// The host (Claude Code's UserPromptSubmit hook, host-hook.mjs) sends each prompt the
// person types to `PUT /host/task` with the host secret, a credential the agent never has.
// The store keeps one task per run credential, the `Authorization` value the agent sends
// to /mcp, and a new prompt replaces the old one. The gateway's task lookup (review.task)
// reaches it only through the origin adapter in review.ts, keyed on the agent's own
// credential, never on anything the agent sends in a body or a header it chose.

export const TASK_PATH = "/agent/context";
export const HOST_TASK_PATH = "/host/task";
const MAX_TASK_CHARS = 8000; // the gateway keeps the first 2,000 (gateway/task.ts)

/** Where tasks live. In memory for local dev (one isolate); a deployment would use a DO. */
export interface TaskStore {
  get(credential: string): Promise<string | undefined>;
  set(credential: string, task: string): Promise<void>;
}

export function memoryStore(): TaskStore {
  const tasks = new Map<string, string>();
  return {
    get: async (credential) => tasks.get(credential),
    set: async (credential, task) => void tasks.set(credential, task),
  };
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  const hash = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

/** `PUT /host/task` with `Authorization: Bearer <host secret>` and `{credential, task}`. */
export async function hostTask(
  request: Request,
  store: TaskStore,
  hostSecret: string | undefined,
): Promise<Response> {
  if (request.method !== "PUT")
    return new Response(null, { status: 405, headers: { allow: "PUT" } });
  const auth = request.headers.get("authorization") ?? "";
  // No secret configured means no host: nobody can write.
  if (!hostSecret || !(await sameSecret(auth, `Bearer ${hostSecret}`)))
    return Response.json({ error: "host secret required" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as {
    credential?: unknown;
    task?: unknown;
  } | null;
  const { credential, task } = body ?? {};
  if (typeof credential !== "string" || !credential || credential === auth)
    return Response.json(
      { error: "credential must be the agent's Authorization value" },
      { status: 400 },
    );
  if (typeof task !== "string" || !task.trim())
    return Response.json({ error: "task must be non-empty text" }, { status: 400 });
  await store.set(credential, task.slice(0, MAX_TASK_CHARS));
  return new Response(null, { status: 204 });
}

/**
 * The gateway's signed `GET /agent/context`: 200 `{task}` for the agent's credential, 204
 * for a credential with no task (reviewed without one), 500 if the store fails, which
 * task.ts reads as unknown and fails closed.
 */
export async function lookupTask(request: Request, store: TaskStore): Promise<Response> {
  const credential = request.headers.get("authorization");
  if (!credential) return new Response(null, { status: 204 });
  try {
    const task = await store.get(credential);
    return task === undefined ? new Response(null, { status: 204 }) : Response.json({ task });
  } catch {
    return Response.json({ error: "task store failed" }, { status: 500 });
  }
}
