import { AnthropicReviewer, createGateway, LazaretLedger, type Reviewer } from "@gleator/lazaret";
import { type BenchEnv, createBench } from "./bench";
import { benchConfig } from "./config";

// Local only (see wrangler.jsonc): `npm run bench:serve -w @gleator/lazaret-evals`.

/** The Ledger only keeps the spend counter here; nothing is dispatched for review. */
export class BenchLedger extends LazaretLedger {
  protected override reviewWorkflowBinding(): string | null {
    return null;
  }
}

const bench = createBench(
  (reviewer: Reviewer, fetchOrigin) => createGateway(benchConfig, { fetchOrigin, reviewer }),
  (apiKey) => new AnthropicReviewer(apiKey, benchConfig.review),
);

export default {
  fetch: (request, env, ctx) => bench.fetch(request, env, ctx),
} satisfies ExportedHandler<BenchEnv>;
