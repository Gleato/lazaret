import type { EvalCase } from "./types";

// The train / held-out split for the Memory eval (M7 step E, decision-log #7).
//
// The point of the split is that the Memory never sees a held-out case before it is
// scored on it, so "warm beat cold" means it generalised from *other* attacks of the
// same kind, not that it memorised the test. Two properties make that trustworthy:
//   - Stable: membership comes from a hash of the case id alone, never from file
//     order or a random seed, so adding a case elsewhere never moves an existing one
//     and every run (fake or live, today or next month) splits identically.
//   - Stratified: the hash ranks cases *within* each class (attack class, or benign
//     kind), and each class gives ~60% to training. A plain hash over 120 cases could
//     put all 8 XSS cases on one side by chance; then the held-out side would have no
//     XSS for a learned XSS rule to catch, or no benign tickets to show its FPR on.
// A class with one case (ssrf, nosql_injection, ...) goes to training: there is nothing
// to generalise from one example to, so it can't test learning either way.

export const TRAIN_FRACTION = 0.6;

/** FNV-1a, 32 bit. Cheap, dependency-free and identical on Node and workerd. */
export function stableHash(input: string): number {
  let h = 0x811c9dc5;
  for (const c of input) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

/** The stratum a case is balanced within: "attack:xss", "benign:hard_negative", ... */
export const stratumOf = (c: Pick<EvalCase, "label" | "class">) => `${c.label}:${c.class}`;

/** Hash order with the id as tie-break, so two colliding hashes still sort the same way. */
const byHash = (a: EvalCase, b: EvalCase) =>
  stableHash(a.id) - stableHash(b.id) || (a.id < b.id ? -1 : 1);

export interface Split {
  train: EvalCase[];
  heldOut: EvalCase[];
}

export function splitCorpus(corpus: EvalCase[], trainFraction = TRAIN_FRACTION): Split {
  const strata = new Map<string, EvalCase[]>();
  for (const c of corpus) strata.set(stratumOf(c), [...(strata.get(stratumOf(c)) ?? []), c]);
  const trainIds = new Set<string>();
  for (const cases of strata.values()) {
    // Round, but keep at least one case in training (see the singleton note above).
    const n = Math.max(1, Math.round(cases.length * trainFraction));
    for (const c of [...cases].sort(byHash).slice(0, n)) trainIds.add(c.id);
  }
  // Corpus order is kept on both sides; the harness shuffles deterministically anyway.
  return {
    train: corpus.filter((c) => trainIds.has(c.id)),
    heldOut: corpus.filter((c) => !trainIds.has(c.id)),
  };
}

/**
 * Deal cases into `n` disjoint rounds, round-robin in hash order within each stratum,
 * so each round carries a slice of every class. Phase 1 runs the training split as
 * successive rounds against one Memory: a rule distilled from round 1's drops can only
 * earn live hits (and promotion) on traffic that arrives *after* it exists, which in a
 * single pass it never would, since the harness sends every request before reviewing.
 */
export function rounds(cases: EvalCase[], n: number): EvalCase[][] {
  const out: EvalCase[][] = Array.from({ length: n }, () => []);
  const strata = new Map<string, EvalCase[]>();
  for (const c of cases) strata.set(stratumOf(c), [...(strata.get(stratumOf(c)) ?? []), c]);
  // A running counter across strata, so singleton classes don't all land in round 1.
  let i = 0;
  for (const key of [...strata.keys()].sort()) {
    for (const c of (strata.get(key) ?? []).sort(byHash)) out[i++ % n]?.push(c);
  }
  return out;
}
