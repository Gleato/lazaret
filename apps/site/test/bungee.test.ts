import { describe, expect, it } from "vitest";
import { BOB_MS, bungeeBob, CORD, fallCord, LONG_CORD, leapArc, STRETCH } from "../src/lib/bungee";

// The jumper's numbers (src/lib/bungee.ts).

describe("leapArc", () => {
  it("leaves upright and arrives head-first", () => {
    expect(leapArc(0, 20)).toEqual({ along: 0, lift: 0, turn: 0 });
    expect(leapArc(1, 20)).toEqual({ along: 1, lift: 0, turn: 180 });
  });

  it("rises by the given height at the top", () => {
    expect(leapArc(0.5, 20).lift).toBeCloseTo(20);
  });
});

describe("fallCord", () => {
  it("is long for most of the way down", () => {
    expect(fallCord(0)).toBe(LONG_CORD);
    expect(fallCord(0.6)).toBe(LONG_CORD);
    expect(LONG_CORD).toBeGreaterThan(CORD * 5);
  });

  it("recoils to where the bounce starts", () => {
    expect(fallCord(1)).toBe(CORD + STRETCH);
    expect(fallCord(1)).toBe(CORD + bungeeBob(0));
  });

  it("only ever shortens", () => {
    let last = Infinity;
    for (let t = 0; t <= 1; t += 0.01) {
      expect(fallCord(t)).toBeLessThanOrEqual(last);
      last = fallCord(t);
    }
  });
});

describe("bungeeBob", () => {
  const samples = Array.from({ length: BOB_MS }, (_, ms) => bungeeBob(ms));

  it("starts on the stretched cord, where the fall left him", () => {
    expect(bungeeBob(0)).toBe(STRETCH);
  });

  it("stays a small bounce, inside the room below the folder", () => {
    expect(Math.max(...samples)).toBeLessThanOrEqual(40);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-30);
  });

  it("has died away when it stops", () => {
    expect(Math.abs(bungeeBob(BOB_MS - 1))).toBeLessThan(1);
    expect(bungeeBob(BOB_MS)).toBe(0);
  });
});
