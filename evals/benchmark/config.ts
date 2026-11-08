import { defineLazaret } from "@gleator/lazaret";
import { CONTEXT_PATH } from "./bench";

// One generic deployment for the AgentDojo pilot: every state-changing agent tool call
// is one INLINE_REVIEW write. Inline, because escrow discards origin's response
// (commit/committer.ts) and an agent's next step needs an answer straight away. The
// deadline stays at the production 3 s, so a slow review counts as it would for a user.
//
// dailyBudgetUsd only keeps the library's own cap out of the way. The run's real cap is
// BenchRun.maxUsd in bench.ts, which can invalidate a run instead of looking like a stop.
//
// `review.task` is on for every arm. What an arm's sessions get back from origin is what
// differs, so all of them run the real lookup (see bench.ts).
export const benchConfig = defineLazaret({
  origin: "https://bench.test",
  routes: [{ match: "POST /tools/:name", policy: "INLINE_REVIEW" }],
  session: { header: "authorization" },
  ledger: { binding: "BENCH_LEDGER" },
  review: {
    dailyBudgetUsd: 50,
    task: { path: CONTEXT_PATH, toolResultsField: "tool_results" },
  },
});
