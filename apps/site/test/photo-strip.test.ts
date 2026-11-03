import { describe, expect, it } from "vitest";
import { nearestIndex, stepTarget } from "../src/lib/photo-strip";

// Photos at 0, 370, 740, … (340 wide + 30 gap); the strip can scroll 1500 px.
const offsets = [0, 370, 740, 1110, 1480, 1850];

describe("photo strip", () => {
  it("finds the photo nearest the scroll position", () => {
    expect(nearestIndex(0, offsets)).toBe(0);
    expect(nearestIndex(200, offsets)).toBe(1);
    expect(nearestIndex(1000, offsets)).toBe(3);
  });

  it("steps one photo at a time from wherever the strip is", () => {
    expect(stepTarget(0, offsets, 1, 1500)).toBe(370);
    expect(stepTarget(380, offsets, -1, 1500)).toBe(0);
  });

  it("never steps past either end", () => {
    expect(stepTarget(0, offsets, -1, 1500)).toBe(0);
    expect(stepTarget(1480, offsets, 1, 1500)).toBe(1500);
  });
});
