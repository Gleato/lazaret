// Replays each honest task's known-good MCP calls and checks the database afterwards.
// Usage (from evals/mcp, stack running): node run.ts [--skip-calls] [task-id ...]
// --skip-calls runs the checks without sending any calls: reads should pass, every write should fail.
// Settings: MCP_URL (where calls go; later steps point it at lazaret-mcp), DB_URL (where checks read).
// HOST_SECRET (step 5): play the agent's host. Each task gets a fresh run credential, and its
// prompt is set as that credential's task through lazaret-mcp's PUT /host/task first.
import { callTool, fullReset, initialize, psql, quickReset, startRun, tasks } from "./client.ts";

const skipCalls = process.argv.includes("--skip-calls");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const selected = only.length ? tasks.filter((t) => only.includes(t.id)) : tasks;

console.log("Full reset (supabase db reset)...");
await fullReset();

let passed = 0;
for (const task of selected) {
  let error = "";
  const refused: string[] = [];
  try {
    quickReset();
    await startRun(task.id, task.prompt);
    await initialize();
    // A refused call doesn't stop the task: the rest are still sent, as an agent might,
    // and the check still runs, so what reached the database is read from the database.
    if (!skipCalls)
      for (const call of task.calls)
        await callTool(call).catch((e: Error) => refused.push(e.message.slice(0, 200)));
    const got = psql(task.check.sql);
    if (got !== task.check.expect)
      error = `check got ${JSON.stringify(got)}, expected ${JSON.stringify(task.check.expect)}`;
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 300) : String(e);
  }
  if (refused.length) error = `${refused.join("; ")}  ${error || "check passed"}`;
  if (!error) passed++;
  console.log(
    `${error ? "FAIL" : "PASS"}  ${task.kind.padEnd(11)} ${task.id}${error ? `  ${error}` : ""}`,
  );
}
console.log(`${passed}/${selected.length} passed`);
process.exitCode = passed === selected.length ? 0 : 1;
