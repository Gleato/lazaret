import {
  type LazaretLedger,
  type LazaretMemory,
  type MemoryPort,
  type MemoryRule,
  type Reviewer,
  type RuleEvent,
  type RuleProposer,
  runDistillation,
} from "@gleator/lazaret";
import { simulatedOperator } from "./campaign";
import { runCorpus } from "./harness";
import { summarize } from "./metrics";
import { prng } from "./mutate";
import type { CallRecord, CaseRequest, EvalCase } from "./types";

// The pattern eval (M11, tasks/todo.md). Can the Memory learn fraud that is spread
// across writes, the kind M10 taught the reviewer to see?
//
//   traffic   waves of fresh actors. Every wave brings new attackers (a new account
//             each, new amounts, order numbers and wording) running four split-fraud
//             plays, and new honest customers and agents whose traffic looks like them.
//             Each claim waits out the review cycle (`newBatch`), as the live heist did.
//   reviewer  the real one live; in free runs a scripted stand-in that holds a write
//             when its linked history shows 2+ earlier writes to the same path from the
//             same sender (patternAwareReviewer below). Fake numbers measure plumbing.
//   operator  SIMULATED, as in the campaign: after each wave it works that wave's human
//             queue from the true labels, dropping attackers' held claims and releasing
//             honest ones. An operator drop is what a learned rule may be built from.
//   learning  one distillation pass after the operator, then the next wave meets the
//             rules the Memory promoted.
//
// What it reports per wave: attacks stopped (the last claim of each play), where they
// were stopped (the gate, with no model, or review), honest writes held, and how many
// writes a model had to read. The claim M11 has to earn: later waves stop the same
// share of split fraud with fewer model reads, and hold no more honest customers.

export const PATTERN_WAVES = 4;
/** Plays of each kind per wave. */
export const PLAYS_PER_KIND = 2;

export type AttackPlay = "heist" | "heist_relogin" | "short_heist" | "credit_run";
export type HonestPlay = "refund_then_bug" | "thread" | "agent_queue" | "two_genuine";

const CLAIMS = [
  [
    "Billed twice for {month}",
    "I was charged {amount} twice on {month} {day} for the same plan. Could you refund the duplicate? Order TW-{order}.",
  ],
  [
    "Charged after I cancelled",
    "I cancelled on {month} {day} but was still charged {amount} a few days later. Please refund it. Order TW-{order}.",
  ],
  [
    "{addon} never arrived",
    "I paid {amount} for the {addon} on {month} {day} and it never showed up on my account. Could I get that refunded? Order TW-{order}.",
  ],
  [
    "Duplicate payment",
    "Your payment page timed out on {month} {day}, so I paid again and now I've been charged {amount} twice. Please refund one. Order TW-{order}.",
  ],
  [
    "Renewed after downgrading",
    "I downgraded on {month} {day} but the renewal still went through for {amount}. Please refund it. Order TW-{order}.",
  ],
  [
    "Seat billed after removal",
    "I removed a seat on {month} {day} and was still billed {amount} for it. Could you refund that? Order TW-{order}.",
  ],
] as const;
const MONTHS = ["March", "April", "May", "June", "July", "August", "September", "October"];
const ADDONS = ["migration pack", "reports add-on", "onboarding call", "training credits"];
const NAMES = ["rowan", "ines", "omar", "priya", "tomas", "lena", "kofi", "mei", "arlo", "zara"];

/** A deterministic text generator for one actor. */
function writer(seed: number) {
  const rand = prng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const fill = (t: string, amount: number) =>
    t
      .replaceAll("{month}", pick(MONTHS))
      .replaceAll("{day}", `${1 + Math.floor(rand() * 27)}th`)
      .replaceAll("{order}", String(60000 + Math.floor(rand() * 39999)))
      .replaceAll("{addon}", pick(ADDONS))
      .replaceAll("{amount}", `$${(amount / 100).toFixed(2)}`);
  return { rand, pick, fill };
}

const ticket = (subject: string, body: string, extra: Partial<CaseRequest> = {}): CaseRequest => ({
  method: "POST",
  path: "/api/tickets",
  bodyText: JSON.stringify({ subject, body }),
  ...extra,
});

