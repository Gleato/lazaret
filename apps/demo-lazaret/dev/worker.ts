import { env } from "cloudflare:workers";
import { createGateway } from "@gleator/lazaret";
import { type Env, TidewaterReviewWorkflow } from "../src";
import { config } from "../src/config";
import { scriptedReviewer } from "../src/scripted-reviewer";

export { TidewaterLedger, TidewaterMemory } from "../src";

// Offline local development: the real Tidewater deployment with the scripted
// reviewer in place of Claude, so the whole stack runs with no API key and no
// spend. Started by `npm run dev` (wrangler.dev.jsonc). Never deployed.

export class DevReviewWorkflow extends TidewaterReviewWorkflow {
  protected override reviewer() {
    return scriptedReviewer;
  }
  protected override proposer() {
    return undefined;
  }
}

const gateway = createGateway(config, {
  fetchOrigin: (request) => (env as unknown as Env).ORIGIN.fetch(request),
  reviewer: scriptedReviewer,
});

export default {
  fetch: (request, workerEnv, ctx) => gateway.fetch(request, workerEnv, ctx),
  scheduled: (controller, workerEnv) => gateway.scheduled(controller, workerEnv),
} satisfies ExportedHandler<Env>;
