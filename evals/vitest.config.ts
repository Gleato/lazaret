import { existsSync, readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { loadCorpus } from "./src/corpus";

// The corpus is read here (Node) and handed to the workerd test as a binding.
//
// Live mode spends real money, so it needs three things at once: EVAL_LIVE=1, an
// explicit EVAL_CONFIRM_SPEND=yes, and ANTHROPIC_API_KEY in your shell. The key
// goes straight into the eval worker's bindings and is never printed or written.
// EVAL_MAX_USD caps the run (default $6); the harness stops calling the API there.

// The key can also live in `evals/.dev.vars` (gitignored, like the Workers' own .dev.vars),
// so a live run doesn't depend on whichever terminal happened to export it. The shell wins.
function devVar(name: string): string | undefined {
  if (!existsSync("./.dev.vars")) return undefined;
  for (const line of readFileSync("./.dev.vars", "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] === name) return m[2]?.replace(/^(["'])(.*)\1$/, "$2") || undefined;
  }
  return undefined;
}
process.env.ANTHROPIC_API_KEY ||= devVar("ANTHROPIC_API_KEY");

const corpus = loadCorpus("./corpus");
const live = process.env.EVAL_LIVE === "1";
if (live) {
  if (process.env.EVAL_CONFIRM_SPEND !== "yes")
    throw new Error(
      `Live eval over ${corpus.length} cases calls the Claude API (about $0.25 per run, capped at $${process.env.EVAL_MAX_USD ?? 6}). ` +
        "Re-run with EVAL_CONFIRM_SPEND=yes to proceed.",
    );
  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error("Live eval needs ANTHROPIC_API_KEY in your shell or in evals/.dev.vars.");
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Round-tripped so the binding is plain JSON, which is what Miniflare accepts.
          EVAL_CORPUS: JSON.parse(JSON.stringify(corpus)),
          ...(live
            ? {
                EVAL_LIVE: "1",
                EVAL_MAX_USD: process.env.EVAL_MAX_USD ?? "6",
                ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
              }
            : {}),
        },
      },
    }),
  ],
  test: {
    reporters: ["default", "./src/reporter.ts"],
    // A live run reviews ~10 batches at high effort, one after another.
    testTimeout: live ? 30 * 60_000 : 60_000,
  },
});
