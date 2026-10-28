import {
  compileRule,
  type DistillInput,
  parseProposals,
  type ReviewOutcome,
  type RuleProposer,
} from "@gleator/lazaret";

// A scripted stand-in for the distiller (AnthropicRuleProposer), for the fake Memory
// eval: free, deterministic and CI-checked. It is the scripted reviewer's partner
// (apps/demo-lazaret/src/scripted-reviewer.ts): that one drops on a keyword list, this
// one turns those drops back into gate rules from the same list.
//
// So the fake run measures the Memory's *plumbing*: archive → distill → backtest →
// shadow → flag → block → caught at the edge, across a real train / held-out split. It
// does not measure how well a model generalises from drops; that is what the live run
// (real Sonnet proposer) is for. Don't quote fake numbers as learning quality.
//
// Why the catalogue mirrors the scripted reviewer exactly: in the fake world that
// keyword list *is* the ground truth the Memory learns from. The first fake run used a
// broader XSS rule (also `onload=`), and the backtest rejected it for matching three
// archived "allows", which were attacks the scripted reviewer had missed (xss-03,
// rpi-06). That is the Memory working as designed (the archive's labels are the
// reviewer's), but it made the fake run about the keyword list rather than the loop.
//
// It still behaves like a careful distiller rather than a rule dispenser:
//   - it proposes only for categories it was shown 2+ drops of, and only rules that
//     match 2+ of those drops and none of the clean requests it was shown: the checks
//     DISTILL_SYSTEM_PROMPT asks the model to make. Proposing on a single drop is worse
//     than useless here: the Memory rejects a rule with support < minSupport and
//     remembers its fingerprint, so the same rule can never be proposed again, even
//     after the second matching drop arrives (seen in the first fake run);
//   - it skips categories an existing pending or active rule already covers;
//   - output goes through the library's own `parseProposals`, in PROPOSAL_SCHEMA's shape
//     (string values, `ci` on every condition), exactly as a model's output would.
// The Memory then backtests against the whole archive regardless, as it does in live.

type RawCondition = { field: string; op: string; value: string; ci: boolean };
type RawProposal = { description: string; category: string; conditions: RawCondition[] };

const MIN_SHOWN = 2;

/**
 * One rule per scripted-reviewer category, in the rule DSL (gate/rules.ts), written
 * against the canonicalised request (lowercased, URL- and HTML-decoded). Regexes avoid
 * quantified groups with alternation, which `compileSafeRegex` rejects as ReDoS shapes.
 */
const CATALOGUE: Record<string, RawProposal> = {
  xss: {
    description:
      "Blocks writes whose body carries a script tag, an onerror handler or a javascript: URL.",
    category: "xss",
    conditions: [{ field: "body", op: "matches", value: "<script|onerror=|javascript:", ci: true }],
  },
  sqli: {
    description:
      "Blocks writes whose body carries a UNION SELECT, the ' or '1'='1 tautology, or a stacked DROP TABLE.",
    category: "sqli",
    conditions: [
      {
        field: "body",
        op: "matches",
        value: "\\bunion\\b.+\\bselect\\b|' or '1'='1|;\\s*drop\\s+table",
        ci: true,
      },
    ],
  },
  prompt_injection: {
    description:
      "Blocks writes that tell an AI reader to ignore its previous instructions or rules.",
    category: "prompt_injection",
    conditions: [
      {
        field: "body",
        op: "matches",
        value: "ignore (all |your |any )?(previous |prior )?(instructions|rules)",
        ci: true,
      },
    ],
  },
  mass_assignment: {
    description: "Blocks profile updates that try to set the account's role to admin.",
    category: "mass_assignment",
    conditions: [
      { field: "path", op: "eq", value: "/api/me", ci: false },
      { field: "json:role", op: "eq", value: "admin", ci: true },
    ],
  },
  fraud: {
    description:
      "Blocks account credits of $100 or more, which no support policy issues in one go.",
    category: "fraud",
    conditions: [
      { field: "path", op: "matches", value: "^/api/accounts/[^/]+/credits$", ci: false },
      { field: "json:amount_cents", op: "gte", value: "10000", ci: false },
    ],
  },
};

export const scriptedProposer: RuleProposer = {
  async propose(input: DistillInput): Promise<ReviewOutcome> {
    const covered = new Set(input.existing.map((r) => r.category));
    const categories = [...new Set(input.drops.map((d) => d.category))].sort();
    const proposals = categories
      .filter((c) => !covered.has(c))
      .flatMap((c) => {
        const candidate = CATALOGUE[c];
        return candidate && fits(candidate, input) ? [candidate] : [];
      });
    // Same cap as the prompt asks of the model ("between zero and three rules").
    return { kind: "output", model: "scripted", output: { proposals: proposals.slice(0, 3) } };
  },
};

/** The distiller's own sanity check: explains 2+ shown drops, spares every shown clean request. */
function fits(raw: RawProposal, input: DistillInput): boolean {
  const [parsed] = parseProposals({ proposals: [raw] });
  if (!parsed) return false;
  const { test } = compileRule({ id: "candidate", action: "block", when: parsed.when });
  const support = input.drops.filter((d) => d.category === raw.category && test(d.sample)).length;
  return support >= MIN_SHOWN && !input.allows.some((a) => test(a.sample));
}
