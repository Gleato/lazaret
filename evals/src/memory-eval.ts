import {
  type ActiveRuleSpec,
  type DistillResult,
  type LazaretLedger,
  type LazaretMemory,
  type MemoryHint,
  type MemoryPort,
  type MemoryRule,
  type Reviewer,
  type RuleEvent,
  type RuleProposer,
  type RuleStatus,
  runDistillation,
} from "@gleator/lazaret";
import { type Mode, runCorpus } from "./harness";
import { type Summary, summarize } from "./metrics";
import { scriptedProposer } from "./proposer";
import { rounds, type Split, splitCorpus, stratumOf, TRAIN_FRACTION } from "./split";
import type { CallRecord, CaseResult, EvalCase } from "./types";
import { EVAL_MEMORY_THRESHOLDS } from "./worker";

// The two-phase Memory eval (M7 step E, decision-log #7): does what the Memory learns
// from some attacks stop *other* attacks at the edge, without stopping real customers?
//
//   phase 1  training split, in ROUNDS successive runs against one Memory. Batch review
//            archives verdicts (inline ones too, via the gateway); after each round, one
//            distillation pass turns the round's drops into candidate rules; rules then
//            earn promotion from hits on later rounds' traffic, which the reviewer judges
//            independently (it never sees memory hits).
//
// Distillation per round, not per batch (an eval choice). Production distils after
// every batch with drops (pipeline.ts), and batches there hold up to 50 writes. Here,
// risk-spike seals cut each ~24-case round into 3-7 small batches with 0-2 drops each,
// and a distillation pass marks every drop it was shown as used. So no pass ever saw
// two drops of one kind, nothing could reach minSupport, and the first fake runs learned
// nothing (measured: 0 proposals over 3 rounds). One pass per round shows the distiller
// what one production batch would. It calls the library's own `runDistillation`, the
// same function the pipeline's `memory-distill` step calls.
//   phase 2  held-out split, twice, identical in every way (same seed, same order, same
//            reviewer) except the Memory: cold (empty) vs warm (phase 1's). The headline
//            is the GATE-ONLY comparison, i.e. what was stopped before any model ran.
//
// In phase 2 the Memory is *frozen*: the gateway sees a snapshot of phase 1's active
// rules, and archiving is a no-op. Otherwise held-out traffic would keep promoting and
// retiring rules mid-run (and through the gateway's 60 s rule cache, at times that vary
// with model latency), so the warm arm would partly be scored on what it learned from
// the test itself. Reviewer context (past drop patterns per route) still comes from the
// warm Memory, because that is part of what a warm Memory gives the full pipeline.

export const ROUNDS = 3;

export interface MemoryEvalOptions {
  mode: Exclude<Mode, "gate-only">;
  corpus: EvalCase[];
  ledger: DurableObjectNamespace<LazaretLedger>;
  memory: DurableObjectNamespace<LazaretMemory>;
  /** Unique per run, so shards and Memory instances never carry state between runs. */
  runId: string;
  /** Live mode only. */
  liveReviewer?: Reviewer;
  liveProposer?: RuleProposer;
  maxUsd: number;
  costOf: (c: CallRecord) => number;
}

/** The held-out arms see the Memory through this: fixed rules, no writes. */
function frozenNamespace(rules: ActiveRuleSpec[]): DurableObjectNamespace<LazaretMemory> {
  const stub = {
    getActiveRules: async () => rules,
    archive: async () => ({ archived: 0, transitions: [] }),
  };
  return {
    idFromName: (name: string) => name,
    get: () => stub,
  } as unknown as DurableObjectNamespace<LazaretMemory>;
}

function frozenPort(context: (routes: string[]) => Promise<MemoryHint[]>): MemoryPort {
  return {
    archive: () => ({ archived: 0, transitions: [] }),
    getReviewerContext: context,
    getDistillInput: () => ({ drops: [], allows: [], existing: [] }),
    submitCandidates: () => [],
    markDistilled: () => undefined,
  };
}

const MEMORY_SIGNAL = "memory.";

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

/** Calls and reviewed entries per tier: entries is what a block rule saves in batch review. */
function callLoad(calls: CallRecord[]) {
  const tiers: Record<string, { calls: number; entries: number }> = {};
  for (const c of calls) {
    const t = tiers[c.tier] ?? { calls: 0, entries: 0 };
    t.calls += 1;
    t.entries += c.entries;
    tiers[c.tier] = t;
  }
  return tiers;
}

