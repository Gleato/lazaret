// The numbers behind the bungee jumper on the folder's front flap (src/home/Bungee.astro). No
// DOM, so they are unit-tested in Node (test/bungee.test.ts), like lib/folder.ts.

/** His cord at rest, ring to ankles, in px. Bungee.astro's --cord matches. */
export const CORD = 30;
/** How far the cord pays out on the way down, ring to ankles, in px. The user wants a long fall. */
export const LONG_CORD = 300;
/** How far past its rest length the cord is when the flap lands. */
export const STRETCH = 16;
/** How long the cord takes to settle once the flap lands. */
export const BOB_MS = 1700;

export interface LeapPoint {
  /** 0 on the plank, 1 off its end. */
  along: number;
  /** px above the straight line between them. */
  lift: number;
  /** Degrees of the flip: 0 upright, 180 head-first. */
  turn: number;
}

/** The hop off the plank at t (0 to 1): up a little, over, and head-first by the end. */
export function leapArc(t: number, rise: number): LeapPoint {
  const eased = t * t * (3 - 2 * t);
  return { along: t, lift: 4 * rise * t * (1 - t), turn: 180 * eased };
}

// When the cord starts to recoil, as a share of the fall.
const RECOIL_FROM = 0.6;

/**
 * The cord's length at t (0 to 1) through the flap's swing. It stays long while he drags the
 * flap, then recoils before it lands: the flap's edge ends up at the bottom of the page, and the
 * long cord would throw him past it and change the page height.
 */
export function fallCord(t: number): number {
  const r = Math.min(1, Math.max(0, (t - RECOIL_FROM) / (1 - RECOIL_FROM)));
  const eased = r * r * (3 - 2 * r);
  return LONG_CORD + (CORD + STRETCH - LONG_CORD) * eased;
}

// The cord's spring, picked by eye and pinned by the test: the overshoot has to stay inside the
// room .folder leaves below itself, or the page height would jump with him. The bounce is small
// because the user wants him to hang there, just showing he's still attached.
const BOB_PUSH = 40;
const BOB_DECAY = 2.6;
const BOB_PERIOD_S = 0.62;

/** His offset from the resting point, ms after the flap lands. It starts on the stretched cord. */
export function bungeeBob(ms: number): number {
  if (ms >= BOB_MS) return 0;
  const s = Math.max(0, ms) / 1000;
  const w = (2 * Math.PI) / BOB_PERIOD_S;
  return Math.exp(-BOB_DECAY * s) * (STRETCH * Math.cos(w * s) + BOB_PUSH * Math.sin(w * s));
}
