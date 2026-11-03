import { describe, expect, it } from "vitest";
import { elapsedSince, elapsedWords, flapDigits, LIVE_SINCE } from "../src/lib/flip-clock";

describe("flip clock", () => {
  it("splits a duration into days, hours, minutes and seconds", () => {
    const e = elapsedSince(0, ((3 * 24 + 22) * 3600 + 29 * 60 + 57) * 1000);
    expect(e).toEqual({ days: 3, hours: 22, minutes: 29, seconds: 57 });
  });

  it("draws the board's faces: three day digits, then pairs", () => {
    expect(flapDigits({ days: 3, hours: 22, minutes: 29, seconds: 57 }).join("")).toBe("003222957");
    expect(flapDigits({ days: 1200, hours: 0, minutes: 0, seconds: 0 }).slice(0, 3).join("")).toBe(
      "999",
    );
  });

  it("never runs backwards before the go-live time", () => {
    expect(elapsedSince(LIVE_SINCE, LIVE_SINCE - 5_000)).toEqual({
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
    });
  });

  it("says it in words for screen readers", () => {
    expect(elapsedWords({ days: 1, hours: 2, minutes: 1, seconds: 9 })).toBe(
      "1 day, 2 hours, 1 minute",
    );
  });

  it("is anchored at the first production E2E pass", () => {
    expect(new Date(LIVE_SINCE).toISOString()).toBe("2026-11-01T21:20:00.000Z");
  });
});
