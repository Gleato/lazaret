import {
  createGateway,
  defineLazaret,
  type LazaretLedger,
  type LazaretMemory,
  type MemoryPort,
  type MemoryRule,
  type Reviewer,
  type RuleEvent,
  type RuleProposer,
  runDistillation,
} from "@gleator/lazaret";
import { tidewaterConfig } from "@gleator/tidewater-lazaret/config";
import { runCorpus } from "./harness";
import { frozenNamespace, frozenPort } from "./memory-eval";
import { summarize } from "./metrics";
import { type Variant, variantOf } from "./mutate";
import { scriptedProposer } from "./proposer";
import { stableHash } from "./split";
import type { CallRecord, CaseResult, EvalCase } from "./types";
import { EVAL_MEMORY_THRESHOLDS } from "./worker";

// The campaign replay eval (M7.1 C): does the Memory make Lazaret cheaper as it learns,
// while recall and FPR hold? That is the claim a production team pays for, and the
// two-phase Memory eval (memory-eval.ts) couldn't show it: one example per trick, so no
// rule ever met its evidence bar.
//
//   traffic   a deterministic stream (mutate.ts): each attack family (one corpus case)
//             comes back as encoded, re-cased, split and moved variants, mixed into
//             benign traffic (also mutated) at ATTACK_SHARE. Same seed, same bytes.
//   replay    W windows, each one replayed through the real stack (harness.ts: real
//             gateway, gate, Ledger, review pipeline) against ONE Memory that keeps
//             learning: after each window, one distillation pass (as in memory-eval.ts,
//             for the same reason), and rules promote from live hits in later windows.
//             Each window is its own Ledger shard, like the demo's hourly shards.
//   operator  SIMULATED. A human queue nobody works is a silent drop, and disputes
//             (M7.1 B) only resolve with a human label. So a scripted operator works
//             both, OPERATOR_DELAY windows late, using the corpus labels, through the
//             real operator API (gateway/operator.ts). Its labels are ground truth the
//             live system would only get from a person; every output says so.
//   hold-out  Some attack families never appear in the stream. After each window, a
//             free gate-only probe (no model calls, rules frozen) sends fresh variants
//             of (a) held-out families and (b) training families, plus benign variants.
//             (b) going up shows it learned the payloads it saw, in any encoding; (a)
//             going up shows it learned the *class*, not just the payload.
//
// Left out of the stream: credential bursts (behaviour scoring, not payloads), taint
// chains (multi-step), and reads (not writes). They test other mechanisms.

export const WINDOWS = 6;
export const CASES_PER_WINDOW = 50;
/** Attacks as a share of writes. A campaign in progress, not a quiet day: see README. */
export const ATTACK_SHARE = 0.3;
/** The simulated operator works the queue and disputes this many windows late. */
export const OPERATOR_DELAY = 1;
/** Held-out share of attack families, per class with at least 3 families. */
export const HOLDOUT_FRACTION = 1 / 3;
const PROBE_VARIANTS = { heldOut: 4, train: 2, benign: 2 } as const;
/** Probe variants are numbered from here, so the stream never sends one. */
const PROBE_BASE = 1000;

// split_fraud and busy_customer (M10) are patterns across writes. The campaign mutates
// single writes and learns single-write rules, which can't express them yet.
const EXCLUDED_CLASSES = new Set([
  "credential_attack",
  "taint",
  "read",
  "split_fraud",
  "busy_customer",
]);
const OPERATOR_TOKEN = "campaign-simulated-operator-token";

export interface CampaignOptions {
  mode: "fake" | "live";
  corpus: EvalCase[];
  ledger: DurableObjectNamespace<LazaretLedger>;
  memory: DurableObjectNamespace<LazaretMemory>;
  runId: string;
  seed?: number;
  windows?: number;
  casesPerWindow?: number;
  liveReviewer?: Reviewer;
  liveProposer?: RuleProposer;
  /** Fake mode: the reviewer to use (the decoded-view ablation passes a raw-only one). */
  fakeReviewer?: Reviewer;
  /**
   * false: the counterfactual arm. Same stream, same reviewer, but the Memory never
   * learns (no rules, no distillation), so each window shows what it would have cost
   * and caught without learning. Offline only; live it would double the spend.
   */
  learning?: boolean;
  maxUsd: number;
  costOf: (c: CallRecord) => number;
}

