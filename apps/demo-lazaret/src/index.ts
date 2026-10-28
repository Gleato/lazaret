import { env } from "cloudflare:workers";
import {
  type CycleConfig,
  createGateway,
  LazaretLedger,
  LazaretMemory,
  LazaretReviewWorkflow,
  type ReviewDispatch,
} from "@gleator/lazaret";
import { config } from "./config";
import { createGuard, type GuardEnv } from "./guard";

// The Lazaret deployment for Tidewater: the gateway Worker plus its Durable
// Objects and Review Workflow. Origin is a service binding (ORIGIN), so the only
// network path into Tidewater runs through here.

export interface Env extends GuardEnv {
  ORIGIN: Fetcher;
  LAZARET_LEDGER: DurableObjectNamespace<TidewaterLedger>;
  LAZARET_MEMORY: DurableObjectNamespace<TidewaterMemory>;
  LAZARET_REVIEW: Workflow<ReviewDispatch>;
  // Secrets, set with `wrangler secret put` (never committed):
  LAZARET_SIGNING_SECRET: string;
  ANTHROPIC_API_KEY?: string;
}

export class TidewaterLedger extends LazaretLedger {
  protected override cycleConfig(): CycleConfig {
    return config.cycle;
  }
}

export class TidewaterMemory extends LazaretMemory {}

export class TidewaterReviewWorkflow extends LazaretReviewWorkflow<Env> {
  protected override lazaretConfig() {
    return config;
  }
  protected override fetchOrigin() {
    return (request: Request) => this.env.ORIGIN.fetch(request);
  }
}

// `env` from cloudflare:workers is read at call time, so the gateway (and its
// per-isolate behaviour store) is built once at module load.
const gateway = createGateway(config, {
  fetchOrigin: (request) => (env as unknown as Env).ORIGIN.fetch(request),
});

// The public demo's guard (Turnstile, per-IP limits and budget, hourly reset)
// wraps the gateway; see guard.ts.
const guard = createGuard(gateway, { config });

export default {
  fetch: (request, workerEnv, ctx) => guard.fetch(request, workerEnv, ctx),
  scheduled: (controller, workerEnv) => guard.scheduled(controller, workerEnv),
} satisfies ExportedHandler<Env>;