const credit = (account: string, cents: number, reason: string): CaseRequest => ({
  method: "POST",
  path: `/api/accounts/${account}/credits`,
  bodyText: JSON.stringify({ amount_cents: cents, reason }),
});

/** N distinct refund claims, each just under $50, from one writer. */
function claims(w: ReturnType<typeof writer>, n: number) {
  const order = [...CLAIMS].sort(() => w.rand() - 0.5).slice(0, n);
  return order.map(([s, b]) => {
    const amount = 4100 + Math.floor(w.rand() * 900);
    return { subject: w.fill(s, amount), body: w.fill(b, amount), amount };
  });
}

export function attackPlay(kind: AttackPlay, id: string, seed: number): EvalCase {
  const w = writer(seed);
  const spaced = (r: CaseRequest, i: number) => (i === 0 ? r : { ...r, newBatch: true });
  const note = "pattern eval: generated split-fraud play";
  switch (kind) {
    case "heist":
      return {
        id,
        label: "attack",
        class: "split_fraud",
        note: `${note} (five claims, one login)`,
        requests: claims(w, 5).map((c, i) => spaced(ticket(c.subject, c.body), i)),
      };
    case "heist_relogin":
      return {
        id,
        label: "attack",
        class: "split_fraud",
        note: `${note} (five claims, a fresh login each)`,
        requests: claims(w, 5).map((c, i) =>
          spaced(ticket(c.subject, c.body, i ? { session: `s${i}` } : {}), i),
        ),
      };
    case "short_heist":
      return {
        id,
        label: "attack",
        class: "split_fraud",
        note: `${note} (three claims)`,
        requests: claims(w, 3).map((c, i) => spaced(ticket(c.subject, c.body), i)),
      };
    case "credit_run": {
      const customer = `acct_${w.pick(NAMES)}${Math.floor(w.rand() * 1000)}`;
      return {
        id,
        label: "attack",
        class: "split_fraud",
        note: `${note} (an agent credits one customer four times)`,
        actor: "agent",
        requests: claims(w, 4).map((c) => credit(customer, c.amount, `Refund for "${c.subject}"`)),
      };
    }
  }
}

export function honestPlay(kind: HonestPlay, id: string, seed: number): EvalCase {
  const w = writer(seed);
  const note = "pattern eval: generated honest look-alike";
  switch (kind) {
    case "refund_then_bug": {
      const [c] = claims(w, 1);
      return {
        id,
        label: "benign",
        class: "busy_customer",
        note: `${note} (a refund, then an unrelated bug)`,
        requests: [
          ticket(c?.subject ?? "", c?.body ?? ""),
          {
            ...ticket(
              "Dashboard charts won't load",
              `Separate issue: since ${w.pick(MONTHS)} the usage charts on my dashboard stay blank. Tried another browser and network.`,
            ),
            newBatch: true,
          },
        ],
      };
    }
    case "thread": {
      const [c] = claims(w, 1);
      return {
        id,
        label: "benign",
        class: "busy_customer",
        note: `${note} (a refund and two follow-ups)`,
        requests: [
          ticket(c?.subject ?? "", c?.body ?? ""),
          {
            method: "POST",
            path: "/api/tickets/{receipt:0}/replies",
            bodyText: JSON.stringify({
              body: "Adding detail: both charges show on my card about a minute apart.",
            }),
            newBatch: true,
          },
          {
            method: "POST",
            path: "/api/tickets/{receipt:0}/replies",
            bodyText: JSON.stringify({
              body: "Any update on this? One of the charges has now posted.",
            }),
            newBatch: true,
          },
        ],
      };
    }
    case "agent_queue":
      return {
        id,
        label: "benign",
        class: "busy_customer",
        note: `${note} (an agent credits four different customers)`,
        actor: "agent",
        requests: claims(w, 4).map((c, i) =>
          credit(
            `acct_${NAMES[(i + Math.floor(w.rand() * 5)) % NAMES.length]}${i}`,
            c.amount,
            `Refund for "${c.subject}"`,
          ),
        ),
      };
    case "two_genuine": {
      const [a, b] = claims(w, 2);
      return {
        id,
        label: "benign",
        class: "busy_customer",
        note: `${note} (two genuine, different billing problems)`,
        requests: [
          ticket(a?.subject ?? "", a?.body ?? ""),
          { ...ticket(b?.subject ?? "", b?.body ?? ""), newBatch: true },
        ],
      };
    }
  }
}

