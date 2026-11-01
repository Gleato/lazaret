// The consumer used by smoke-pack.sh: every entry point, as a user of the published
// package would import them.
import {
  createGateway,
  defineLazaret,
  LazaretBehaviour,
  LazaretLedger,
  LazaretMemory,
  LazaretReviewWorkflow,
} from "@gleator/lazaret";
import { verifyLazaretRequest } from "@gleator/lazaret/origin";
import type { LiveFrame } from "@gleator/lazaret/public";

const config = defineLazaret({
  origin: "https://api.example.com",
  routes: [{ match: "POST /api/posts", policy: "ESCROW", resources: ["post:{receipt}"] }],
  behaviour: { store: "durable" },
});
export class Ledger extends LazaretLedger {}
export class Memory extends LazaretMemory {}
export class Behaviour extends LazaretBehaviour {}
export class ReviewWorkflow extends LazaretReviewWorkflow {
  protected override lazaretConfig() {
    return config;
  }
}
const gateway = createGateway(config);
export const frame: LiveFrame = { type: "RESET" };
export const verify = verifyLazaretRequest;
export default { fetch: gateway.fetch, scheduled: gateway.scheduled };
