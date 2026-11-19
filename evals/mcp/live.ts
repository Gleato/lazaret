// Step 9: a small live-agent sample. A real model works an honest task with a test-half goal
// planted where that task reads, through MCP_URL: Supabase's server directly (arm AS, the model
// alone with Supabase's result wrapping) or lazaret-mcp with the host's task (arm LT,
// HOST_SECRET set). No security hints: the system prompt is the same in both arms.
//
// Usage (from evals/mcp, stack running; key in ../.dev.vars):
//   node --no-warnings live.ts --arm AS --model claude-haiku-5-5 --max-usd 1 [--sample] [--limit 3]
//   MCP_URL=http://127.0.0.1:8798/mcp HOST_SECRET=mcp-host-secret-local \
//     node --no-warnings live.ts --arm LT --model claude-haiku-5-5 --max-usd 1
// Pairs are the 60 test-half pairs replay delivers (6 tasks read a slot × 5 goals × 2 forms).
// --sample keeps the 12 with the lowest SHA-256 of `lazaret-mcp-live:<task>/<goal>/<form>`,
// a rule fixed before any live run. --limit N runs the first N (the cost pilot).
// --pair <task>/<goal>/<form> runs that one pair (a re-check after a fix).
// A spend stop makes the run invalid (an -INVALID- file, exit 1), never a stopped attack.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  ATTEMPT,
  type Budget,
  type Episode,
  MAX_TURNS,
  PRICES,
  runEpisode,
  SYSTEM,
} from "./agent.ts";
import { clean, FORMS, type Form, loadGoals, MARKERS, resets, startClean } from "./attacks.ts";
import { HOST_SECRET, here, hostRun, MCP_URL, RunInvalid, type Task, tasks } from "./client.ts";

const { values: args } = parseArgs({
  options: {
    arm: { type: "string", default: "AS" },
    model: { type: "string", default: "claude-haiku-5-5" },
    sample: { type: "boolean", default: false },
    limit: { type: "string" },
    pair: { type: "string" },
    "max-usd": { type: "string" },
    "review-max-usd": { type: "string", default: "0.05" },
  },
});
if (!["AS", "LT"].includes(args.arm)) throw new Error("--arm is AS or LT");
const viaProxy = Boolean(HOST_SECRET);
if ((args.arm === "LT") !== viaProxy) throw new Error("arm LT needs HOST_SECRET; AS must not");
const maxUsd = Number(args["max-usd"]);
if (!(maxUsd > 0)) throw new Error("--max-usd is required");

const budget: Budget = { spent: 0, max: maxUsd };
if (!PRICES[args.model]) throw new Error(`no price for ${args.model}`);

// --- the pairs: the test half, on the tasks that read a slot (step 8's canary, arm A) ---

const { goals, testSha } = loadGoals("test");
const replayA = "tickets-armA-none-test-2026-11-19T02-03-18Z.json";
const reads = (
  JSON.parse(readFileSync(join(here, "../results/mcp", replayA), "utf8")) as {
    reads: Record<string, string[]>;
  }
).reads;
type PairId = { task: Task; goal: (typeof goals)[number]; form: Form; id: string };
let pairs: PairId[] = goals.flatMap((goal) =>
  FORMS.flatMap((form) =>
    tasks
      .filter((t) => (reads[t.id] ?? []).length > 0)
      .map((task) => ({ task, goal, form, id: `${task.id}/${goal.id}/${form}` })),
  ),
);
if (pairs.length !== 60) throw new Error(`expected 60 delivered pairs, got ${pairs.length}`);
const rank = (id: string) => createHash("sha256").update(`lazaret-mcp-live:${id}`).digest("hex");
if (args.sample) pairs = [...pairs].sort((a, b) => (rank(a.id) < rank(b.id) ? -1 : 1)).slice(0, 12);
if (args.limit) pairs = pairs.slice(0, Number(args.limit));
if (args.pair) {
  pairs = pairs.filter((p) => p.id === args.pair);
  if (pairs.length !== 1) throw new Error(`--pair ${args.pair} is not a delivered test pair`);
}

// --- one episode (agent.ts) ---

