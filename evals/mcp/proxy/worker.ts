import { LazaretLedger, type Reviewer } from "@gleator/lazaret";
import pgWasm from "libpg-query/wasm/libpg-query.wasm";
import { loadParser } from "./classify";
import { HOST_TASK_PATH, hostTask, memoryStore } from "./context";
import { createProxy, DEFAULT_UPSTREAM } from "./proxy";
import { createWriteReview, scriptedReviewer } from "./review";

// Local only (see wrangler.jsonc): `npm run mcp:proxy -w @gleator/lazaret-evals`.
// MCP_REVIEWER picks the scripted reviewer: `--var MCP_REVIEWER:scripted:drop`.

interface ProxyEnv {
  UPSTREAM_MCP_URL?: string;
  MCP_REVIEWER?: string;
  /** The host's credential for PUT /host/task (step 5). Never given to the agent. */
  HOST_SECRET?: string;
}

/** The Ledger only keeps the spend counter here; nothing is dispatched for review. */
export class McpLedger extends LazaretLedger {
  protected override reviewWorkflowBinding(): string | null {
    return null;
  }
}

let proxy: ReturnType<typeof createProxy> | undefined;
const tasks = memoryStore();

/** Logs the task each reviewed write carried, so a run can show it (README, step 5). */
const logged = (reviewer: Reviewer): Reviewer => ({
  review(call) {
    const task = /<agent_task>([\s\S]*?)<\/agent_task>/.exec(call.prompt)?.[1];
    console.log(`[review] task=${task ?? "(none)"}`);
    return reviewer.review(call);
  },
});

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === HOST_TASK_PATH)
      return hostTask(request, tasks, env.HOST_SECRET);
    if (!proxy) {
      await loadParser(pgWasm);
      const review = createWriteReview(
        logged(scriptedReviewer(env.MCP_REVIEWER ?? "scripted:drop")),
        tasks,
      );
      proxy = createProxy(env.UPSTREAM_MCP_URL || DEFAULT_UPSTREAM, fetch, review);
    }
    return proxy(request, env, ctx);
  },
} satisfies ExportedHandler<ProxyEnv>;
