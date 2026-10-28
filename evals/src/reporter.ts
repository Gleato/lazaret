import { mkdirSync, writeFileSync } from "node:fs";
import type { Reporter, TestCase } from "vitest/node";

// Writes each eval run's results JSON (attached by the in-worker test as
// `task.meta.evalResult`, or `task.meta.memoryResult` for the Memory eval) to
// evals/results/. Only when EVAL_WRITE=1, so a plain `npm test` never dirties the tree.

type Written = { mode: string; startedAt: string };

export default class EvalResultsReporter implements Reporter {
  onTestCaseResult(testCase: TestCase) {
    if (process.env.EVAL_WRITE !== "1") return;
    const meta = testCase.meta();
    const corpus = meta.evalResult as Written | undefined;
    const memory = meta.memoryResult as Written | undefined;
    if (corpus) write(corpus, "", "live-latest.json");
    // The Memory eval (M7 E) feeds the site's memory panel, which reads memory-latest.json.
    if (memory) write(memory, "memory-", "memory-latest.json");
  }
}

function write(result: Written, prefix: string, latest: string) {
  const dir = new URL("../results/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  // Deterministic modes overwrite one file; live runs keep a history, one file per
  // run. Named by start time to the second: a date-only name let two runs on the same
  // day overwrite each other, and a published run's file was lost that way (M6.6).
  const body = `${JSON.stringify(result, null, 2)}\n`;
  const stamp = `${result.startedAt.slice(0, 19).replaceAll(":", "-")}Z`;
  const names =
    result.mode === "live"
      ? [`${prefix}live-${stamp}.json`, latest]
      : [`${prefix}${result.mode}.json`];
  for (const name of names) writeFileSync(new URL(name, dir), body);
  const file = new URL(names[0] as string, dir);
  console.log(`eval results written to ${file.pathname}`);
}
