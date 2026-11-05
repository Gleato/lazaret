// Geometry and timing for the header's neural network animation (NeuralFlow.astro). The
// signals run forward to one output, hold, then run back along the same paths: forward
// and backward passes. Every track below is a palindrome over the cycle, so the end of
// the loop is the start of it and there is no seam. Pure, so the tests can prove that.

export const WIDTH = 200; // The width of the flip clock it replaced, by the user's request.
export const HEIGHT = 34;
export const PERIOD_S = 8;

const LAYERS = [3, 4, 5, 4, 2];
const SPACING = 7;
const INSET = 3;
/** Each path picks one node per layer; all three converge on the first output. */
const PATHS = [
  [0, 0, 1, 1, 0],
  [1, 2, 2, 1, 0],
  [2, 3, 3, 2, 0],
];

/** Length of the moving pulse, as a fraction of its path. */
const PULSE = 0.16;
/** Share of the cycle spent still at each end. */
const HOLD = 0.06;
/** Half-width of a node's flash, as a share of the cycle. */
const FLASH = 0.035;
/** Exactly smoothstep: bezier x(t) = t, y(t) = 3t² - 2t³. */
const EASE = "0.33 0 0.67 1";

export interface Point {
  x: number;
  y: number;
}
/** One SMIL track: `times` are keyTimes, `values` the value at each. */
export interface Track {
  times: number[];
  values: number[];
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

export function nodeAt(col: number, row: number): Point {
  const count = LAYERS[col] ?? 0;
  return {
    x: INSET + (col * (WIDTH - 2 * INSET)) / (LAYERS.length - 1),
    y: HEIGHT / 2 + (row - (count - 1) / 2) * SPACING,
  };
}

/** Every node, for the resting network. */
export const NODES: Point[] = LAYERS.flatMap((n, col) =>
  Array.from({ length: n }, (_, row) => nodeAt(col, row)),
);

/** All the connections, as one path, so 60 lines cost one DOM node. */
export const EDGES = LAYERS.slice(1)
  .flatMap((n, i) =>
    Array.from({ length: LAYERS[i] ?? 0 }, (_, from) =>
      Array.from({ length: n }, (_, to) => {
        const a = nodeAt(i, from);
        const b = nodeAt(i + 1, to);
        return `M${a.x} ${a.y}L${b.x} ${b.y}`;
      }),
    ),
  )
  .flat(2)
  .join("");

/** The signal paths, as path data. */
export const SIGNALS = PATHS.map((rows) =>
  rows
    .map((row, col) => {
      const p = nodeAt(col, row);
      return `${col ? "L" : "M"}${p.x} ${p.y}`;
    })
    .join(""),
);

/** The pulse's stroke-dashoffset: hold, forward, hold, back, hold. */
export const PULSE_DASH = `${PULSE} 2`;
export const pulseTrack: Track = {
  times: [0, HOLD, 0.5 - HOLD, 0.5 + HOLD, 1 - HOLD, 1],
  values: [PULSE, PULSE, -1, -1, PULSE, PULSE],
};
/** keySplines for pulseTrack: still, eased, still, eased, still. */
export const PULSE_SPLINES = ["0 0 1 1", EASE, "0 0 1 1", EASE, "0 0 1 1"].join(";");

/** When the pulse's head reaches a fraction `f` of its path, inverting the smoothstep. */
function reachedAt(f: number): number {
  const travelled = f / (1 + PULSE);
  const x = 0.5 - Math.sin(Math.asin(1 - 2 * travelled) / 3);
  return HOLD + x * (0.5 - 2 * HOLD);
}

/** A node's glow: it flashes as the pulse passes, and the two end layers stay lit in the hold. */
export function glowTrack(col: number): Track {
  const last = LAYERS.length - 1;
  const at = reachedAt(col / last);
  const back = 1 - at;
  if (col === 0) {
    return {
      times: [0, at, at + FLASH, back - FLASH, back, 1].map(round),
      values: [1, 1, 0, 0, 1, 1],
    };
  }
  if (col === last) {
    return {
      times: [0, at - FLASH, at, back, back + FLASH, 1].map(round),
      values: [0, 0, 1, 1, 0, 0],
    };
  }
  return {
    times: [0, at - FLASH, at, at + FLASH, back - FLASH, back, back + FLASH, 1].map(round),
    values: [0, 0, 1, 0, 0, 1, 0, 0],
  };
}

/** The nodes the signals pass through, each once, with the layer that sets its timing. */
export const GLOWS: (Point & { col: number })[] = LAYERS.flatMap((_, col) =>
  [...new Set(PATHS.map((rows) => rows[col] ?? 0))].map((row) => ({ ...nodeAt(col, row), col })),
);