/** The parts of a run summary the memory panel needs (the full per-case results ride alongside). */
function brief(s: Summary) {
  return {
    overall: s.overall,
    gateOnly: s.gateOnly,
    stoppedAt: s.stoppedAt,
    byAttackClass: s.byAttackClass,
    cost: s.cost,
  };
}

const delta = (a: number | null, b: number | null) =>
  a === null || b === null ? null : Number((b - a).toFixed(4));

export async function runMemoryEval(options: MemoryEvalOptions) {
  const startedAt = new Date().toISOString();
  const split: Split = splitCorpus(options.corpus);
  const proposer = options.mode === "live" ? options.liveProposer : scriptedProposer;
  if (!proposer) throw new Error("live mode needs a rule proposer");
  let spent = 0;
  const base = {
    mode: options.mode,
    ledger: options.ledger,
    costOf: options.costOf,
    ...(options.liveReviewer ? { liveReviewer: options.liveReviewer } : {}),
  };
  // One spend cap across all runs and distillation calls, not one cap each.
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
  const run = async (
    cases: EvalCase[],
    shard: string,
    extra: Partial<Parameters<typeof runCorpus>[1]>,
  ) => {
    const out = await runCorpus(cases, {
      ...base,
      ...extra,
      shard: `${options.runId}-${shard}`,
      maxUsd: Math.max(0, options.maxUsd - spent),
    });
    const summary = summarize(out.results, out.calls);
    spent += summary.cost.totalUsd;
    return { ...out, summary };
  };

  // ── Phase 1: learn from the training split ─────────────────────────────────────
  const warmName = `${options.runId}-warm`;
  const warm = options.memory.get(options.memory.idFromName(warmName));
  const trainRounds = rounds(split.train, ROUNDS);
  const training: {
    round: number;
    cases: number;
    batches: number;
    distill: DistillResult;
    rulesAfter: Record<string, number>;
    lastEventSeq: number;
  }[] = [];
  const trainResults: CaseResult[] = [];
  const trainCalls: CallRecord[] = [];
  for (const [i, cases] of trainRounds.entries()) {
    const out = await run(cases, `train-${i + 1}`, {
      memory: {
        namespace: options.memory,
        name: warmName,
        port: warm as unknown as MemoryPort,
      },
    });
    trainResults.push(...out.results);
    trainCalls.push(...out.calls);
    // Same as the pipeline's step, including its minimum of 2 unexplained drops.
    const distill = await runDistillation(warm as unknown as MemoryPort, metered);
    const events = (await warm.getRuleEvents(0, 1000)) as RuleEvent[];
    training.push({
      round: i + 1,
      cases: cases.length,
      batches: out.batches.length,
      // What the round's distillation pass did: proposed n, created which rules at which status.
      distill,
      rulesAfter: (await warm.getStats()).rules,
      lastEventSeq: events.at(-1)?.seq ?? 0,
    });
  }
  const rules = (await warm.listRules()) as MemoryRule[];
  const ruleEvents = (await warm.getRuleEvents(0, 1000)) as RuleEvent[];
  const archive = (await warm.getStats()).archived;
  const active = (await warm.getActiveRules()) as ActiveRuleSpec[];

  // ── Phase 2: held-out, cold vs warm ────────────────────────────────────────────
  const cold = await run(split.heldOut, "heldout-cold", {
    memory: {
      namespace: frozenNamespace([]),
      name: `${options.runId}-cold`,
      port: frozenPort(async () => []),
    },
  });
  const hot = await run(split.heldOut, "heldout-warm", {
    memory: {
      namespace: frozenNamespace(active),
      name: warmName,
      port: frozenPort(async (routes) => (await warm.getReviewerContext(routes)) as MemoryHint[]),
    },
  });

  // Which held-out cases a learned rule fired on (any mode; only `block` stops at the edge).
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const modeAtFreeze = new Map(active.map((r) => [r.id, r.mode]));
  const coldById = new Map(cold.results.map((r) => [r.id, r]));
  const learnedCatches = hot.results.flatMap((r) =>
    r.signals
      .filter((s) => s.startsWith(MEMORY_SIGNAL))
      .map((s) => {
        const ruleId = s.slice(MEMORY_SIGNAL.length);
        const rule = ruleById.get(ruleId);
        return {
          caseId: r.id,
          label: r.label,
          class: r.class,
          route: r.route,
          ruleId,
          ruleStatus: modeAtFreeze.get(ruleId) ?? null,
          ruleCategory: rule?.category ?? null,
          ruleDescription: rule?.description ?? null,
          warmStage: r.stage,
          coldStage: coldById.get(r.id)?.stage ?? null,
        };
      }),
  );
  // Model calls avoided: held-out writes a learned rule stopped at the edge that a model
  // would otherwise have judged. An inline write saves one whole call; an escrowed one
  // saves its slot in a batch review call (the batch still runs for its other entries).
  const edgeStops = hot.results.filter(
    (r) =>
      r.stage === "gate" &&
      coldById.get(r.id)?.stage !== "gate" &&
      r.signals.some((s) => modeAtFreeze.get(s.slice(MEMORY_SIGNAL.length)) === "block"),
  );
  const inlineStages = new Set(["inline", "inline_unavailable"]);
  const avoided = {
    writes: edgeStops.length,
    inlineCalls: edgeStops.filter((r) => inlineStages.has(coldById.get(r.id)?.stage ?? "")).length,
    escrowedEntries: edgeStops.filter((r) => !inlineStages.has(coldById.get(r.id)?.stage ?? ""))
      .length,
    // The measured load, so the saving can be checked against what was actually called.
    callsCold: callLoad(cold.calls),
    callsWarm: callLoad(hot.calls),
  };

  const statusOf = (s: RuleStatus) => ruleEvents.filter((e) => e.to === s).map((e) => e.ruleId);
  const gate = { cold: cold.summary.gateOnly, warm: hot.summary.gateOnly };
  const caught = new Set(edgeStops.filter((r) => r.label === "attack").map((r) => r.id));
  return {
    kind: "memory" as const,
    mode: options.mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    headline:
      `Warm Memory stopped ${caught.size} more held-out attack(s) at the gate than a cold one ` +
      `(gate recall ${gate.cold.recall} → ${gate.warm.recall}, gate FPR ` +
      `${gate.cold.falsePositiveRate} → ${gate.warm.falsePositiveRate}), from ` +
      `${active.filter((r) => r.mode === "block").length} learned block rule(s).`,
    split: {
      method: "FNV-1a hash of case id, ranked within each label:class stratum",
      trainFraction: TRAIN_FRACTION,
      rounds: ROUNDS,
      train: split.train.length,
      heldOut: split.heldOut.length,
      byStratum: Object.fromEntries(
        [...new Set(options.corpus.map(stratumOf))].sort().map((k) => [
          k,
          {
            train: split.train.filter((c) => stratumOf(c) === k).length,
            heldOut: split.heldOut.filter((c) => stratumOf(c) === k).length,
          },
        ]),
      ),
      heldOutIds: split.heldOut.map((c) => c.id),
    },
    thresholds: EVAL_MEMORY_THRESHOLDS,
    training: {
      rounds: training,
      distillation: "per-round",
      summary: brief(summarize(trainResults, [...trainCalls, ...distillCalls])),
      archive,
    },
    rules: rules.map((r) => ({
      id: r.id,
      status: r.status,
      category: r.category,
      description: r.description,
      when: r.rule.when,
      support: r.support,
      cleanSamples: r.cleanSamples,
      liveTruePositives: r.liveTruePositives,
      liveFalsePositives: r.liveFalsePositives,
      reason: r.reason,
    })),
    rulesByStatus: countBy(rules, (r) => r.status),
    promoted: { flag: statusOf("flag"), block: statusOf("block") },
    retired: statusOf("retired"),
    ruleEvents: ruleEvents.map((e) => ({
      ...e,
      // Which training round it happened in, which reads better on a timeline than ms.
      round: training.find((t) => e.seq <= t.lastEventSeq)?.round ?? null,
    })),
    heldOut: {
      cold: brief(cold.summary),
      warm: brief(hot.summary),
      delta: {
        gateRecall: delta(gate.cold.recall, gate.warm.recall),
        gateFalsePositiveRate: delta(gate.cold.falsePositiveRate, gate.warm.falsePositiveRate),
        recall: delta(cold.summary.overall.recall, hot.summary.overall.recall),
        falsePositiveRate: delta(
          cold.summary.overall.falsePositiveRate,
          hot.summary.overall.falsePositiveRate,
        ),
      },
    },
    learnedCatches,
    modelCallsAvoided: avoided,
    cost: {
      totalUsd: Number(spent.toFixed(4)),
      distillCalls: distillCalls.length,
      distillUsd: Number(distillCalls.reduce((n, c) => n + options.costOf(c), 0).toFixed(4)),
    },
    results: { cold: cold.results, warm: hot.results },
  };
}

export type MemoryEvalResult = Awaited<ReturnType<typeof runMemoryEval>>;
