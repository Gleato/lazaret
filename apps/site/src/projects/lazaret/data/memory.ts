import { type CurvePoint, niceMax } from "../../../lib/curve";

// The Memory panel's learning curve (M7.1), from the campaign replay eval
// (evals/results/campaign-*.json, written by evals/src/campaign.ts). It replaces the
// two-phase cold/warm table: that eval's corpus had about one example per trick, so
// no rule could earn its evidence, and the table said "nothing learned" either way.
// The campaign replays each attack family as many encoded variants over six windows,
// with the Memory learning live, so the panel can show the trend a production team
// pays for: cost falling as the gate takes over, with recall and FPR beside it.
//
// Picked up at build time: the live run if one has been published, otherwise the free
// offline run, which the page labels as a scripted-reviewer check. The operator that
// works the human queue is simulated in both, and the page says so.

const files = import.meta.glob<{ default: unknown }>(
  "../../../../../../evals/results/campaign-*.json",
  { eager: true },
);

export interface CampaignWindow {
  window: number;
  writes: number;
  attacks: number;
  benign: number;
  recall: number | null;
  falsePositiveRate: number | null;
  modelCallsPer1k: number | null;
  usdPer1k: number | null;
  gateShareOfStops: number | null;
  stops: number;
  gateStops: number;
  promotions: Record<string, number>;
  probe: { heldOutGateRecall: number | null; trainGateRecall: number | null };
}

export interface CampaignResult {
  mode: "fake" | "live";
  startedAt: string;
  config: {
    windows: number;
    casesPerWindow: number;
    attackShare: number;
    operatorDelayWindows: number;
  };
  families: { train: string[]; heldOut: string[] };
  baselineProbe: { heldOutGateRecall: number | null };
  windows: CampaignWindow[];
  cost: { totalUsd: number };
  counterfactual?: { windows: { window: number; modelCallsPer1k: number | null }[] };
}

export interface ChartSpec {
  id: string;
  title: string;
  /** Which way is good, in words, so the chart never relies on the reader guessing. */
  note: string;
  kind: "line" | "columns";
  yMax: number;
  percent: boolean;
  points: CurvePoint[];
}

export interface CurveView {
  live: boolean;
  summary: string;
  charts: ChartSpec[];
  table: {
    head: string[];
    rows: string[][];
  };
  caveats: string[];
  source: string;
}

const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
const num = (v: number | null) => (v === null ? "n/a" : String(Math.round(v)));

