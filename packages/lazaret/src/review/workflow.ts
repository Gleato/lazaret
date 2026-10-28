import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createCommitter } from "../commit/committer";
import type { ResolvedConfig } from "../config/define";
import type { LazaretLedger, ReviewDispatch } from "../ledger/durable-object";
import { AnthropicReviewer, type Reviewer } from "./client";
import { type LedgerPort, runReviewPipeline, type StepRunner } from "./pipeline";

// The Review Workflow runs the pipeline as a Cloudflare Workflow. Workflows give
// us server-side execution that survives crashes and deploys (principle 3), with
// each step's result persisted so a restart resumes at the first unfinished step
// instead of starting over (principle 4).
//
//   export class ReviewWorkflow extends LazaretReviewWorkflow<Env> {
//     protected override lazaretConfig() { return config; }
//   }

export class LazaretReviewWorkflow<Env = unknown> extends WorkflowEntrypoint<Env, ReviewDispatch> {
  protected lazaretConfig(): ResolvedConfig {
    throw new Error("Subclass LazaretReviewWorkflow and override lazaretConfig()");
  }

  protected reviewer(config: ResolvedConfig): Reviewer {
    const key = this.#binding<string>(config.review.apiKeyBinding);
    if (!key) throw new Error(`Lazaret: missing secret ${config.review.apiKeyBinding}`);
    return new AnthropicReviewer(key, config.review);
  }

  /** How the Committer reaches origin. Override for a service binding. */
  protected fetchOrigin(): ((request: Request) => Promise<Response>) | undefined {
    return undefined;
  }

  override async run(event: Readonly<WorkflowEvent<ReviewDispatch>>, step: WorkflowStep) {
    const config = this.lazaretConfig();
    const ns = this.#binding<DurableObjectNamespace<LazaretLedger>>(config.ledger.binding);
    const secret = this.#binding<string>(config.signing.secretBinding);
    if (!ns || !secret)
      throw new Error("Lazaret: Workflow is missing its Ledger binding or signing secret");
    const ledger = ns.get(ns.idFromString(event.payload.ledgerId)) as unknown as LedgerPort;

    const runner: StepRunner = {
      do: <T>(
        name: string,
        fn: () => Promise<T>,
        options?: { retries?: number; retryDelayMs?: number },
      ) =>
        step.do(
          name,
          {
            retries: {
              limit: options?.retries ?? 0,
              delay: options?.retryDelayMs ?? 1_000,
              backoff: "exponential",
            },
            timeout: "5 minutes",
          },
          // Step results must be serialisable; the pipeline only returns plain data.
          fn as () => Promise<never>,
        ) as Promise<T>,
      sleep: (name, ms) => step.sleep(name, ms),
    };

    const fetchOrigin = this.fetchOrigin();
    return runReviewPipeline(
      runner,
      {
        ledger,
        reviewer: this.reviewer(config),
        committer: createCommitter({
          origin: config.origin,
          secret,
          ...(fetchOrigin ? { fetchOrigin } : {}),
        }),
        config,
      },
      event.payload.batchId,
    );
  }

  #binding<T>(name: string): T | undefined {
    return (this.env as Record<string, unknown>)[name] as T | undefined;
  }
}
