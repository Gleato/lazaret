import type { Reviewer, ReviewOutcome, VerdictRecord } from "../src";
import { verifyLazaretRequest } from "../src/origin";

export const SECRET = "test-signing-secret-0123456789";

export interface PromptEntry {
  entry_id: string;
  body: string | null;
  session: string;
  session_flagged: boolean;
  gate: { risk: number };
  first_pass?: { verdict: string };
}

/** Pull the entries back out of a reviewer prompt, as the model would see them. */
export function promptEntries(prompt: string): PromptEntry[] {
  const start = prompt.indexOf("<batch_data>\n") + "<batch_data>\n".length;
  const end = prompt.lastIndexOf("\n</batch_data>");
  return (JSON.parse(prompt.slice(start, end)) as { entries: PromptEntry[] }).entries;
}

export const verdict = (
  v: VerdictRecord["verdict"],
  confidence = 0.95,
  category?: string,
): VerdictRecord => ({
  verdict: v,
  category: category ?? (v === "allow" ? "benign" : "xss"),
  confidence,
  rationale: `test ${v}`,
});

/** A deterministic reviewer: `decide` maps each entry to a verdict. */
export function fakeReviewer(
  decide: (entry: PromptEntry, tier: string) => VerdictRecord,
  override?: (tier: string, call: number) => ReviewOutcome | Error | undefined,
) {
  const calls: { tier: string; prompt: string }[] = [];
  const reviewer: Reviewer = {
    async review({ tier, prompt }) {
      calls.push({ tier, prompt });
      const o = override?.(tier, calls.length);
      if (o instanceof Error) throw o;
      if (o) return o;
      return {
        kind: "output",
        model: "fake",
        output: {
          verdicts: promptEntries(prompt).map((e) => ({
            entry_id: e.entry_id,
            ...decide(e, tier),
          })),
        },
      };
    },
  };
  return { reviewer, calls };
}

/** Stand-in for the default rule: drop anything with markup or injection phrasing. */
export function looksMalicious(body: string | null): boolean {
  return /<script|ignore all previous/i.test(body ?? "");
}

/** A fake origin that, like a real one, refuses unsigned requests. */
export function fakeOrigin(status = 201) {
  const received: {
    id: string | null;
    url: string;
    method: string;
    verified: boolean;
    idempotencyKey: string | null;
    body: string;
  }[] = [];
  const fetchOrigin = async (request: Request) => {
    const check = await verifyLazaretRequest(request, SECRET);
    received.push({
      id: check.ok ? check.id : null,
      url: request.url,
      method: request.method,
      verified: check.ok,
      idempotencyKey: request.headers.get("idempotency-key"),
      body: await request.text(),
    });
    return new Response(null, { status: check.ok ? status : 401 });
  };
  return { fetchOrigin, received };
}
