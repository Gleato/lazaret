import type { Reviewer, VerdictRecord } from "@gleator/lazaret";

// A scripted reviewer that stands in for Claude, for tests and for offline local
// development (dev/worker.ts). It drops what an obviously competent reviewer would
// and allows the rest, so it exercises Lazaret's plumbing, not model judgment
// (measuring judgment is what evals/ is for). Never deploy it: it is a keyword list.
const ATTACK = [
  { re: /<script|onerror=|javascript:/i, category: "xss" },
  { re: /\bunion\b.+\bselect\b|' or '1'='1|;\s*drop\s+table/i, category: "sqli" },
  {
    re: /ignore (all |your |any )*(previous |prior )?(instructions|rules)/i,
    category: "prompt_injection",
  },
  { re: /"role"\s*:\s*"admin"/i, category: "mass_assignment" },
  { re: /"amount_cents"\s*:\s*\d{5,}/, category: "fraud" },
] as const;

export function scriptedVerdict(body: string | null): VerdictRecord {
  const hit = ATTACK.find((a) => a.re.test(body ?? ""));
  return hit
    ? {
        verdict: "drop",
        category: hit.category,
        confidence: 0.97,
        rationale: `scripted ${hit.category}`,
      }
    : { verdict: "allow", category: "benign", confidence: 0.95, rationale: "scripted allow" };
}

/** Every call the scripted reviewer has answered, by tier (tests assert on it). */
export const calls: { tier: string }[] = [];

export const scriptedReviewer: Reviewer = {
  async review({ tier, prompt }) {
    calls.push({ tier });
    const start = prompt.indexOf("<batch_data>\n") + "<batch_data>\n".length;
    const data = JSON.parse(prompt.slice(start, prompt.lastIndexOf("\n</batch_data>"))) as {
      entries: { entry_id: string; body: string | null }[];
    };
    return {
      kind: "output",
      model: "scripted",
      output: {
        verdicts: data.entries.map((e) => ({ entry_id: e.entry_id, ...scriptedVerdict(e.body) })),
      },
    };
  },
};
