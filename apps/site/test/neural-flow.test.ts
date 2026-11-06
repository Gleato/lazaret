import { describe, expect, it } from "vitest";
import {
  beginOf,
  COMET,
  glowTrack,
  hanging,
  pulseTrack,
  type Track,
  taut,
  wire,
} from "../src/lib/neural-flow";

const R = { x: 170, y: 41 };
const N = { x: 222, y: 39 };
const pulled = () => taut({ x: 250, y: 50 }, { x: 1100, y: 50 });
const SAG = 44;
const slack = () => hanging(R, N, SAG);

const expectSeamless = ({ times, values }: Track) => {
  expect(times[0]).toBe(0);
  expect(times.at(-1)).toBe(1);
  expect(values[0]).toBe(values.at(-1));
  for (let i = 1; i < times.length; i++) {
    expect(times[i]).toBeGreaterThan(times[i - 1] ?? 0);
  }
};

const COLS = [0, 1, 2, 3, 4, 5, 6];

describe("neural flow", () => {
  it("loops without a seam, for every comet layer and every node", () => {
    for (const { length } of COMET) expectSeamless(pulseTrack(length));
    for (const col of COLS) expectSeamless(glowTrack(col));
  });

  it("flashes each layer in order on the way forward, and reversed on the way back", () => {
    const peaks = (pass: "first" | "second") =>
      [1, 2, 3, 4, 5].map((col) => {
        const t = glowTrack(col);
        const first = t.values.indexOf(1);
        return t.times[pass === "first" ? first : t.values.lastIndexOf(1)] ?? 0;
      });
    const sorted = (ns: number[]) => [...ns].sort((a, b) => a - b);
    expect(peaks("first")).toEqual(sorted(peaks("first")));
    expect(peaks("second")).toEqual(sorted(peaks("second")).reverse());
    expect(new Set(peaks("first")).size).toBe(5);
  });

  it("fires faster than it fades", () => {
    const { times, values } = glowTrack(3);
    const peak = values.indexOf(1);
    const rise = (times[peak] ?? 0) - (times[peak - 1] ?? 0);
    const fall = (times[peak + 1] ?? 0) - (times[peak] ?? 0);
    expect(fall).toBeGreaterThan(rise * 3);
  });

  it("keeps the comet's bright end leading, in both directions", () => {
    const edge = (i: number, of: (length: number, value: number) => number) =>
      new Set(COMET.map(({ length }) => of(length, pulseTrack(length).values[i] ?? 0).toFixed(3)));
    // Forward, every layer's far edge is at length - offset. Back, its near edge is at -offset.
    expect(edge(2, (l, v) => l - v).size).toBe(1);
    expect(edge(3, (_, v) => -v).size).toBe(1);
    expect(edge(4, (_, v) => -v).size).toBe(1);
  });

  it("parks every comet layer off the path during the holds", () => {
    for (const { length } of COMET) {
      const { values } = pulseTrack(length);
      const window = (i: number) => {
        const start = -(values[i] ?? 0);
        return [start, start + length] as const;
      };
      expect(window(0)[1]).toBeLessThan(0); // Before the path, waiting to leave.
      expect(window(2)[0]).toBeGreaterThan(1); // Past the far end.
      expect(window(3)[0]).toBeGreaterThan(1); // Lined up to come back.
      expect(window(4)[1]).toBeLessThan(0); // Past the near end.
    }
  });

  it("tapers: shorter comet layers are thicker and brighter", () => {
    const tail = COMET.slice(1); // The bloom sits outside the taper, on purpose.
    for (let i = 1; i < tail.length; i++) {
      expect(tail[i]?.length).toBeLessThan(tail[i - 1]?.length ?? 0);
      expect(tail[i]?.width).toBeGreaterThan(tail[i - 1]?.width ?? 0);
      expect(tail[i]?.opacity).toBeGreaterThan(tail[i - 1]?.opacity ?? 0);
    }
  });

  it("fires its signals apart, not in lockstep", () => {
    expect(new Set([0, 1, 2].map(beginOf)).size).toBe(3);
  });

  it("connects every node in a layer to every node in the next", () => {
    const { edges, leads } = wire(pulled(), 8);
    expect(edges.match(/M/g)).toHaveLength(12 + 20 + 20 + 8);
    expect(leads.match(/M/g)).toHaveLength(3 + 2);
  });

  it("runs from one plug, through the layers, to the other", () => {
    const { glows } = wire(pulled(), 8);
    const places = (col: number) =>
      new Set(glows.filter((g) => g.col === col).map((g) => `${g.x} ${g.y}`)).size;
    expect(places(0)).toBe(1);
    expect(places(1)).toBe(3);
    expect(places(5)).toBe(1);
    expect(places(6)).toBe(1);
    expect(glows).toHaveLength(3 * 7);
  });

  it("puts its plugs exactly on the anchors, taut or slack", () => {
    for (const [line, a, b] of [
      [pulled(), { x: 250, y: 50 }, { x: 1100, y: 50 }],
      [slack(), R, N],
    ] as const) {
      const { nodes, glows } = wire(line, 5);
      expect(nodes[0]).toEqual(a);
      expect(nodes.at(-1)).toEqual(b);
      expect(glows[0]).toMatchObject(a);
      expect(glows.at(-1)).toMatchObject(b);
    }
  });

  it("stays in a straight band when pulled tight", () => {
    const { nodes } = wire(pulled(), 8);
    for (const n of nodes) expect(Math.abs(n.y - 50)).toBeLessThanOrEqual(2 * 8);
  });

  it("hangs like a real cable: down from its anchors and never past them", () => {
    const strand = slack();
    const points = Array.from({ length: 101 }, (_, i) => strand(i / 100, 0));
    // A catenary stays inside its span.
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(R.x - 0.01);
      expect(p.x).toBeLessThanOrEqual(N.x + 0.01);
    }
    expect(Math.max(...points.map((p) => p.y))).toBeCloseTo((R.y + N.y) / 2 + SAG, -0.5);
  });

  it("satisfies the catenary equation, so gravity is what shapes it", () => {
    // Symmetric anchors: every point must fit y = m (cosh(x / m) - cosh(span / 2m)).
    const span = 60;
    const line = hanging({ x: -span / 2, y: 0 }, { x: span / 2, y: 0 }, SAG);
    const bottom = line(0.5, 0);
    expect(bottom.y).toBeCloseTo(SAG, 3);
    expect(bottom.x).toBeCloseTo(0, 3);
    const m = (() => {
      let lo = 1;
      let hi = 1e4;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (mid * (Math.cosh(span / (2 * mid)) - 1) > SAG) lo = mid;
        else hi = mid;
      }
      return lo;
    })();
    for (const f of [0.1, 0.25, 0.4, 0.7, 0.9]) {
      const p = line(f, 0);
      const expected = SAG - m * (Math.cosh(p.x / m) - 1);
      expect(p.y).toBeCloseTo(expected, 2);
    }
  });

  it("gives each strand its own slack, pinched at the plugs and fanned in the belly", () => {
    const line = slack();
    expect(line(0, -10).y).toBeCloseTo(line(0, 10).y, 6);
    expect(line(1, -10).y).toBeCloseTo(line(1, 10).y, 6);
    const depths = [-10, -5, 0, 5, 10].map((v) => line(0.5, v).y);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    expect((depths[4] ?? 0) - (depths[0] ?? 0)).toBeCloseTo(20, 0);
  });

  it("has no kinks: the curve turns gradually all the way along", () => {
    const line = slack();
    const steps = 60;
    const heading = (i: number) => {
      const p = line(i / steps, 0);
      const q = line((i + 1) / steps, 0);
      return Math.atan2(q.y - p.y, q.x - p.x);
    };
    for (let i = 1; i < steps; i++) {
      const turn = Math.abs(heading(i) - heading(i - 1));
      expect(turn).toBeLessThan(0.4);
    }
  });

  it("runs through its nodes without a corner when flowing", () => {
    // On a flat cable, so any bend in the line is the link's own. Links are 10 steps long, so
    // a node is every 10th point: compare the direction arriving with the direction leaving.
    const SEGMENTS = 10;
    const worstCorner = (flowing: boolean) => {
      const d = wire(taut({ x: 0, y: 0 }, { x: 600, y: 0 }), 20, flowing).signals[0] ?? "";
      const pts = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({
        x: Number(m[1]),
        y: Number(m[2]),
      }));
      const heading = (i: number) => {
        const p = pts[i] ?? { x: 0, y: 0 };
        const q = pts[i + 1] ?? { x: 0, y: 0 };
        return Math.atan2(q.y - p.y, q.x - p.x);
      };
      let worst = 0;
      for (let i = SEGMENTS; i < pts.length - 1; i += SEGMENTS) {
        worst = Math.max(worst, Math.abs(heading(i) - heading(i - 1)));
      }
      return worst;
    };
    expect(worstCorner(true)).toBeLessThan(0.06);
    expect(worstCorner(false)).toBeGreaterThan(0.1);
  });

  it("spaces its layers evenly along the curve, so the flashes meet the pulse", () => {
    // Fine chords approximate length: the six layers must each cover the same stretch.
    const line = slack();
    const lengthOf = (from: number, to: number) => {
      let total = 0;
      for (let i = 0; i < 40; i++) {
        const p = line(from + ((to - from) * i) / 40, 0);
        const q = line(from + ((to - from) * (i + 1)) / 40, 0);
        total += Math.hypot(q.x - p.x, q.y - p.y);
      }
      return total;
    };
    const stretches = [0, 1, 2, 3, 4, 5].map((i) => lengthOf(i / 6, (i + 1) / 6));
    expect(Math.max(...stretches) / Math.min(...stretches)).toBeLessThan(1.01);
  });

  it("copes with its two anchors landing on one point", () => {
    const { nodes } = wire(hanging({ x: 10, y: 10 }, { x: 10, y: 10 }, SAG), 5);
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });
});
