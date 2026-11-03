// The header's split-flap clock: how long the Lazaret demo has been live
// (the user's choice, 2026-11-02). Pure time maths here; the flaps are in FlipClock.astro.

/**
 * When demo.gleator.com went live: its first passing production E2E run
 * (tasks/todo.md, M8 review, "Production run (21:20Z)", 2026-11-01).
 */
export const LIVE_SINCE = Date.parse("2026-11-01T21:20:00Z");

export interface Elapsed {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function elapsedSince(since: number, now: number): Elapsed {
  const total = Math.max(0, Math.floor((now - since) / 1000));
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3_600),
    minutes: Math.floor((total % 3_600) / 60),
    seconds: total % 60,
  };
}

/** The flap faces, left to right: three for days (as on the board), two for the rest. */
export function flapDigits(e: Elapsed): string[] {
  const days = String(Math.min(e.days, 999)).padStart(3, "0");
  return [days, e.hours, e.minutes, e.seconds]
    .map((v) => (typeof v === "string" ? v : String(v).padStart(2, "0")))
    .join("")
    .split("");
}

/** The same figure in words, for screen readers and the tooltip. */
export function elapsedWords(e: Elapsed): string {
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  return [part(e.days, "day"), part(e.hours, "hour"), part(e.minutes, "minute")].join(", ");
}
