import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { rounds, splitCorpus, stableHash, stratumOf } from "../src/split";
import type { EvalCase } from "../src/types";

// The Memory eval's claims rest on the split: held-out cases must never leak into
// training, and the split must not move between runs (or a fake run and a live run
// would be scored on different cases).

const corpus = env.EVAL_CORPUS;
const ids = (cases: EvalCase[]) => cases.map((c) => c.id);

describe("memory eval split", () => {
  it("is deterministic and independent of corpus order", () => {
    const a = splitCorpus(corpus);
    const b = splitCorpus([...corpus].reverse());
    expect(ids(b.train).sort()).toEqual(ids(a.train).sort());
    expect(ids(b.heldOut).sort()).toEqual(ids(a.heldOut).sort());
    // FNV-1a reference value, so a change to the hash (which would reshuffle every
    // published result) fails loudly here instead of silently.
    expect(stableHash("a")).toBe(0xe40c292c);
  });

  it("is disjoint and covers every case", () => {
    const { train, heldOut } = splitCorpus(corpus);
    const trainIds = new Set(ids(train));
    expect(heldOut.filter((c) => trainIds.has(c.id))).toEqual([]);
    expect(new Set([...ids(train), ...ids(heldOut)]).size).toBe(corpus.length);
    expect(train.length + heldOut.length).toBe(corpus.length);
  });

  it("is stratified: about 60/40 within every class, singletons in training", () => {
    const { train, heldOut } = splitCorpus(corpus);
    const strata = new Set(corpus.map(stratumOf));
    for (const s of strata) {
      const n = corpus.filter((c) => stratumOf(c) === s).length;
      const t = train.filter((c) => stratumOf(c) === s).length;
      expect(t, s).toBe(Math.max(1, Math.round(n * 0.6)));
    }
    expect(train.length / corpus.length).toBeGreaterThan(0.55);
    expect(train.length / corpus.length).toBeLessThan(0.65);
    // Both sides have attacks and benign traffic, so held-out recall and FPR both mean something.
    for (const side of [train, heldOut]) {
      expect(side.some((c) => c.label === "attack")).toBe(true);
      expect(side.some((c) => c.label === "benign")).toBe(true);
    }
  });

  it("deals training rounds that are disjoint, complete and balanced", () => {
    const { train } = splitCorpus(corpus);
    const dealt = rounds(train, 3);
    expect(dealt.flat().length).toBe(train.length);
    expect(new Set(ids(dealt.flat())).size).toBe(train.length);
    const sizes = dealt.map((r) => r.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(ids(rounds([...train].reverse(), 3).flat())).toEqual(ids(dealt.flat()));
  });
});