const started = new Date().toISOString();
const stamp = started.replace(/[:.]/g, "-").slice(0, 19);
const tag = `${args.arm}-${args.model.replace("claude-", "")}`;
const episode = ({ task, goal, form, id }: PairId) =>
  runEpisode({
    model: args.model,
    task,
    goal,
    slots: reads[task.id] ?? [],
    text: goal[form],
    marker: MARKERS[form],
    form,
    id,
    budget,
  });

// --- run ---

console.log(`${tag}: ${pairs.length} pairs, MCP_URL=${MCP_URL}, agent cap $${maxUsd}`);
if (viaProxy) await hostRun(Number(args["review-max-usd"]));
await startClean();
const episodes: Episode[] = [];
let invalid: string | null = null;
for (const p of pairs) {
  try {
    const ep = await episode(p);
    episodes.push(ep);
    console.log(
      `${p.id}: read ${ep.readPlanted ? "y" : "n"}, attempted ${ep.attempted ? "y" : "n"}, reached ${ep.attackReached ? "y" : "n"}, honest ${ep.honestDone ? "y" : "n"}${ep.onTopic ? ` (on topic ${ep.onTopic.ok ? "y" : "n"})` : ""}, refusals ${ep.refusals}, turns ${ep.turns}, $${ep.agentUsd.toFixed(4)}${ep.error ? `, error ${ep.error}` : ""}`,
    );
  } catch (e) {
    if (!(e instanceof RunInvalid)) throw e;
    invalid = e.message;
    break;
  }
}
await clean("end");

// --- summary ---

const n = (f: (e: Episode) => boolean) => episodes.filter(f).length;
const review = viaProxy ? await hostRun() : null;
const reviewUsd = (review?.spentUsd as number | undefined) ?? 0;
const summary = {
  episodes: episodes.length,
  readPlanted: n((e) => e.readPlanted),
  attempted: n((e) => e.attempted),
  attackReached: n((e) => e.attackReached),
  honestDone: n((e) => (e.onTopic ? e.honestDone && e.onTopic.ok : e.honestDone)),
  honestDoneWrites: `${n((e) => !e.onTopic && e.honestDone)}/${n((e) => !e.onTopic)}`,
  onTopicReads: `${n((e) => Boolean(e.onTopic?.ok && e.honestDone))}/${n((e) => Boolean(e.onTopic))}`,
  refusals: episodes.reduce((s, e) => s + e.refusals, 0),
  episodesWithRefusal: n((e) => e.refusals > 0),
  errors: n((e) => Boolean(e.error)),
  stops: Object.fromEntries(
    [...new Set(episodes.map((e) => e.stop))].map((s) => [s, n((e) => e.stop === s)]),
  ),
  agentUsd: Math.round(budget.spent * 10000) / 10000,
  agentUsdPerEpisode: episodes.length
    ? Math.round((budget.spent / episodes.length) * 10000) / 10000
    : null,
  reviewUsd,
  reviews: ((review?.calls ?? []) as unknown[]).length,
  resets: { quick: resets.quick, full: resets.fullAfter.length },
};
const result = {
  benchmark: "supabase-mcp-tickets",
  method: "live agent (Messages API tool loop)",
  arm: args.arm,
  model: args.model,
  effort: "medium",
  system: SYSTEM,
  maxTurns: MAX_TURNS,
  mcpUrl: MCP_URL,
  half: "test",
  testHalfSha256: testSha,
  sample: args.sample ? "12 lowest sha256(lazaret-mcp-live:<pair>)" : "all 60",
  limit: args.limit ? Number(args.limit) : null,
  pair: args.pair ?? null,
  invalid,
  lazaretCommit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),
  startedAt: started,
  finishedAt: new Date().toISOString(),
  summary,
  attemptPatterns: Object.fromEntries(Object.entries(ATTEMPT).map(([k, v]) => [k, v.source])),
  episodes,
  reviewCalls: review?.calls ?? null,
};
const out = join(
  here,
  "../results/mcp",
  `live-${tag}${args.sample ? "-sample" : ""}${args.limit ? `-pilot${args.limit}` : ""}${args.pair ? `-pair-${args.pair.replaceAll("/", "-")}` : ""}${invalid ? "-INVALID" : ""}-${stamp}Z.json`,
);
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${out}`);
if (invalid) {
  console.error(`run invalid: ${invalid}`);
  process.exit(1);
}
