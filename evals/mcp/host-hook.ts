// lazaret-mcp step 5: a Claude Code UserPromptSubmit hook. Claude Code passes the prompt the
// person typed as JSON on stdin; this sends it to lazaret-mcp's context store as the task
// for the run credential the agent's .mcp.json sends. The model never sees the host secret.
//
// Env: LAZARET_MCP_HOST (default http://127.0.0.1:8798), LAZARET_RUN_TOKEN, LAZARET_HOST_SECRET.
// If the task can't be set, exit 2 blocks the prompt: otherwise the agent would run under
// the previous prompt's task.

import { text } from "node:stream/consumers";

const host = process.env.LAZARET_MCP_HOST ?? "http://127.0.0.1:8798";
const token = process.env.LAZARET_RUN_TOKEN;
const secret = process.env.LAZARET_HOST_SECRET;

function fail(message: string): never {
  process.stderr.write(`lazaret-mcp: ${message}\n`);
  process.exit(2);
}

if (!token || !secret) fail("set LAZARET_RUN_TOKEN and LAZARET_HOST_SECRET");
const input = await text(process.stdin);
let prompt: unknown;
try {
  prompt = (JSON.parse(input) as { prompt?: unknown }).prompt;
} catch {
  fail("hook input isn't JSON");
}
if (typeof prompt !== "string" || !prompt.trim()) fail("hook input has no prompt");

const res = await fetch(new URL("/host/task", host), {
  method: "PUT",
  headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
  body: JSON.stringify({ credential: `Bearer ${token}`, task: prompt }),
}).catch((e: Error) => fail(`couldn't reach ${host}: ${e.message}`));
if (res.status !== 204) fail(`task not set (${res.status} ${await res.text()})`);