/** Which attack families train and which are held out. Stable: by hash within each class. */
export function campaignFamilies(corpus: EvalCase[]) {
  const usable = corpus.filter(
    (c) => !EXCLUDED_CLASSES.has(c.class) && c.requests.at(-1)?.method !== "GET",
  );
  const byHash = (a: EvalCase, b: EvalCase) =>
    stableHash(a.id) - stableHash(b.id) || (a.id < b.id ? -1 : 1);
  const attacks = usable.filter((c) => c.label === "attack").sort(byHash);
  const classes = new Map<string, EvalCase[]>();
  for (const c of attacks) classes.set(c.class, [...(classes.get(c.class) ?? []), c]);
  const heldOut = new Set<string>();
  for (const cases of classes.values()) {
    if (cases.length < 3) continue; // nothing to generalise from, or to
    for (const c of cases.slice(0, Math.round(cases.length * HOLDOUT_FRACTION))) heldOut.add(c.id);
  }
  return {
    train: attacks.filter((c) => !heldOut.has(c.id)),
    heldOut: attacks.filter((c) => heldOut.has(c.id)),
    benign: usable.filter((c) => c.label === "benign").sort(byHash),
  };
}

/**
 * Slots per class for one window: at least one each, the rest to the classes with the
 * most families. The same every window, so windows are comparable: a later window
 * differs from an earlier one in what the Memory knows and which variants arrive, not
 * in its mix of attack classes. (Dealing families round-robin across all classes made
 * the per-window numbers swing with the mix, which hid the trend.)
 */
export function classQuotas(pool: EvalCase[], total: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of pool) counts.set(c.class, (counts.get(c.class) ?? 0) + 1);
  const classes = [...counts.keys()].sort(
    (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || (a < b ? -1 : 1),
  );
  const quotas = new Map(classes.map((c) => [c, 0]));
  for (let i = 0; i < total; i++) {
    // Largest share of families per slot so far gets the next slot.
    const next = classes.reduce((best, c) =>
      (counts.get(c) ?? 0) / ((quotas.get(c) ?? 0) + 1) >
      (counts.get(best) ?? 0) / ((quotas.get(best) ?? 0) + 1)
        ? c
        : best,
    );
    const empty = classes.find((c) => quotas.get(c) === 0);
    const pick = empty ?? next;
    quotas.set(pick, (quotas.get(pick) ?? 0) + 1);
  }
  return quotas;
}

/**
 * Window `w`'s cases. Each class gets its fixed quota of slots (classQuotas); within a
 * class, families take turns, and each new turn of a family sends its next variant.
 */
export function windowCases(
  families: ReturnType<typeof campaignFamilies>,
  w: number,
  size: number,
  seed: number,
): Variant[] {
  const attacks = Math.round(size * ATTACK_SHARE);
  const deal = (pool: EvalCase[], total: number) =>
    [...classQuotas(pool, total)].flatMap(([cls, q]) => {
      const inClass = pool.filter((c) => c.class === cls);
      return Array.from({ length: q }, (_, i) => {
        const k = w * q + i;
        return variantOf(
          inClass[k % inClass.length] as EvalCase,
          Math.floor(k / inClass.length),
          seed,
        );
      });
    });
  return [...deal(families.train, attacks), ...deal(families.benign, size - attacks)];
}

const writesIn = (cases: EvalCase[]) =>
  cases.reduce((n, c) => n + c.requests.reduce((m, r) => m + (r.repeat ?? 1), 0), 0);

const per1k = (n: number, writes: number) =>
  writes ? Number(((n / writes) * 1000).toFixed(2)) : null;

