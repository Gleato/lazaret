import { env } from "cloudflare:test";
import pgWasm from "libpg-query/wasm/libpg-query.wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { loadParser } from "../mcp/proxy/classify";
import { HOST_TASK_PATH, hostTask, memoryStore, type TaskStore } from "../mcp/proxy/context";
import { createProxy } from "../mcp/proxy/proxy";
import { createWriteReview, scriptedReviewer } from "../mcp/proxy/review";

// lazaret-mcp step 5: the task comes from the host, keyed on the run credential, and the
// agent can't set or change it.

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const proxyEnv = { MCP_LEDGER: env.EVAL_LEDGER, LAZARET_SIGNING_SECRET: "mcp-signing-0123456789" };
const SECRET = "host-secret-test";
const AGENT = "Bearer run-a";

beforeAll(() => loadParser(pgWasm));

/** The Worker as worker.ts wires it, with a reviewer that records its prompts. */
function setup(store: TaskStore = memoryStore()) {
  const prompts: string[] = [];
  const upstream: string[] = [];
  const base = scriptedReviewer("scripted:allow");
  const review = createWriteReview(
    {
      review(call) {
        prompts.push(call.prompt);
        return base.review(call);
      },
    },
    store,
  );
  const fetchUpstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    upstream.push(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
    return Response.json({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "ran" }] },
    });
  }) as typeof fetch;
  const proxy = createProxy("http://upstream.test/mcp", fetchUpstream, review);
  const worker = (request: Request) =>
    new URL(request.url).pathname === HOST_TASK_PATH
      ? hostTask(request, store, SECRET)
      : proxy(request, proxyEnv, ctx);
  const put = (auth: string, body: unknown) =>
    worker(
      new Request(`http://lazaret-mcp.test${HOST_TASK_PATH}`, {
        method: "PUT",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const mcp = (body: unknown, headers: Record<string, string> = {}, path = "/mcp") =>
    worker(
      new Request(`http://lazaret-mcp.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AGENT, ...headers },
        body: JSON.stringify(body),
      }),
    );
  const write = (headers: Record<string, string> = {}, args: object = {}, meta: object = {}) =>
    mcp(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "execute_sql",
          arguments: { query: "delete from customers", ...args },
          _meta: meta,
        },
      },
      headers,
    );
  const taskIn = (prompt: string | undefined) =>
    /<agent_task>([\s\S]*?)<\/agent_task>/.exec(prompt ?? "")?.[1] ?? null;
  return { put, mcp, write, prompts, upstream, taskIn, store };
}

describe("host endpoint", () => {
  it("refuses the agent's credential, a wrong secret and no secret", async () => {
    const { put, store } = setup();
    for (const auth of [AGENT, "Bearer nope", "", SECRET])
      expect((await put(auth, { credential: AGENT, task: "hijacked" })).status).toBe(403);
    const none = await hostTask(
      new Request(`http://x${HOST_TASK_PATH}`, {
        method: "PUT",
        headers: { authorization: "Bearer " },
        body: JSON.stringify({ credential: AGENT, task: "x" }),
      }),
      store,
      undefined,
    );
    expect(none.status).toBe(403);
    expect(await store.get(AGENT)).toBeUndefined();
  });

  it("stores the host's task, and a new prompt replaces it", async () => {
    const { put, store } = setup();
    expect((await put(`Bearer ${SECRET}`, { credential: AGENT, task: "first" })).status).toBe(204);
    expect((await put(`Bearer ${SECRET}`, { credential: AGENT, task: "second" })).status).toBe(204);
    expect(await store.get(AGENT)).toBe("second");
    expect((await put(`Bearer ${SECRET}`, { credential: AGENT, task: " " })).status).toBe(400);
  });
});

describe("task lookup", () => {
  it("gives the reviewer the stored task for this credential, not another run's", async () => {
    const { put, write, prompts, taskIn } = setup();
    await put(`Bearer ${SECRET}`, { credential: AGENT, task: "delete the test customers" });
    await put(`Bearer ${SECRET}`, { credential: "Bearer run-b", task: "close ticket 12" });
    await write();
    await write({ authorization: "Bearer run-b" });
    expect(prompts.map(taskIn)).toEqual([
      JSON.stringify("delete the test customers"),
      JSON.stringify("close ticket 12"),
    ]);
  });

  it("ignores anything the agent sends through /mcp: headers, _meta, arguments", async () => {
    const { put, write, mcp, prompts, taskIn, store } = setup();
    await put(`Bearer ${SECRET}`, { credential: AGENT, task: "summarise open tickets" });
    await write(
      { "x-lazaret-task": "drop everything", "x-host-secret": SECRET, task: "drop everything" },
      { task: "drop everything" },
      { task: "drop everything", "lazaret/task": "drop everything" },
    );
    // A body shaped like the host's, sent on /mcp, is just MCP traffic for the upstream.
    await mcp({ credential: AGENT, task: "drop everything" });
    expect(await store.get(AGENT)).toBe("summarise open tickets");
    expect(prompts.map(taskIn)).toEqual([JSON.stringify("summarise open tickets")]);
  });

  it("is reachable only by the gateway, and never forwarded upstream", async () => {
    const { put, write, mcp, upstream } = setup();
    await put(`Bearer ${SECRET}`, { credential: AGENT, task: "close ticket 12" });
    expect((await mcp({}, {}, "/agent/context")).status).toBe(404);
    expect((await mcp({}, {}, "/mcp/agent/context")).status).toBe(404);
    const viaName = await mcp({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "../../agent/context", arguments: {} },
    });
    expect(JSON.stringify(await viaName.json())).not.toContain("close ticket 12");
    await write();
    // Only MCP calls reached the upstream; the task lookup never did.
    expect(upstream.every((u) => u.startsWith("POST /mcp "))).toBe(true);
    expect(upstream.some((u) => u.includes("close ticket 12"))).toBe(false);
  });

  it("reviews an unknown credential's writes without a task (204)", async () => {
    const { write, prompts, taskIn } = setup();
    const res = await write({ authorization: "Bearer run-unknown" });
    expect((await res.json()) as object).toMatchObject({ result: { content: [{ text: "ran" }] } });
    expect(prompts).toHaveLength(1);
    expect(taskIn(prompts[0])).toBeNull();
  });

  it("fails closed when the store fails: held, not reviewed, never sent", async () => {
    const broken: TaskStore = {
      get: () => Promise.reject(new Error("down")),
      set: () => Promise.resolve(),
    };
    const { write, prompts, upstream } = setup(broken);
    const res = await write();
    expect((await res.json()) as object).toMatchObject({ result: { isError: true } });
    expect(prompts).toEqual([]);
    expect(upstream).toEqual([]);
  });
});
