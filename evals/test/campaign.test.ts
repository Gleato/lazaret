import { env } from "cloudflare:test";
import {
  AnthropicReviewer,
  AnthropicRuleProposer,
  canonicalize,
  decodedView,
} from "@gleator/lazaret";
import { config } from "@gleator/tidewater-lazaret/config";
import { makeScriptedReviewer } from "@gleator/tidewater-lazaret/scripted-reviewer";
import { describe, expect, it, type TestContext } from "vitest";
import { type CampaignResult, campaignFamilies, runCampaign, windowCases } from "../src/campaign";
import { BENIGN_TRANSFORMS, variantOf } from "../src/mutate";
import { callCostUsd } from "../src/pricing";
import type { EvalCase } from "../src/types";

// The campaign replay eval (src/campaign.ts, M7.1 C). `fake` runs in every `npm test`
// (free, deterministic) as a regression test of "it gets cheaper as it learns, and
// stays as safe"; `npm run eval:campaign` also writes results/campaign-fake.json. `live`
// runs only via `npm run eval:campaign:live`, behind the same spend guard as eval:live.

let run = 0;

async function evaluate(
  mode: "fake" | "live",
  task: TestContext["task"] | null,
  arm: { readDecoded?: boolean; learning?: boolean } = {},
) {
  const key = env.ANTHROPIC_API_KEY;
  const result = await runCampaign({
    mode,
    corpus: env.EVAL_CORPUS,
    ledger: env.EVAL_LEDGER,
    memory: env.EVAL_MEMORY,
    runId: `campaign-${mode}-${++run}`,
    maxUsd: Number(env.EVAL_MAX_USD ?? 6),
    costOf: (c) => callCostUsd(c).usd,
    learning: arm.learning ?? true,
    ...(mode === "fake"
      ? { fakeReviewer: makeScriptedReviewer({ readDecoded: arm.readDecoded ?? true }) }
      : {}),
    ...(mode === "live" && key
      ? {
          liveReviewer: new AnthropicReviewer(key, config.review),
          liveProposer: new AnthropicRuleProposer(key, config.memory.distillModel),
        }
      : {}),
  });
  if (task) {
    task.meta.campaignResult = {
      ...result,
      models:
        mode === "live"
          ? {
              batch: config.review.batchModel,
              escalation: config.review.escalationModel,
              inline: config.review.inlineModel,
              distill: config.memory.distillModel,
            }
          : "scripted",
    };
  }
  return result;
}

/** The per-window numbers another arm is compared on. */
const brief = (r: CampaignResult) =>
  r.windows.map((w) => ({
    window: w.window,
    recall: w.recall,
    falsePositiveRate: w.falsePositiveRate,
    modelReviewsPer1k: w.modelReviewsPer1k,
    modelCallsPer1k: w.modelCallsPer1k,
    gateShareOfStops: w.gateShareOfStops,
    stoppedAttacks: w.attacks && w.recall !== null ? Math.round(w.attacks * w.recall) : 0,
  }));