/** Gate-only recall/FPR of a probe set, against a frozen copy of the active rules. */
async function probe(
  options: CampaignOptions,
  rules: Awaited<ReturnType<LazaretMemory["getActiveRules"]>>,
  cases: EvalCase[],
  shard: string,
) {
  const out = await runCorpus(cases, {
    mode: "gate-only",
    ledger: options.ledger,
    shard,
    memory: {
      namespace: frozenNamespace(rules),
      name: shard,
      port: frozenPort(async () => []),
    },
  });
  const atGate = (rs: CaseResult[]) => rs.filter((r) => r.stage === "gate").length;
  const attacks = out.results.filter((r) => r.label === "attack");
  const benign = out.results.filter((r) => r.label === "benign");
  return {
    attacks: attacks.length,
    stoppedAtGate: atGate(attacks),
    gateRecall: attacks.length ? Number((atGate(attacks) / attacks.length).toFixed(4)) : null,
    benign: benign.length,
    benignStoppedAtGate: atGate(benign),
    // Named, not just counted: a benign write stopped at the gate has no model behind it.
    benignStoppedIds: benign.filter((r) => r.stage === "gate").map((r) => r.id),
    benignStoppedSignals: benign.filter((r) => r.stage === "gate").map((r) => r.signals),
  };
}

/**
 * The simulated operator: works the human queue of an earlier window's shard, and every
 * open dispute, through the real operator API, labelling from the corpus. Returns what
 * it did, so the report can say how much ground truth came from "a human".
 */
async function simulatedOperator(
  options: CampaignOptions,
  shard: string,
  memoryName: string,
  labels: Map<string, EvalCase["label"]>,
  disputeIds: string[],
) {
  const config = defineLazaret(
    tidewaterConfig({
      ledger: { binding: "EVAL_LEDGER", shard },
      memory: { binding: "EVAL_MEMORY", name: memoryName },
    }),
  );
  const gateway = createGateway(config, {
    fetchOrigin: async () => Response.json({ ok: true }, { status: 201 }),
  });
  const env = {
    EVAL_LEDGER: options.ledger,
    EVAL_MEMORY: options.memory,
    LAZARET_SIGNING_SECRET: "eval-signing-secret-0123456789",
    LAZARET_OPERATOR_TOKEN: OPERATOR_TOKEN,
  };
  const background: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void background.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const call = (path: string, body?: unknown) =>
    gateway.fetch(
      new Request(`https://support.tidewater.test/__lazaret/operator/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${OPERATOR_TOKEN}`,
          "x-lazaret-operator": "simulated",
          "content-type": "application/json",
        },
        body: body === undefined ? null : JSON.stringify(body),
      }),
      env,
      ctx,
    );
  const done = { released: 0, dropped: 0, disputesAttack: 0, disputesBenign: 0, unknown: 0 };
  const { entries } = (await (await call("queue")).json()) as { entries: { id: string }[] };
  for (const e of entries) {
    const label = labels.get(e.id);
    if (!label) {
      done.unknown += 1;
      continue;
    }
    await call(`entries/${e.id}`, {
      action: label === "attack" ? "drop" : "release",
      note: "simulated operator (corpus label)",
    });
    label === "attack" ? done.dropped++ : done.released++;
  }
  for (const id of disputeIds) {
    const label = labels.get(id);
    if (!label) {
      done.unknown += 1;
      continue;
    }
    await call(`disputes/${id}`, { label, note: "simulated operator (corpus label)" });
    label === "attack" ? done.disputesAttack++ : done.disputesBenign++;
  }
  await Promise.allSettled(background);
  return done;
}