export function toCurveView(r: CampaignResult | undefined): CurveView | null {
  if (!r?.windows?.length) return null;
  const live = r.mode === "live";
  const ws = r.windows;
  const first = ws[0] as CampaignWindow;
  const last = ws.at(-1) as CampaignWindow;
  const maxCalls = Math.max(...ws.map((w) => w.modelCallsPer1k ?? 0));
  const date = new Date(r.startedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const promoted = ws.reduce((n, w) => n + (w.promotions.block ?? 0), 0);
  const changes = (w: CampaignWindow) => {
    const parts = [
      ["block", "to block"],
      ["flag", "to flag"],
      ["shadow", "to shadow"],
      ["retired", "retired"],
      ["rejected", "rejected"],
    ]
      .filter(([k]) => (w.promotions[k as string] ?? 0) > 0)
      .map(([k, label]) => `${w.promotions[k as string]} ${label}`);
    return parts.length ? parts.join(", ") : "none";
  };

  return {
    live,
    summary:
      `${r.config.windows} windows of about ${r.config.casesPerWindow} writes, ` +
      `${Math.round(r.config.attackShare * 100)}% of them attack variants. ` +
      `${promoted} learned ${promoted === 1 ? "rule was" : "rules were"} promoted to block. ` +
      `Model calls per 1,000 writes went from ${num(first.modelCallsPer1k)} to ` +
      `${num(last.modelCallsPer1k)}, and the gate made ${pct(last.gateShareOfStops)} of the ` +
      `stops in the last window, up from ${pct(first.gateShareOfStops)}.` +
      // Said in words whichever way it went, so the page never leaves a flat or rising
      // line for the reader to interpret (the first live run's cost per 1,000 rose).
      (live && first.usdPer1k !== null && last.usdPer1k !== null
        ? ` Cost per 1,000 writes ${last.usdPer1k < first.usdPer1k ? "fell" : "did not fall"}: ` +
          `$${first.usdPer1k.toFixed(2)} in the first window, $${last.usdPer1k.toFixed(2)} in the last, ` +
          "because honest writes still all need a model and they are most of the traffic."
        : "") +
      ((last.probe.heldOutGateRecall ?? 0) <= (r.baselineProbe.heldOutGateRecall ?? 0)
        ? " The learned rules did not stop any attack family held out of training: each rule fits the payloads it was learned from."
        : ""),
    charts: [
      {
        id: "calls",
        title: "Model calls per 1,000 writes",
        note: "Lower is cheaper and faster: a write the gate decides never waits on a model.",
        kind: "line",
        yMax: niceMax(maxCalls),
        percent: false,
        points: ws.map((w) => ({
          x: w.window,
          label: String(w.window),
          value: w.modelCallsPer1k,
          display: num(w.modelCallsPer1k),
        })),
      },
      {
        id: "gate",
        title: "Share of stops made by the gate",
        note: "Higher means more attacks were stopped by a learned rule, before any model.",
        kind: "columns",
        yMax: 1,
        percent: true,
        points: ws.map((w) => ({
          x: w.window,
          label: String(w.window),
          value: w.gateShareOfStops,
          display: pct(w.gateShareOfStops),
        })),
      },
      {
        id: "heldout",
        title: "Unseen attack families stopped at the gate",
        note: "Fresh variants of attacks the Memory never trained on. Higher means it learned the kind of attack, not just the payload.",
        kind: "line",
        yMax: 1,
        percent: true,
        points: [
          {
            x: 0,
            label: "0",
            value: r.baselineProbe.heldOutGateRecall,
            display: pct(r.baselineProbe.heldOutGateRecall),
          },
          ...ws.map((w) => ({
            x: w.window,
            label: String(w.window),
            value: w.probe.heldOutGateRecall,
            display: pct(w.probe.heldOutGateRecall),
          })),
        ],
      },
    ],
    table: {
      head: [
        "Window",
        "Writes",
        "Attacks stopped",
        "Honest writes stopped",
        "Model calls per 1,000",
        ...(live ? ["Cost per 1,000"] : []),
        "Stops at the gate",
        "Unseen families at the gate",
        "Rule changes",
      ],
      rows: ws.map((w) => [
        String(w.window),
        String(w.writes),
        `${Math.round((w.recall ?? 0) * w.attacks)} of ${w.attacks}`,
        `${Math.round((w.falsePositiveRate ?? 0) * w.benign)} of ${w.benign}`,
        num(w.modelCallsPer1k),
        ...(live ? [w.usdPer1k === null ? "n/a" : `$${w.usdPer1k.toFixed(2)}`] : []),
        `${w.gateStops} of ${w.stops}`,
        pct(w.probe.heldOutGateRecall),
        changes(w),
      ]),
    },
    caveats: [
      `The human queue and disputed writes were worked by a simulated operator, labelling from the eval corpus ${r.config.operatorDelayWindows} window later. A real deployment gets those labels only from a person.`,
      "The traffic is generated: each corpus attack is re-sent as encoded, re-cased, split and moved variants (no model writes them), mixed with benign variants. It is not captured production traffic.",
      `${r.families.heldOut.length} attack families were held out of training entirely; the third chart measures only them, with the gate alone.`,
      ...(live
        ? []
        : [
            "This is the free offline run: a keyword reviewer stands in for Claude, so recall is low and the numbers check the learning loop, not model quality.",
          ]),
    ],
    source: live
      ? `Live campaign run of ${date}: Claude reviewing, Claude proposing the rules, $${r.cost.totalUsd.toFixed(2)} in all (evals/results/campaign-latest.json).`
      : `Offline campaign run of ${date} (evals/results/campaign-fake.json).`,
  };
}

const PREFIX = "../../../../../../evals/results/";
export const curve: CurveView | null = toCurveView(
  (files[`${PREFIX}campaign-latest.json`] ?? files[`${PREFIX}campaign-fake.json`])?.default as
    | CampaignResult
    | undefined,
);
