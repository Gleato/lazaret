// Sends the same requests straight to Supabase's MCP server and through lazaret-mcp, and
// checks the status, content type and body match byte for byte.
// Usage (from evals/mcp, stack and proxy running): node --no-warnings proxy/compare.ts
export {};

const DIRECT = process.env.DIRECT_URL ?? "http://127.0.0.1:55421/mcp?features=database";
const PROXY = process.env.PROXY_URL ?? "http://127.0.0.1:8798/mcp";

const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "MCP-Protocol-Version": "2025-11-25",
};
const client = { name: "lazaret-mcp-eval", version: "0" };
const requests: [string, unknown][] = [
  [
    "initialize",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: client },
    },
  ],
  ["notifications/initialized", { jsonrpc: "2.0", method: "notifications/initialized" }],
  ["tools/list", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
  [
    "tools/call list_tables",
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "list_tables",
        arguments: { schemas: ["public"] },
        _meta: { progressToken: 7 },
      },
    },
  ],
  ["unknown method", { jsonrpc: "2.0", id: 4, method: "no/such", params: {} }],
];

async function send(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return `${res.status} ${res.headers.get("content-type")} ${res.headers.get("mcp-session-id")}\n${await res.text()}`;
}

let failed = 0;
for (const [name, body] of requests) {
  const [direct, proxied] = [await send(DIRECT, body), await send(PROXY, body)];
  if (direct !== proxied) failed++;
  console.log(`${direct === proxied ? "SAME" : "DIFF"}  ${name}  (${direct.split("\n")[0]})`);
  if (direct !== proxied)
    console.log(`  direct:  ${direct.slice(0, 300)}\n  proxied: ${proxied.slice(0, 300)}`);
}
console.log(failed ? `${failed} differ` : `all ${requests.length} identical`);
process.exitCode = failed ? 1 : 0;