describe("campaign replay", () => {
  it("deals a deterministic stream that never sends a held-out family", () => {
    const families = campaignFamilies(env.EVAL_CORPUS);
    const held = new Set(families.heldOut.map((c) => c.id));
    expect(families.heldOut.length).toBeGreaterThan(0);
    const all = Array.from({ length: 6 }, (_, w) => windowCases(families, w, 50, 7)).flat();
    expect(all.some((c) => held.has(c.family))).toBe(false);
    expect(all.filter((c) => c.label === "attack")).toHaveLength(90);
    expect(JSON.stringify(windowCases(families, 3, 50, 7))).toBe(
      JSON.stringify(windowCases(families, 3, 50, 7)),
    );
  });

  it("fake: gets cheaper as it learns, stops at least what it would have without learning, and generalises", async ({
    task,
  }) => {
    const r = await evaluate("fake", task);
    // Counterfactual: the same stream through a stack that never learns.
    const cold = await evaluate("fake", null, { learning: false });
    // Decoded-view ablation (M7.1 B): the same campaign, keyword reviewer reading only
    // the raw body, as before the prompt change.
    const raw = await evaluate("fake", null, { readDecoded: false });
    const meta = task.meta.campaignResult as Record<string, unknown>;
    meta.counterfactual = {
      note: "Same stream and scripted reviewer, Memory never learns.",
      windows: brief(cold),
    };
    meta.decodedViewAblation = {
      note: "Same campaign, scripted reviewer reading only the raw body (pre-M7.1).",
      windows: brief(raw),
      rules: raw.rules.map((x) => ({ id: x.id, status: x.status, reason: x.reason })),
    };

    // What the decoded view costs in prompt size, and how often it appears at all:
    // it is only added when decoding changed a field.
    const targets = Array.from({ length: r.config.windows }, (_, w) =>
      windowCases(campaignFamilies(env.EVAL_CORPUS), w, r.config.casesPerWindow, r.config.seed),
    )
      .flat()
      .map((c) => {
        const t = c.requests.at(-1);
        const d = decodedView(t?.path ?? "/", "", t?.bodyText ?? null, "application/json");
        return { label: c.label, extra: d ? JSON.stringify(d).length : 0 };
      });
    const withView = (label: string) =>
      targets.filter((t) => t.label === label && t.extra > 0).length;
    const extras = targets.filter((t) => t.extra > 0).map((t) => t.extra);
    meta.decodedView = {
      targets: targets.length,
      withDecodedView: { attack: withView("attack"), benign: withView("benign") },
      of: {
        attack: targets.filter((t) => t.label === "attack").length,
        benign: targets.filter((t) => t.label === "benign").length,
      },
      extraCharsWhenPresent: {
        mean: extras.length ? Math.round(extras.reduce((a, b) => a + b, 0) / extras.length) : 0,
        max: Math.max(0, ...extras),
      },
      attacksStoppedOverRun: {
        decoded: brief(r).reduce((n, w) => n + w.stoppedAttacks, 0),
        rawOnly: brief(raw).reduce((n, w) => n + w.stoppedAttacks, 0),
      },
    };

    const first = r.windows[0];
    const last = r.windows.at(-1);
    if (!first || !last) throw new Error("no windows");
    const total = (rs: CampaignResult, k: "modelReviews" | "modelCalls") =>
      rs.windows.reduce((n, w) => n + w[k], 0);
    // Cheaper: fewer model reviews and calls than without learning, a falling call
    // rate, and the gate takes a growing share of stops.
    expect(total(r, "modelReviews")).toBeLessThan(total(cold, "modelReviews"));
    expect(total(r, "modelCalls")).toBeLessThan(total(cold, "modelCalls"));
    expect(last.modelReviewsPer1k ?? 0).toBeLessThan(first.modelReviewsPer1k ?? 0);
    expect(last.gateShareOfStops ?? 0).toBeGreaterThan(first.gateShareOfStops ?? 0);
    // As safe, window by window: every attack the no-learning stack stops is stopped,
    // and no benign write is stopped that the no-learning stack let through.
    for (const [i, w] of r.windows.entries()) {
      const c = cold.windows[i];
      expect(w.recall ?? 0).toBeGreaterThanOrEqual(c?.recall ?? 0);
      const coldFps = new Set(c?.falsePositiveIds.map((f) => f.id));
      for (const fp of w.falsePositiveIds) expect(coldFps).toContain(fp.id);
    }
    // A learned rule is only as clean as the reviewer's drops it learned from: the
    // keyword reviewer wrongly drops ok-hard-02 (a customer asking about UNION SELECT),
    // and the SQLi rule inherits it. So the bar is "learning adds no false positive the
    // reviewer didn't already make": benign probe stops only in families the reviewer
    // itself dropped in the stream. (The live reviewer has allowed ok-hard-02.)
    const reviewerFps = new Set(
      r.windows.flatMap((w) => w.falsePositiveIds.map((f) => f.id.split("~")[0])),
    );
    for (const w of r.windows) {
      for (const id of w.probe.benignStoppedIds) expect(reviewerFps).toContain(id.split("~")[0]);
    }
    // Generalises: fresh variants of held-out families are stopped at the gate more
    // often after learning than before.
    expect(last.probe.heldOutGateRecall ?? 0).toBeGreaterThan(
      r.baselineProbe.heldOutGateRecall ?? 0,
    );
  });

  it.runIf(env.EVAL_LIVE === "1")(
    "live: real reviewers and a real distiller over the campaign",
    async ({ task }) => {
      const r = await evaluate("live", task);
      console.log(JSON.stringify({ headline: r.headline, cost: r.cost }, null, 2));
      expect(r.windows.length).toBeGreaterThan(0);
    },
  );
});

describe("campaign mutator", () => {
  it("gives benign traffic only the transforms real clients produce", () => {
    const benign = env.EVAL_CORPUS.filter((c) => c.label === "benign");
    const used = new Set(
      benign.flatMap((c) =>
        Array.from({ length: 20 }, (_, n) => variantOf(c, n + 1, 3).transforms).flat(),
      ),
    );
    expect([...used].sort()).toEqual([...BENIGN_TRANSFORMS].sort());
  });

  it("keeps what a variant means: the gate decodes it back to the original", () => {
    const xss = env.EVAL_CORPUS.find((c) => c.id === "xss-01") as EvalCase;
    for (let n = 1; n <= 12; n++) {
      const v = variantOf(xss, n, 9);
      if (v.transforms.some((t) => t === "move" || t === "space" || t === "comment")) continue;
      const decode = (s: string) => canonicalize(s);
      expect(decode(v.requests.at(-1)?.bodyText ?? "")).toBe(
        decode(xss.requests.at(-1)?.bodyText ?? ""),
      );
    }
  });
});
