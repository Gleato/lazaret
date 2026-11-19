import { describe, expect, it } from "vitest";
import { createProxy } from "../mcp/proxy/proxy";

// lazaret-mcp step 3: the proxy must change nothing on the way up or back.

const UPSTREAM = "http://upstream.test/mcp?features=database";

function stub(respond: (r: Request) => Response | Promise<Response>) {
  const seen: { request: Request; body: string }[] = [];
  const fetchUpstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ request, body: await request.clone().text() });
    return respond(request);
  }) as typeof fetch;
  return { proxy: createProxy(UPSTREAM, fetchUpstream), seen };
}

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://lazaret-mcp.test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...headers,
    },
    body,
  });

describe("lazaret-mcp pass-through", () => {
  it("forwards a tools/call with its body, _meta and MCP headers untouched", async () => {
    const { proxy, seen } = stub(() => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "execute_sql",
        arguments: { query: "select 1" },
        _meta: { "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } },
      },
    });
    await proxy(post(body, { "Mcp-Session-Id": "s-1" }));
    const [{ request, body: sent }] = seen as [(typeof seen)[0]];
    expect(request.url).toBe(UPSTREAM);
    expect(request.method).toBe("POST");
    expect(sent).toBe(body);
    expect(request.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(request.headers.get("mcp-protocol-version")).toBe("2025-11-25");
    expect(request.headers.get("mcp-session-id")).toBe("s-1");
    expect(request.headers.get("content-type")).toBe("application/json");
  });

  it("returns the upstream's status, headers and body as they came", async () => {
    const upstreamBody = '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}';
    const { proxy } = stub(
      () =>
        new Response(upstreamBody, {
          status: 400,
          headers: { "Content-Type": "application/json", "Mcp-Session-Id": "s-2" },
        }),
    );
    const res = await proxy(post("{}"));
    expect(res.status).toBe(400);
    expect(res.headers.get("mcp-session-id")).toBe("s-2");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(upstreamBody);
  });

  it("passes a notification's 202 with no body", async () => {
    const { proxy, seen } = stub(() => new Response(null, { status: 202 }));
    const res = await proxy(post('{"jsonrpc":"2.0","method":"notifications/initialized"}'));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(seen[0]?.body).toBe('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  });

  it("streams text/event-stream through as it arrives", async () => {
    let push!: (s: string) => void;
    let end!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        push = (s) => c.enqueue(new TextEncoder().encode(s));
        end = () => c.close();
      },
    });
    const { proxy } = stub(
      () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
    );
    push("event: message\ndata: 1\n\n");
    const res = await proxy(post("{}"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>)
      .pipeThrough(new TextDecoderStream())
      .getReader();
    expect((await reader.read()).value).toBe("event: message\ndata: 1\n\n"); // before the end
    push("data: 2\n\n");
    end();
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += r.value;
    expect(rest).toBe("data: 2\n\n");
  });

  it("forwards GET and DELETE on /mcp, and nothing off it", async () => {
    const { proxy, seen } = stub(() => new Response(null, { status: 405 }));
    const get = await proxy(new Request("http://lazaret-mcp.test/mcp", { method: "GET" }));
    const del = await proxy(
      new Request("http://lazaret-mcp.test/mcp", {
        method: "DELETE",
        headers: { "Mcp-Session-Id": "s-3" },
      }),
    );
    expect([get.status, del.status]).toEqual([405, 405]);
    expect(seen.map((s) => s.request.method)).toEqual(["GET", "DELETE"]);
    expect(seen[1]?.request.headers.get("mcp-session-id")).toBe("s-3");
    const other = await proxy(new Request("http://lazaret-mcp.test/other", { method: "POST" }));
    expect(other.status).toBe(404);
    expect(seen).toHaveLength(2);
  });
});
