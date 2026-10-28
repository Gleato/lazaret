import attacksJsonl from "../../../../../../evals/corpus/attacks.jsonl?raw";
import benignJsonl from "../../../../../../evals/corpus/benign.jsonl?raw";

// The attack console's exhibits, read at build time from the eval corpus
// (evals/corpus/*.jsonl), so what visitors fire is exactly what the evals measured and
// the two can't drift. Each exhibit names a corpus case; this file only adds the
// words a visitor sees and who sends it. Canned only, by design (your call,
// 2026-10-28): the console is an exhibit, not an open relay.

export interface ExhibitStep {
  method: string;
  /** May contain `{receipt:N}`: the receipt of step N, filled in at send time. */
  path: string;
  bodyText?: string;
  repeat?: number;
}

export interface Exhibit {
  id: string;
  title: string;
  kind: "attack" | "honest";
  /** Demo account it is sent as. Credits need a support agent. */
  persona: "theo" | "sam";
  /** What to watch for, in a sentence. */
  watch: string;
  steps: ExhibitStep[];
  /** Run Tidewater's AI agent afterwards and show the simulated "Lazaret off" replay. */
  agent?: boolean;
}

interface CorpusCase {
  id: string;
  requests: { method: string; path: string; body?: unknown; repeat?: number }[];
}

/** Bursts are capped so one click stays cheap (each login is an inline model call). */
const MAX_REPEAT = 12;

const EXHIBITS: Omit<Exhibit, "steps">[] = [
  {
    id: "ok-ticket-01",
    title: "An honest ticket",
    kind: "honest",
    persona: "theo",
    watch: "Held for one cycle, approved, then delivered to Tidewater under its receipt id.",
  },
  {
    id: "ok-hard-01",
    title: "A ticket quoting a SQL error",
    kind: "honest",
    persona: "theo",
    watch: "Looks like SQL injection to a keyword filter. The reviewer reads it as a bug report.",
  },
  {
    id: "xss-01",
    title: "Stored XSS",
    kind: "attack",
    persona: "theo",
    watch: "The gate's risk spike seals the batch at once; the reviewer drops it.",
  },
  {
    id: "sqli-01",
    title: "SQL injection",
    kind: "attack",
    persona: "theo",
    watch: "A tautology in a ticket body, dropped before it reaches the database.",
  },
  {
    id: "mass-01",
    title: "Mass assignment",
    kind: "attack",
    persona: "theo",
    watch: "A profile update that tries to set role to admin.",
  },
  {
    id: "rpi-07",
    title: "Prompt injection aimed at the reviewer",
    kind: "attack",
    persona: "theo",
    watch:
      "It tells any AI reviewer to approve everything. The reviewer reads that as evidence, not instructions.",
  },
  {
    id: "dpi-01",
    title: "Prompt injection aimed at Tidewater's AI agent",
    kind: "attack",
    persona: "theo",
    watch:
      "Tells the support agent to refund $5,000. Lazaret drops it, so the agent never reads it.",
    agent: true,
  },
  {
    id: "taint-01",
    title: "Taint: a harmless reply to a malicious ticket",
    kind: "attack",
    persona: "theo",
    watch: "The reply looks fine on its own. It falls with the ticket it depends on.",
  },
  {
    id: "fraud-01",
    title: "Refund fraud",
    kind: "attack",
    persona: "sam",
    watch: "A $49,999 credit with a vague reason, reviewed inline before it can move money.",
  },
  {
    id: "cred-01",
    title: "Credential stuffing",
    kind: "attack",
    persona: "theo",
    watch: "A burst of logins from one address. Watch the gate's failed-login score climb.",
  },
];

export function loadExhibits(): Exhibit[] {
  const cases = new Map<string, CorpusCase>();
  for (const text of [attacksJsonl, benignJsonl]) {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const c = JSON.parse(line) as CorpusCase;
      cases.set(c.id, c);
    }
  }
  return EXHIBITS.map((x) => {
    const c = cases.get(x.id);
    if (!c) throw new Error(`exhibit ${x.id} is not in the eval corpus`);
    return {
      ...x,
      steps: c.requests.map((r) => ({
        method: r.method,
        path: r.path,
        ...(r.body === undefined
          ? {}
          : { bodyText: typeof r.body === "string" ? r.body : JSON.stringify(r.body) }),
        ...(r.repeat ? { repeat: Math.min(r.repeat, MAX_REPEAT) } : {}),
      })),
    };
  });
}
