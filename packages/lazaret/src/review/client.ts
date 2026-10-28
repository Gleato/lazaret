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

/**
 * Token usage of one call, for cost accounting (evals, and the M7 spend cap). Absent
 * for reviewers that don't call a model.
 */
export interface ReviewUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type ReviewOutcome =
  | { kind: "output"; output: unknown; model: string; usage?: ReviewUsage }
  | {
      kind: "refusal";
      category: string | null;
      model: string;
      usage?: ReviewUsage;
      /**
       * Set when the configured model declined and a server-side fallback answered in
       * its place. The fallback's output is kept as a note for a human. It never decides
       * an outcome (see AnthropicReviewer.review).
       */
      advisory?: { model: string; output: unknown };
    }
  | { kind: "incomplete"; reason: string; usage?: ReviewUsage };

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
  // Security judgment on batches deserves real thinking. Inline review is on a
  // client's critical path, so it answers without extended thinking. Measured in the
  // M6 live evals: with adaptive thinking at low effort, Haiku 5.5's inline verdicts
  // took 1.3-2.5 s p50 and up to a third hit the deadline, failing logins and credits
  // closed. Its verdicts were right whenever they arrived; it was a speed problem.
  batch: { effort: "high", maxTokens: 16_000, thinking: true },
  escalation: { effort: "high", maxTokens: 16_000, thinking: true },
  inline: { effort: "low", maxTokens: 2_000, thinking: false },
} as const;

/**
 * One structured-output call to Claude, shared by the reviewer and the rule
 * distiller. Maps API errors to transient vs fatal, and refusals and truncation
 * to explicit outcomes, so callers can fail closed.
 */
export async function structuredCall(
  client: Anthropic,
  params: {
    model: string;
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
    effort: "low" | "medium" | "high";
    maxTokens: number;
    /** False turns extended thinking off (latency-critical calls). Default: on (adaptive). */
    thinking?: boolean;
    signal?: AbortSignal | undefined;
    timeoutMs: number;
    maxRetries: number;
  },
): Promise<ReviewOutcome> {
  // Reviewing attack payloads can trip safety classifiers. The server-side
  // fallback re-runs a declined request on a suitable model instead of failing.
  // Haiku has no server-side fallback, and a refusal there fails closed below.
  const fallback = params.model.startsWith("claude-haiku")
    ? {}
    : { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01"] };

  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create(
      {
        model: params.model,
        max_tokens: params.maxTokens,
        // Static system prompt first, marked for caching: every call shares it.
        system: [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: params.prompt }],
        ...(params.thinking === false ? { thinking: { type: "disabled" as const } } : {}),
        output_config: {
          effort: params.effort,
          format: { type: "json_schema", schema: params.schema },
        },
        ...fallback,
      },
      { signal: params.signal, maxRetries: params.maxRetries, timeout: params.timeoutMs },
    );
  } catch (err) {
    if (
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.InternalServerError ||
      err instanceof Anthropic.APIConnectionError
    ) {
      throw new TransientReviewError(`model unavailable: ${(err as Error).message}`, {
        cause: err,
      });
    }
    if (err instanceof Anthropic.APIError && typeof err.status === "number" && err.status >= 500) {
      throw new TransientReviewError(`model error ${err.status}`, { cause: err });
    }
    throw new FatalReviewError(`model request failed: ${(err as Error).message}`, { cause: err });
  }

  const usage: ReviewUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
  };
  if (response.stop_reason === "refusal") {
    return {
      kind: "refusal",
      category: response.stop_details?.category ?? null,
      model: response.model,
      usage,
    };
  }
  if (response.stop_reason === "max_tokens")
    return { kind: "incomplete", reason: "max_tokens", usage };
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    return { kind: "output", output: JSON.parse(text), model: response.model, usage };
  } catch {
    return { kind: "incomplete", reason: "unparseable output", usage };
  }
}

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
    const outcome = await structuredCall(this.#client, {
      model,
      system: SYSTEM_PROMPT,
      prompt: call.prompt,
      schema: VERDICT_SCHEMA,
      effort: tier.effort,
      maxTokens: tier.maxTokens,
      thinking: tier.thinking,
      signal: call.signal,
      // Inline review has its own hard deadline; SDK retries would blow through it.
      maxRetries: call.tier === "inline" ? 0 : 2,
      timeoutMs: call.tier === "inline" ? this.#config.inlineTimeoutMs : 120_000,
    });
    // Only the model the operator configured may decide an outcome. If the server-side
    // fallback answered because that model declined, the answer is reported as a
    // refusal (which fails closed downstream), and the fallback's verdicts ride along
    // as a note for whoever reviews the quarantine. (M6.6: a model nobody chose must not
    // be the one that allows, or permanently drops, a write.)
    if ("model" in outcome && !isModel(outcome.model, model)) {
      return {
        kind: "refusal",
        category: "declined",
        model: outcome.model,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        advisory: {
          model: outcome.model,
          output: outcome.kind === "output" ? outcome.output : null,
        },
      };
    }
    return outcome;
  }
}

/** The API may answer an alias with a dated snapshot id (`claude-x-5-5-20261001`). */
function isModel(actual: string, configured: string): boolean {
  return actual === configured || actual.startsWith(`${configured}-`);
}
