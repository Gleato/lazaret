// Shared by run.ts and replay.ts: the MCP client, psql, and the database resets.
// Settings: MCP_URL (where calls go), DB_URL (where checks read and resets run).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:55421/mcp?features=database";
export const DB_URL =
  process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
export const HOST_SECRET = process.env.HOST_SECRET;
export const here = import.meta.dirname;

export type Call = { tool: string; arguments: Record<string, unknown> };
export type Task = {
  id: string;
  kind: string;
  prompt: string;
  calls: Call[];
  check: { sql: string; expect: string };
};

export const tasks = (
  JSON.parse(readFileSync(join(here, "tasks.json"), "utf8")) as { tasks: Task[] }
).tasks;

let runCredential = "";

/** lazaret-mcp stopped the run (a spend cap): the run is invalid, never a stopped attack. */
export class RunInvalid extends Error {}

// The one place calls leave the runner: a JSON-RPC request to an MCP server over Streamable HTTP.
type RpcResult = { isError?: boolean; content?: { text?: string }[] };
export async function rpc(method: string, params: object): Promise<RpcResult> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...(runCredential ? { Authorization: runCredential } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { error?: { message?: string }; result: RpcResult };
  if (res.status === 402) throw new RunInvalid(body.error?.message ?? "run invalid");
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

export async function initialize(): Promise<void> {
  await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "lazaret-mcp-eval", version: "0" },
  });
}

// Step 5: play the agent's host. A fresh run credential, whose task lazaret-mcp's
// PUT /host/task sets (what host-hook.ts does). Without HOST_SECRET, calls go without one.
// A null task (arm L) gives the run its own credential and no task.
export async function startRun(name: string, task: string | null): Promise<void> {
  if (!HOST_SECRET) return;
  runCredential = `Bearer run-${name}-${crypto.randomUUID()}`;
  if (task === null) return;
  const res = await fetch(new URL("/host/task", MCP_URL), {
    method: "PUT",
    headers: { Authorization: `Bearer ${HOST_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ credential: runCredential, task }),
  });
  if (res.status !== 204) throw new Error(`host task: ${res.status} ${await res.text()}`);
}

// Returns the tool result's text; throws with it if the call was refused or failed.
export async function callTool(call: Call): Promise<string> {
  const result = await rpc("tools/call", { name: call.tool, arguments: call.arguments });
  const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
  if (result.isError) throw new Error(`${call.tool}: ${text || "error"}`);
  return text;
}

// Runs SQL on stdin (so every statement's output shows, and psql variables work).
export function psql(sql: string, vars: Record<string, string> = {}): string {
  const v = Object.entries(vars).flatMap(([k, val]) => ["-v", `${k}=${val}`]);
  return execFileSync("psql", [DB_URL, "-qtA", "-v", "ON_ERROR_STOP=1", ...v, "-f", "-"], {
    encoding: "utf8",
    input: sql,
    stdio: "pipe",
    env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" },
  }).trim();
}

// Back to the seeded state in about a second (see reset.sql), against ~25 s for a full reset.
export function quickReset(): void {
  execFileSync(
    "psql",
    [
      DB_URL,
      "-qtA",
      "-v",
      "ON_ERROR_STOP=1",
      "-1",
      "-f",
      join(here, "reset.sql"),
      "-f",
      join(here, "supabase/migrations/20261118000000_ticket_app.sql"),
      "-f",
      join(here, "supabase/seed.sql"),
    ],
    { stdio: "pipe", env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" } },
  );
}

export async function fullReset(): Promise<void> {
  execFileSync("npx", ["supabase@3.2.0", "--workdir", here, "db", "reset"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      await initialize();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`no MCP server at ${MCP_URL}`);
}

// A hash of everything an attack here could change: roles and memberships, the public
// schema's grants and default privileges, every object in public with its grants, RLS,
// policies, columns, functions and triggers, object counts across the whole database,
// extensions, migrations, and the rows (minus timestamps, which the seed sets from now()).
export function fingerprint(): string {
  return psql(readFileSync(join(here, "fingerprint.sql"), "utf8"));
}

// Step 7: the proxy's run control (worker.ts). Host only, so a run can't change its own cap.
export async function hostRun(maxUsd?: number): Promise<Record<string, unknown>> {
  const res = await fetch(new URL("/__mcp/run", MCP_URL), {
    method: maxUsd === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${HOST_SECRET}`, "Content-Type": "application/json" },
    ...(maxUsd === undefined ? {} : { body: JSON.stringify({ maxUsd }) }),
  });
  if (!res.ok) throw new Error(`run control: ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}