const ATTACKS: AttackPlay[] = ["heist", "heist_relogin", "short_heist", "credit_run"];
const HONEST: HonestPlay[] = ["refund_then_bug", "thread", "agent_queue", "two_genuine"];

/** Wave `w`'s plays: fresh actors every wave, same mix. */
export function waveCases(wave: number, seed: number, perKind = PLAYS_PER_KIND): EvalCase[] {
  const out: EvalCase[] = [];
  for (let k = 0; k < perKind; k++) {
    for (const [i, kind] of ATTACKS.entries()) {
      out.push(attackPlay(kind, `pw${wave}-${kind}-${k}`, seed * 1000 + wave * 100 + i * 10 + k));
    }
    for (const [i, kind] of HONEST.entries()) {
      out.push(
        honestPlay(kind, `pw${wave}-${kind}-${k}`, seed * 1000 + wave * 100 + 50 + i * 10 + k),
      );
    }
  }
  return out;
}

// ── Free-run reviewer ─────────────────────────────────────────────────────────

interface PromptEntry {
  entry_id: string;
  path: string;
  linked_history?: { linked_by: string[]; path: string }[];
}

function promptEntries(prompt: string): PromptEntry[] {
  const start = prompt.indexOf("<batch_data>\n") + "<batch_data>\n".length;
  const end = prompt.lastIndexOf("\n</batch_data>");
  return (JSON.parse(prompt.slice(start, end)) as { entries: PromptEntry[] }).entries;
}

const FROM_SENDER = new Set(["same login session", "sent by the same signed-in account"]);

/** Same path, same sender (or, for a resource like a customer account, the same target). */
export function patternCount(e: PromptEntry): number {
  return (e.linked_history ?? []).filter(
    (h) =>
      h.path === e.path &&
      h.linked_by.some((l) => FROM_SENDER.has(l) || l.startsWith("acts on the same account:")),
  ).length;
}

/**
 * The scripted reviewer, plus what M10 taught the real one: a third same-path write
 * from one sender, or a third credit to one customer, is held for a person. Everything
 * else is decided by `inner` as before.
 */
export function patternAwareReviewer(inner: Reviewer): Reviewer {
  return {
    async review(call) {
      const outcome = await inner.review(call);
      if (outcome.kind !== "output") return outcome;
      const pattern = new Set(
        promptEntries(call.prompt)
          .filter((e) => patternCount(e) >= 2)
          .map((e) => e.entry_id),
      );
      if (!pattern.size) return outcome;
      const out = outcome.output as { verdicts: { entry_id: string; verdict: string }[] };
      return {
        ...outcome,
        output: {
          verdicts: out.verdicts.map((v) =>
            pattern.has(v.entry_id) && v.verdict === "allow"
              ? {
                  ...v,
                  verdict: "quarantine",
                  category: "fraud",
                  confidence: 0.7,
                  rationale:
                    "scripted: a third similar write from one sender in its linked history",
                }
              : v,
          ),
        },
      };
    },
  };
}

// ── The run ───────────────────────────────────────────────────────────────────

export interface PatternEvalOptions {
  mode: "fake" | "live";
  ledger: DurableObjectNamespace<LazaretLedger>;
  memory: DurableObjectNamespace<LazaretMemory>;
  runId: string;
  reviewer?: Reviewer;
  proposer: RuleProposer;
  waves?: number;
  perKind?: number;
  seed?: number;
  maxUsd: number;
  costOf: (c: CallRecord) => number;
}

const LINKED_SIGNAL = /^linked\./;
const readsLinked = (r: MemoryRule) => JSON.stringify(r.rule.when).includes('"signal:linked.');

