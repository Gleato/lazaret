import { mkdirSync, writeFileSync } from "node:fs";
import type { Reporter, TestCase } from "vitest/node";

// Writes each eval run's results JSON (attached by the in-worker test as
// `task.meta.evalResult`) to evals/results/. Only when EVAL_WRITE=1, so a plain
// `npm test` never dirties the tree.

export default class EvalResultsReporter implements Reporter {
  onTestCaseResult(testCase: TestCase) {
    const result = testCase.meta().evalResult as { mode: string; startedAt: string } | undefined;
    if (!result || process.env.EVAL_WRITE !== "1") return;
    const dir = new URL("../results/", import.meta.url);
    mkdirSync(dir, { recursive: true });
    // Deterministic modes overwrite one file; live runs keep a history, one file per
    // run. Named by start time to the second: a date-only name let two runs on the same
    // day overwrite each other, and a published run's file was lost that way (M6.6).
    const body = `${JSON.stringify(result, null, 2)}\n`;
    const stamp = `${result.startedAt.slice(0, 19).replaceAll(":", "-")}Z`;
    const names =
      result.mode === "live" ? [`live-${stamp}.json`, "live-latest.json"] : [`${result.mode}.json`];
    for (const name of names) writeFileSync(new URL(name, dir), body);
    const file = new URL(names[0] as string, dir);
    console.log(`eval results written to ${file.pathname}`);
  }
}
