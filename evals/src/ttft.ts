import Anthropic from "@anthropic-ai/sdk";
import { buildBatchPrompt, type EntryState, SYSTEM_PROMPT, VERDICT_SCHEMA } from "@gleator/lazaret";

// Time to first token for the inline tier, measured, not borrowed (principle 2).
// The production reviewer doesn't stream (it needs the whole JSON verdict anyway),
// so this probe sends the same request shape as an inline review, streamed, and
// times the first output event. Live mode only; a handful of Haiku calls.

const entry: EntryState = {
  id: "ttft-probe",
  batchId: "probe",
  status: "PENDING",
  receivedAt: 0,
  sessionId: "probe-session",
  route: "POST /api/login",
  riskScore: 0,
  signals: [],
  resources: [],
  request: {
    method: "POST",
    path: "/api/login",
    query: "",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "mara@tidewater.test", password: "[redacted]" }),
    bodyEncoding: "utf8",
  },
};

export async function measureTtft(apiKey: string, model: string, samples = 5) {
  const client = new Anthropic({ apiKey });
  const firstEventMs: number[] = [];
  const totalMs: number[] = [];
  for (let i = 0; i < samples; i++) {
    const started = Date.now();
    let first: number | null = null;
    const stream = client.messages.stream({
      model,
      max_tokens: 2_000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildBatchPrompt([entry], []) }],
      // Same shape as the production inline call (src/review/client.ts TIERS.inline).
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: VERDICT_SCHEMA } },
    });
    for await (const event of stream) {
      if (first === null && event.type === "content_block_delta") first = Date.now() - started;
    }
    firstEventMs.push(first ?? Date.now() - started);
    totalMs.push(Date.now() - started);
  }
  return { model, samples, firstTokenMs: firstEventMs, totalMs };
}
