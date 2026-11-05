import { describe, expect, it } from "vitest";
import {
  EDGES,
  GLOWS,
  glowTrack,
  HEIGHT,
  NODES,
  pulseTrack,
  type Track,
  WIDTH,
} from "../src/lib/neural-flow";

const expectSeamless = ({ times, values }: Track) => {
  expect(times[0]).toBe(0);
  expect(times.at(-1)).toBe(1);
  expect(values[0]).toBe(values.at(-1));
  for (let i = 1; i < times.length; i++) {
    expect(times[i]).toBeGreaterThan(times[i - 1] ?? 0);
  }
  // Played backward it's the same track: the backward pass mirrors the forward one.
  expect(values).toEqual([...values].reverse());
  times.forEach((t, i) => {
    expect(t + (times[times.length - 1 - i] ?? 0)).toBeCloseTo(1, 3);
  });
};

describe("neural flow", () => {
  it("loops without a seam, for the pulse and every node", () => {
    expectSeamless(pulseTrack);
    for (const col of [0, 1, 2, 3, 4]) expectSeamless(glowTrack(col));
  });

  it("flashes each layer in order on the way forward", () => {
    const peaks = [1, 2, 3].map((col) => {
      const t = glowTrack(col);
      return t.times[t.values.indexOf(1)] ?? 0;
    });
    expect(peaks).toEqual([...peaks].sort((a, b) => a - b));
    expect(new Set(peaks).size).toBe(3);
  });

  it("stays inside its slim box", () => {
    for (const n of NODES) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(WIDTH);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(HEIGHT);
    }
  });

  it("connects every node in a layer to every node in the next", () => {
    expect(EDGES.match(/M/g)).toHaveLength(12 + 20 + 20 + 8);
  });

  it("converges on one output", () => {
    expect(GLOWS.filter((g) => g.col === 4)).toHaveLength(1);
    expect(GLOWS.filter((g) => g.col === 0)).toHaveLength(3);
  });
});