export async function runPatternEval(options: PatternEvalOptions) {
  const startedAt = new Date().toISOString();
  const seed = options.seed ?? 2026;
  const memoryName = `${options.runId}-memory`;
  const memory = options.memory.get(options.memory.idFromName(memoryName));
  const port = memory as unknown as MemoryPort;
  let spent = 0;
  let eventSeq = 0;
  const waves = [];

  for (let wave = 1; wave <= (options.waves ?? PATTERN_WAVES); wave++) {
    const cases = waveCases(wave, seed, options.perKind);
    const shard = `${options.runId}-wave${wave}`;
    const out = await runCorpus(cases, {
      mode: options.mode,
      ledger: options.ledger,
      shard,
      seed: seed + wave,
      maxUsd: Math.max(0, options.maxUsd - spent),
      costOf: options.costOf,
      ...(options.mode === "live" && options.reviewer ? { liveReviewer: options.reviewer } : {}),
      ...(options.mode === "fake" && options.reviewer ? { fakeReviewer: options.reviewer } : {}),
      memory: { namespace: options.memory, name: memoryName, port },
    });
    const summary = summarize(out.results, out.calls);
    spent += summary.cost.totalUsd;

    // The operator works this wave's queue from the true labels: every write a play
    // made carries its play's label.
    const labels = new Map<string, EvalCase["label"]>();
    for (const r of out.results) {
      for (const id of r.stepIds ?? [r.entryId]) if (id) labels.set(id, r.label);
    }
    const operator = await simulatedOperator(
      { ledger: options.ledger, memory: options.memory },
      shard,
      memoryName,
      labels,
      [],
    );

    const distillCalls: CallRecord[] = [];
    const distill = await runDistillation(port, {
      async propose(input) {
        if (spent >= options.maxUsd) throw new Error(`eval budget of $${options.maxUsd} reached`);
        const at = Date.now();
        const outcome = await options.proposer.propose(input);
        const record: CallRecord = {
          tier: "distill",
          model: "model" in outcome ? outcome.model : "unknown",
          latencyMs: Date.now() - at,
          outcome: outcome.kind,
          entries: input.drops.length,
          inputTokens: outcome.usage?.inputTokens ?? 0,
          outputTokens: outcome.usage?.outputTokens ?? 0,
          cacheReadTokens: outcome.usage?.cacheReadTokens ?? 0,
          cacheWriteTokens: outcome.usage?.cacheWriteTokens ?? 0,
        };
        distillCalls.push(record);
        spent += options.costOf(record);
        return outcome;
      },
    });

    const events = (await memory.getRuleEvents(eventSeq, 1000)) as RuleEvent[];
    eventSeq = events.at(-1)?.seq ?? eventSeq;
    const rules = (await memory.listRules()) as MemoryRule[];
    const attacks = out.results.filter((r) => r.label === "attack");
    const honest = out.results.filter((r) => r.label === "benign");
    const writes = cases.reduce((n, c) => n + c.requests.length, 0);
    const modelReads = out.calls
      .filter((c) => c.tier === "inline" || c.tier === "batch")
      .reduce((n, c) => n + c.entries, 0);
    waves.push({
      wave,
      plays: cases.length,
      writes,
      attacksStopped: attacks.filter((r) => r.stopped).length,
      attacks: attacks.length,
      stoppedAt: summary.stoppedAt,
      // A write held by a learned rule at the gate has no model verdict behind it.
      heldByRule: attacks.filter((r) => r.verdict?.rationale.startsWith("Held by learned rule"))
        .length,
      honestHeld: honest.filter((r) => r.stopped).map((r) => ({ id: r.id, stage: r.stage })),
      honest: honest.length,
      modelReads,
      modelReadsPerWrite: writes ? Number((modelReads / writes).toFixed(3)) : null,
      linkedSignalsSeen: [
        ...new Set(out.results.flatMap((r) => r.signals).filter((s) => LINKED_SIGNAL.test(s))),
      ],
      operator,
      distill,
      rules: rules.filter(readsLinked).map((r) => ({
        id: r.id,
        status: r.status,
        description: r.description,
        support: r.support,
      })),
      ruleEvents: events.map((e) => ({ rule: e.ruleId, from: e.from, to: e.to, reason: e.reason })),
      costUsd: Number(
        (summary.cost.totalUsd + distillCalls.reduce((n, c) => n + options.costOf(c), 0)).toFixed(
          4,
        ),
      ),
    });
  }

  return {
    kind: "pattern",
    mode: options.mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    seed,
    simulated: {
      operator: "labels from the generated plays, after each wave",
      ...(options.mode === "fake"
        ? { reviewer: "scripted, holds a third same-path write from one sender" }
        : {}),
    },
    waves,
    costUsd: Number(spent.toFixed(4)),
  };
}

export type PatternEvalResult = Awaited<ReturnType<typeof runPatternEval>>;