export async function runCampaign(options: CampaignOptions) {
  const startedAt = new Date().toISOString();
  const seed = options.seed ?? 2026;
  const windows = options.windows ?? WINDOWS;
  const size = options.casesPerWindow ?? CASES_PER_WINDOW;
  const families = campaignFamilies(options.corpus);
  const proposer = options.mode === "live" ? options.liveProposer : scriptedProposer;
  if (!proposer) throw new Error("live mode needs a rule proposer");

  const memoryName = `${options.runId}-memory`;
  const memory = options.memory.get(options.memory.idFromName(memoryName));
  const learning = options.learning ?? true;
  // The counterfactual arm reads an empty, frozen Memory and never distils.
  const port = learning ? (memory as unknown as MemoryPort) : frozenPort(async () => []);
  const gateMemory = learning ? options.memory : frozenNamespace([]);
  let spent = 0;

  const probes = {
    heldOut: families.heldOut.flatMap((c) =>
      Array.from({ length: PROBE_VARIANTS.heldOut }, (_, i) => variantOf(c, PROBE_BASE + i, seed)),
    ),
    train: families.train.flatMap((c) =>
      Array.from({ length: PROBE_VARIANTS.train }, (_, i) => variantOf(c, PROBE_BASE + i, seed)),
    ),
    benign: families.benign.flatMap((c) =>
      Array.from({ length: PROBE_VARIANTS.benign }, (_, i) => variantOf(c, PROBE_BASE + i, seed)),
    ),
  };
  const probeAll = async (tag: string) => {
    const rules = await memory.getActiveRules();
    const [heldOut, train, benign] = await Promise.all([
      probe(options, rules, probes.heldOut, `${options.runId}-probe-${tag}-h`),
      probe(options, rules, probes.train, `${options.runId}-probe-${tag}-t`),
      probe(options, rules, probes.benign, `${options.runId}-probe-${tag}-b`),
    ]);
    return {
      heldOutGateRecall: heldOut.gateRecall,
      trainGateRecall: train.gateRecall,
      benignStoppedAtGate: benign.benignStoppedAtGate,
      benignStoppedIds: benign.benignStoppedIds,
      benignStoppedSignals: benign.benignStoppedSignals,
      benignProbed: benign.benign,
    };
  };

  const labels = new Map<string, EvalCase["label"]>();
  const pendingWork: { shard: string; disputes: string[] }[] = [];
  const rows = [];
  const baseline = await probeAll("w0");
  let eventSeq = 0;

  for (let w = 0; w < windows; w++) {
    const cases = windowCases(families, w, size, seed);
    const shard = `${options.runId}-w${w + 1}`;
    const out = await runCorpus(cases, {
      mode: options.mode,
      ledger: options.ledger,
      shard,
      seed: seed + w,
      maxUsd: Math.max(0, options.maxUsd - spent),
      costOf: options.costOf,
      ...(options.liveReviewer ? { liveReviewer: options.liveReviewer } : {}),
      ...(options.fakeReviewer ? { fakeReviewer: options.fakeReviewer } : {}),
      memory: { namespace: gateMemory, name: memoryName, port },
    });
    for (const r of out.results) if (r.entryId) labels.set(r.entryId, r.label);
    const summary = summarize(out.results, out.calls);
    spent += summary.cost.totalUsd;

    // One distillation pass per window, metered against the same cap.
    const distillCalls: CallRecord[] = [];
    const metered: RuleProposer = {
      async propose(input) {
        if (spent >= options.maxUsd) throw new Error(`eval budget of $${options.maxUsd} reached`);
        const at = Date.now();
        const outcome = await proposer.propose(input);
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
    };
    const distill = learning
      ? await runDistillation(port, metered)
      : ({ ran: false, reason: "counterfactual arm: no learning" } as const);

    // The simulated operator works what was waiting OPERATOR_DELAY windows ago.
    pendingWork.push({
      shard,
      disputes: ((await memory.getDisputes(200)) as { entryId: string }[]).map((d) => d.entryId),
    });
    const due = w >= OPERATOR_DELAY ? pendingWork[w - OPERATOR_DELAY] : undefined;
    const operator =
      due && learning
        ? await simulatedOperator(options, due.shard, memoryName, labels, due.disputes)
        : null;

    const events = (await memory.getRuleEvents(eventSeq, 1000)) as RuleEvent[];
    eventSeq = events.at(-1)?.seq ?? eventSeq;
    const writes = writesIn(cases);
    const stops = summary.overall.tp + summary.overall.fp;
    const gateStops = summary.stoppedAt.gate ?? 0;
    const calls = out.calls.length + distillCalls.length;
    // Writes a model read (an inline call reads one; a batch call reads its entries).
    // Steadier than calls, whose count also depends on how batches happened to seal.
    const reviews = out.calls
      .filter((c) => c.tier === "inline" || c.tier === "batch")
      .reduce((n, c) => n + c.entries, 0);
    const usd = summary.cost.totalUsd + distillCalls.reduce((n, c) => n + options.costOf(c), 0);
    rows.push({
      window: w + 1,
      cases: cases.length,
      writes,
      attacks: summary.overall.tp + summary.overall.fn,
      benign: summary.overall.fp + summary.overall.tn,
      recall: summary.overall.recall,
      falsePositiveRate: summary.overall.falsePositiveRate,
      stops,
      gateStops,
      gateShareOfStops: stops ? Number((gateStops / stops).toFixed(4)) : null,
      modelCalls: calls,
      modelCallsPer1k: per1k(calls, writes),
      modelReviews: reviews,
      modelReviewsPer1k: per1k(reviews, writes),
      // Every miss and false positive with what decided it, so a live run can be
      // audited without re-running it (the first live campaign kept only ids).
      errors: out.results
        .filter((x) => (x.label === "attack") !== x.stopped)
        .map((x) => ({
          id: x.id,
          label: x.label,
          stage: x.stage,
          signals: x.signals,
          verdict: x.verdict,
        })),
      falsePositiveIds: out.results
        .filter((x) => x.label === "benign" && x.stopped)
        .map((x) => ({ id: x.id, stage: x.stage })),
      callsByTier: Object.fromEntries(
        Object.entries(summary.calls).map(([tier, c]) => [tier, (c as { calls: number }).calls]),
      ),
      usd: Number(usd.toFixed(4)),
      usdPer1k: writes ? Number(((usd / writes) * 1000).toFixed(4)) : null,
      stoppedAt: summary.stoppedAt,
      distill: distill.ran
        ? { ran: true, proposed: distill.proposed, created: distill.created.length }
        : { ran: false, reason: distill.reason },
      ruleEvents: events.map((e) => ({
        ruleId: e.ruleId,
        from: e.from,
        to: e.to,
        reason: e.reason,
      })),
      promotions: {
        shadow: events.filter((e) => e.to === "shadow").length,
        flag: events.filter((e) => e.to === "flag").length,
        block: events.filter((e) => e.to === "block").length,
        retired: events.filter((e) => e.to === "retired").length,
        rejected: events.filter((e) => e.to === "rejected").length,
        pending: events.filter((e) => e.to === "pending").length,
      },
      activeRules: (await memory.getStats()).rules,
      simulatedOperator: operator,
      probe: await probeAll(`w${w + 1}`),
    });
  }

  const rules = (await memory.listRules()) as MemoryRule[];
  const first = rows[0];
  const last = rows.at(-1);
  return {
    kind: "campaign" as const,
    mode: options.mode,
    learning,
    startedAt,
    finishedAt: new Date().toISOString(),
    headline:
      first && last
        ? `Over ${windows} windows of ${size} cases, model calls per 1k writes went ` +
          `${first.modelCallsPer1k} → ${last.modelCallsPer1k} and the gate's share of stops ` +
          `${first.gateShareOfStops} → ${last.gateShareOfStops}, with recall ` +
          `${first.recall} → ${last.recall} and FPR ${first.falsePositiveRate} → ` +
          `${last.falsePositiveRate}. Held-out families at the gate: ` +
          `${baseline.heldOutGateRecall} → ${last.probe.heldOutGateRecall}.`
        : "no windows run",
    simulated: {
      operator:
        "Human queue and disputes resolved by a scripted operator from the corpus labels, " +
        `${OPERATOR_DELAY} window(s) late, through the real operator API. Not a person.`,
      traffic:
        "Deterministic mutations of corpus cases (mutate.ts), not captured production traffic.",
    },
    config: {
      seed,
      windows,
      casesPerWindow: size,
      attackShare: ATTACK_SHARE,
      operatorDelayWindows: OPERATOR_DELAY,
      holdoutFraction: HOLDOUT_FRACTION,
      probeVariants: PROBE_VARIANTS,
      thresholds: EVAL_MEMORY_THRESHOLDS,
    },
    families: {
      train: families.train.map((c) => c.id),
      heldOut: families.heldOut.map((c) => c.id),
      benign: families.benign.length,
    },
    baselineProbe: baseline,
    windows: rows,
    rules: rules.map((r) => ({
      id: r.id,
      status: r.status,
      category: r.category,
      description: r.description,
      when: r.rule.when,
      support: r.support,
      liveTruePositives: r.liveTruePositives,
      liveFalsePositives: r.liveFalsePositives,
      reason: r.reason,
    })),
    cost: { totalUsd: Number(spent.toFixed(4)) },
  };
}

export type CampaignResult = Awaited<ReturnType<typeof runCampaign>>;
