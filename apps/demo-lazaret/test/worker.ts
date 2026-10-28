import { env } from "cloudflare:workers";
import origin from "@gleator/tidewater-origin";
import { TidewaterLedger, TidewaterReviewWorkflow } from "../src";
import { scriptedReviewer } from "../src/scripted-reviewer";

export { TidewaterMemory } from "../src";
export { calls as reviewCalls, scriptedReviewer } from "../src/scripted-reviewer";

/** The real Tidewater Worker, called in-process the way the ORIGIN service binding would. */
export const originFetch = (request: Request) =>
  origin.fetch(request as Parameters<typeof origin.fetch>[0], {
    DB: env.DB,
    LAZARET_SIGNING_SECRET: env.LAZARET_SIGNING_SECRET,
  });

export class TestLedger extends TidewaterLedger {}

export class TestReviewWorkflow extends TidewaterReviewWorkflow {
  protected override reviewer() {
    return scriptedReviewer;
  }
  protected override proposer() {
    return undefined;
  }
  protected override fetchOrigin() {
    return originFetch;
  }
}

export default {
  fetch: () => new Response("tidewater-lazaret test worker", { status: 404 }),
} satisfies ExportedHandler;
