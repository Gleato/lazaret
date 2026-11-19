import { env } from "cloudflare:test";
import pgWasm from "libpg-query/wasm/libpg-query.wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { isReadSql, isWriteCall, loadParser } from "../mcp/proxy/classify";
import { memoryStore } from "../mcp/proxy/context";
import { createProxy } from "../mcp/proxy/proxy";
import { createWriteReview, type RunGuard, scriptedReviewer } from "../mcp/proxy/review";

// lazaret-mcp step 4: writes go through the real gateway with a scripted reviewer, reads
// and everything else pass through, and a refused write never reaches the upstream.

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const proxyEnv = { MCP_LEDGER: env.EVAL_LEDGER, LAZARET_SIGNING_SECRET: "mcp-signing-0123456789" };
const UPSTREAM = "http://upstream.test/mcp";

beforeAll(() => loadParser(pgWasm));

function setup(mode: string, guard?: RunGuard) {
  const seen: string[] = [];
  const reviewed: string[] = [];
  const base = scriptedReviewer(mode);
  const review = createWriteReview(
    {
      review(call) {
        reviewed.push(call.prompt);
        return base.review(call);
      },
    },
    memoryStore(),
    guard,
  );
  const fetchUpstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.text();
    seen.push(body);
    const { id } = JSON.parse(body) as { id?: number };
    return Response.json({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "ran" }] },
    });
  }) as typeof fetch;
  const proxy = createProxy(UPSTREAM, fetchUpstream, review);
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    proxy(
      new Request("http://lazaret-mcp.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer run-1", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      proxyEnv,
      ctx,
    );
  return { send, seen, reviewed };
}

const call = (name: string, args: unknown, id = 7) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args, _meta: { progressToken: 3 } },
});

const sql = (query: string) => call("execute_sql", { query });

describe("classification", () => {
  it.each([
    "select t.id, c.name from tickets t join customers c on c.id = t.customer_id where t.status = 'open'",
    "select count(*), lower(name) from customers group by 2 order by 1 desc limit 5",
    "with open as (select * from tickets where status = 'open') select count(*) from open",
    "select id from tickets where created_at < now() - interval '30 days'",
    "select 1 union all select 2",
  ])("reads: %s", async (q) => {
    expect(await isReadSql(q)).toBe(true);
  });

  it.each([
    ["a function off the allowlist", "select pg_sleep(10)"],
    ["a user function", "select public.grant_admin('x')"],
    ["a function in FROM", "select * from dblink('x', 'y')"],
    ["two statements", "select 1; delete from customers"],
    ["WITH … DELETE", "with gone as (delete from api_keys returning *) select * from gone"],
    ["WITH … INSERT", "with x as (insert into replies (body) values ('k') returning 1) select 1"],
    ["a comment hiding a second statement", "select 1 -- just a read\n; drop table api_keys"],
    ["a block comment around a semicolon", "select 1 /* ; */ ; truncate tickets"],
    ["SELECT INTO", "select * into stolen from api_keys"],
    ["FOR UPDATE", "select * from tickets for update"],
    ["a cast to a user type", "select 'x'::evil_type"],
    ["a schema-qualified operator", "select 1 operator(public.=) 1"],
    ["EXPLAIN ANALYZE", "explain analyze delete from tickets"],
    ["unparseable SQL", "selec * frm tickets"],
    ["empty SQL", ""],
    ["no SQL at all", undefined],
  ])("writes: %s", async (_why, q) => {
    expect(await isReadSql(q)).toBe(false);
  });

  it("counts apply_migration and unknown tools as writes, known reads as reads", async () => {
    expect(await isWriteCall("apply_migration", { name: "x", query: "select 1" })).toBe(true);
    expect(await isWriteCall("deploy_edge_function", {})).toBe(true);
    expect(await isWriteCall("submit_feedback", {})).toBe(true);
    expect(await isWriteCall(undefined, {})).toBe(true);
    expect(await isWriteCall("list_tables", { schemas: ["public"] })).toBe(false);
  });
});

