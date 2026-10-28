import Anthropic from "@anthropic-ai/sdk";
import type { ResolvedConfig } from "../config/define";
import { SYSTEM_PROMPT } from "./prompt";
import { VERDICT_SCHEMA } from "./schema";

// The reviewer "brain" (principle 2). It takes a prompt and returns raw structured
// output. It has no tools, no network of its own, and no way to act. Everything
// that changes state happens elsewhere, in the Ledger and the Committer.
//
// `Reviewer` is an interface so the pipeline can be tested deterministically, and
// so another model provider could slot in without touching the harness.

export type ReviewTier = "batch" | "escalation" | "inline";

export interface ReviewCall {
  tier: ReviewTier;
  prompt: string;
  signal?: AbortSignal;
}

export type ReviewOutcome =
  | { kind: "output"; output: unknown; model: string }
  | { kind: "refusal"; category: string | null; model: string }
  | { kind: "incomplete"; reason: string };

export interface Reviewer {
  review(call: ReviewCall): Promise<ReviewOutcome>;
}

/** Worth retrying: rate limits, overload, network trouble, timeouts. */
export class TransientReviewError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientReviewError";
  }
}

/** Not worth retrying (bad request, auth, refusal, malformed output): fail closed. */
export class FatalReviewError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FatalReviewError";
  }
}

const TIERS = {
  // Security judgment on batches deserves real thinking; inline review is on a
  // client's critical path, so it runs at low effort under a hard deadline.
  batch: { effort: "high", maxTokens: 16_000 },
  escalation: { effort: "high", maxTokens: 16_000 },
  inline: { effort: "low", maxTokens: 2_000 },
} as const;

export class AnthropicReviewer implements Reviewer {
  readonly #client: Anthropic;
  readonly #config: ResolvedConfig["review"];

  constructor(apiKey: string, config: ResolvedConfig["review"], client?: Anthropic) {
    this.#client = client ?? new Anthropic({ apiKey });
    this.#config = config;
  }

  async review(call: ReviewCall): Promise<ReviewOutcome> {
    const model = {
      batch: this.#config.batchModel,
      escalation: this.#config.escalationModel,
      inline: this.#config.inlineModel,
    }[call.tier];
    const tier = TIERS[call.tier];
    // Reviewing attack payloads can trip safety classifiers. The server-side
    // fallback re-runs a declined request on a suitable model instead of failing.
    // Haiku has no server-side fallback, and a refusal there fails closed below.
    const fallback = model.startsWith("claude-haiku")
      ? {}
      : { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01"] };

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.#client.beta.messages.create(
        {
          model,
          max_tokens: tier.maxTokens,
          // Static system prompt first, marked for caching: every review shares it.
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: call.prompt }],
          output_config: {
            effort: tier.effort,
            format: { type: "json_schema", schema: VERDICT_SCHEMA },
          },
          ...fallback,
        },
        {
          signal: call.signal,
          // Inline review has its own hard deadline; SDK retries would blow through it.
          maxRetries: call.tier === "inline" ? 0 : 2,
          timeout: call.tier === "inline" ? this.#config.inlineTimeoutMs : 120_000,
        },
      );
    } catch (err) {
      if (
        err instanceof Anthropic.RateLimitError ||
        err instanceof Anthropic.InternalServerError ||
        err instanceof Anthropic.APIConnectionError
      ) {
        throw new TransientReviewError(`reviewer unavailable: ${(err as Error).message}`, {
          cause: err,
        });
      }
      if (
        err instanceof Anthropic.APIError &&
        typeof err.status === "number" &&
        err.status >= 500
      ) {
        throw new TransientReviewError(`reviewer error ${err.status}`, { cause: err });
      }
      throw new FatalReviewError(`reviewer request failed: ${(err as Error).message}`, {
        cause: err,
      });
    }

    if (response.stop_reason === "refusal") {
      return {
        kind: "refusal",
        category: response.stop_details?.category ?? null,
        model: response.model,
      };
    }
    if (response.stop_reason === "max_tokens") return { kind: "incomplete", reason: "max_tokens" };
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    try {
      return { kind: "output", output: JSON.parse(text), model: response.model };
    } catch {
      return { kind: "incomplete", reason: "unparseable output" };
    }
  }
}
