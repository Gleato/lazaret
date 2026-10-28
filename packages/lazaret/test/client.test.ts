import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicReviewer, defineLazaret, FatalReviewError } from "../src";

// AnthropicReviewer against a stub client: the request shape it sends, and how it
// maps each kind of response (including token usage, which evals price) to an outcome.

const config = defineLazaret({ origin: "https://o.test", routes: [] }).review;
const usage = {
  input_tokens: 1200,
  output_tokens: 300,
  cache_read_input_tokens: 2500,
  cache_creation_input_tokens: 0,
};

function stub(response: Record<string, unknown> | Error) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        create: async (req: Record<string, unknown>) => {
          requests.push(req);
          if (response instanceof Error) throw response;
          return { model: "claude-sonnet-5-5", usage, stop_details: null, ...response };
        },
      },
    },
  } as unknown as Anthropic;
  return { reviewer: new AnthropicReviewer("unused", config, client), requests };
}

describe("AnthropicReviewer", () => {
  it("returns parsed output with token usage, and uses the cached system prompt + schema", async () => {
    const { reviewer, requests } = stub({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"verdicts":[]}' }],
    });
    expect(await reviewer.review({ tier: "batch", prompt: "p" })).toEqual({
      kind: "output",
      output: { verdicts: [] },
      model: "claude-sonnet-5-5",
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 2500, cacheWriteTokens: 0 },
    });
    expect(requests[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      system: [{ cache_control: { type: "ephemeral" } }],
      output_config: { effort: "high", format: { type: "json_schema" } },
      fallbacks: "default",
    });
    expect(requests[0]?.thinking).toBeUndefined(); // batch review keeps adaptive thinking
  });

  it("maps refusals and truncation to explicit outcomes (both fail closed downstream)", async () => {
    const refused = stub({
      stop_reason: "refusal",
      stop_details: { category: "cyber" },
      content: [],
    });
    expect(await refused.reviewer.review({ tier: "batch", prompt: "p" })).toMatchObject({
      kind: "refusal",
      category: "cyber",
      usage: { inputTokens: 1200 },
    });
    const cut = stub({ stop_reason: "max_tokens", content: [] });
    expect(await cut.reviewer.review({ tier: "batch", prompt: "p" })).toMatchObject({
      kind: "incomplete",
      reason: "max_tokens",
    });
  });

  it("sends inline reviews to the fast model without server-side fallback", async () => {
    const { reviewer, requests } = stub({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "not json" }],
    });
    expect((await reviewer.review({ tier: "inline", prompt: "p" })).kind).toBe("incomplete");
    expect(requests[0]).toMatchObject({
      model: "claude-haiku-5-5",
      output_config: { effort: "low" },
      thinking: { type: "disabled" },
    });
    expect(requests[0]?.fallbacks).toBeUndefined();
  });

  it("treats a non-API failure as fatal", async () => {
    const { reviewer } = stub(new Error("boom"));
    await expect(reviewer.review({ tier: "batch", prompt: "p" })).rejects.toBeInstanceOf(
      FatalReviewError,
    );
  });
});