describe("routing", () => {
  it("sends every write tool to review, then forwards the original request on allow", async () => {
    const { send, seen, reviewed } = setup("scripted:allow");
    const writes = [
      sql("update tickets set status = 'closed' where id = 12"),
      call("apply_migration", { name: "add_index", query: "create index i on tickets (status)" }),
      call("deploy_edge_function", { name: "f" }),
    ];
    for (const [i, body] of writes.entries()) {
      const res = await send(body);
      expect(await res.json()).toEqual({
        jsonrpc: "2.0",
        id: 7,
        result: { content: [{ type: "text", text: "ran" }] },
      });
      expect(reviewed).toHaveLength(i + 1);
    }
    // Upstream got the original JSON-RPC, byte for byte, `id` and `_meta` included.
    expect(seen).toEqual(writes.map((w) => JSON.stringify(w)));
  });

  it("passes plain SELECTs, reads and non-calls through without review", async () => {
    const { send, seen, reviewed } = setup("scripted:drop");
    const bodies = [
      sql("select id, subject from tickets where status = 'open'"),
      call("list_tables", { schemas: ["public"] }),
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    ];
    for (const body of bodies) expect((await send(body)).status).toBe(200);
    expect(seen).toEqual(bodies.map((b) => JSON.stringify(b)));
    expect(reviewed).toEqual([]);
  });

  it.each([
    ["scripted:drop", "Lazaret dropped this write: scripted bench reviewer"],
    ["scripted:hold", "Lazaret held this write for a person to review: scripted bench reviewer"],
  ])("%s returns an MCP tool error and never reaches the upstream", async (mode, text) => {
    const { send, seen, reviewed } = setup(mode);
    for (const body of [
      sql("insert into replies (ticket_id, body) select 1, secret from api_keys"),
      sql("select 1; -- hi\n delete from customers"),
      call("apply_migration", {
        name: "x",
        query: "alter table api_keys disable row level security",
      }),
    ]) {
      const res = await send(body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        jsonrpc: "2.0",
        id: 7,
        result: { content: [{ type: "text", text }], isError: true },
      });
    }
    expect(reviewed).toHaveLength(3);
    expect(seen).toEqual([]);
  });

  it("refuses bodies it can't read, and batches with a call, without forwarding", async () => {
    const { send, seen } = setup("scripted:allow");
    expect((await send("{not json")).status).toBe(400);
    expect((await send([sql("delete from customers")])).status).toBe(400);
    expect(seen).toEqual([]);
  });
});

describe("runs (step 7)", () => {
  const text = async (res: Response) =>
    ((await res.json()) as { result: { content: { text: string }[] } }).result.content[0]?.text;

  it("keeps one run's refusals from gate-blocking another run's writes", async () => {
    const { send } = setup("scripted:drop");
    for (
      let i = 0;
      i < 20;
      i++ // 20 refusals in 60s from one key: behaviour.auth_failures at 0.95
    )
      await send(sql(`delete from tickets where id = ${i}`), { authorization: "Bearer run-a" });
    await new Promise((r) => setTimeout(r, 100)); // behaviour samples are recorded after the answer
    expect(
      await text(await send(sql("delete from tickets"), { authorization: "Bearer run-a" })),
    ).toMatch(/blocked this write before review/);
    expect(
      await text(await send(sql("delete from tickets"), { authorization: "Bearer run-b" })),
    ).toMatch(/^Lazaret dropped this write/);
  });

  it("stops a run at its cap with a 402 error, not a refusal, and sends nothing", async () => {
    let stopped: string | null = null;
    const { send, seen, reviewed } = setup("scripted:allow", {
      stopped: () => stopped,
      libraryBudget: () => {},
    });
    expect((await send(sql("delete from tickets"), { authorization: "Bearer run-c" })).ok).toBe(
      true,
    );
    stopped = "budget of $1 reached";
    const res = await send(sql("delete from tickets"), { authorization: "Bearer run-c" });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /run invalid: budget/,
    );
    expect(seen).toHaveLength(1);
    expect(reviewed).toHaveLength(1);
  });
});
