import { isWriteCall } from "./classify";

// lazaret-mcp: a proxy for MCP Streamable HTTP. Every request on /mcp goes to the upstream
// as it came (method, headers, body, so `_meta`, `Accept`, `MCP-Protocol-Version` and
// `Mcp-Session-Id` too), and the upstream's response comes back as it came, streamed, so
// `text/event-stream` passes through. The one exception (step 4): a `tools/call` that
// classify.ts counts as a write goes to `review` instead, which decides whether it's sent.

export const DEFAULT_UPSTREAM = "http://127.0.0.1:55421/mcp?features=database";

export interface ToolCall {
  id: string | number | null;
  name: unknown;
  arguments: unknown;
}

export type ReviewWrite = (
  call: ToolCall,
  request: Request,
  forward: () => Promise<Response>,
  env: object,
  ctx?: ExecutionContext,
) => Promise<Response>;

const rpcError = (code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status: 400 });

export function createProxy(
  upstream: string,
  fetchUpstream: typeof fetch = fetch,
  review?: ReviewWrite,
) {
  return async (request: Request, env: object = {}, ctx?: ExecutionContext): Promise<Response> => {
    if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
    const pass = async (req: Request) => {
      const res = await fetchUpstream(req);
      return new Response(res.body, { status: res.status, headers: res.headers });
    };
    if (!review || request.method !== "POST") return pass(new Request(upstream, request));

    const bytes = await request.arrayBuffer();
    const forward = () =>
      pass(new Request(upstream, { method: "POST", headers: request.headers, body: bytes }));
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return rpcError(-32700, "Parse error"); // fails closed: never forwarded
    }
    const isCall = (m: unknown) => (m as { method?: unknown } | null)?.method === "tools/call";
    // Batches were removed from MCP in 2025-06-18; don't try to review one in pieces.
    if (Array.isArray(message))
      return message.some(isCall)
        ? rpcError(-32600, "lazaret-mcp: no tools/call in a batch")
        : forward();
    if (!isCall(message)) return forward();
    const { id = null, params } = message as {
      id?: ToolCall["id"];
      params?: { name?: unknown; arguments?: unknown };
    };
    const call: ToolCall = { id, name: params?.name, arguments: params?.arguments };
    if (!(await isWriteCall(call.name, call.arguments))) return forward();
    return review(call, request, forward, env, ctx);
  };
}
