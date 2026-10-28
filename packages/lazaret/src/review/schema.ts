import type { VerdictRecord } from "../ledger/types";

// The reviewer's output contract. The API enforces the JSON shape (structured
// outputs), and `parseVerdicts` enforces everything the schema can't express:
// exactly one verdict per entry, no invented ids, and a sane confidence. Any
// violation is treated as a compromised or broken review, and the batch fails
// closed. We never "repair" a reviewer's answer.

export const VERDICT_CATEGORIES = [
  "benign",
  "sqli",
  "xss",
  "path_traversal",
  "command_injection",
  "ssrf",
  "template_injection",
  "prompt_injection",
  "mass_assignment",
  "nosql_injection",
  "prototype_pollution",
  "fraud",
  "credential_attack",
  "automation_abuse",
  "spam",
  "malware",
  "other",
] as const;

export const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["entry_id", "verdict", "category", "confidence", "rationale"],
        properties: {
          entry_id: { type: "string" },
          verdict: { type: "string", enum: ["allow", "drop", "quarantine"] },
          category: { type: "string", enum: [...VERDICT_CATEGORIES] },
          confidence: { type: "number" },
          rationale: { type: "string" },
        },
      },
    },
  },
} as const;

/** The review output broke the contract. Not retryable: fail closed. */
export class MalformedReviewError extends Error {
  constructor(reason: string) {
    super(`malformed review: ${reason}`);
    this.name = "MalformedReviewError";
  }
}

const MAX_RATIONALE = 400;

export function parseVerdicts(
  output: unknown,
  expectedIds: string[],
): Record<string, VerdictRecord> {
  if (
    output === null ||
    typeof output !== "object" ||
    !Array.isArray((output as { verdicts?: unknown }).verdicts)
  ) {
    throw new MalformedReviewError("missing verdicts array");
  }
  const expected = new Set(expectedIds);
  const result: Record<string, VerdictRecord> = {};
  for (const raw of (output as { verdicts: unknown[] }).verdicts) {
    const v = raw as Record<string, unknown>;
    const id = v.entry_id;
    if (typeof id !== "string" || !expected.has(id))
      throw new MalformedReviewError(`unknown entry_id ${String(id)}`);
    if (Object.hasOwn(result, id)) throw new MalformedReviewError(`duplicate verdict for ${id}`);
    if (v.verdict !== "allow" && v.verdict !== "drop" && v.verdict !== "quarantine") {
      throw new MalformedReviewError(`bad verdict for ${id}`);
    }
    const confidence = v.confidence;
    if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
      throw new MalformedReviewError(`bad confidence for ${id}`);
    }
    const category = (VERDICT_CATEGORIES as readonly string[]).includes(v.category as string)
      ? (v.category as string)
      : "other";
    const rationale = typeof v.rationale === "string" ? v.rationale.slice(0, MAX_RATIONALE) : "";
    result[id] = { verdict: v.verdict, category, confidence, rationale };
  }
  const missing = expectedIds.filter((id) => !Object.hasOwn(result, id));
  if (missing.length) throw new MalformedReviewError(`${missing.length} entries without a verdict`);
  return result;
}
