// Geometry and timing for the header's neural network animation (NeuralFlow.astro). The
// signals run forward to one output, hold, then run back along the same paths: forward
// and backward passes. Every track below ends on the value it starts with, so the end of
// the loop is the start of it and there is no seam. Pure, so the tests can prove that.
//
// The network is wired into the header (the user's request, 2026-11-05): one end is plugged
// into the wordmark's r, the other into the n of the npm logo. So its shape isn't fixed any
// more. It's a flat diagram (a column along the cable, an offset across it) laid onto a
// `Cable`, strung between two measured anchors. `taut` is the desktop header; `hanging` is
// the phone's, from the same two points. Both take the same diagram, so the nodes and the
// timing can't drift apart. SiteHeader.astro measures the anchors.

export const PERIOD_S = 8;

/** The single nodes at each end are the plugs: they sit on the letters. */
const LAYERS = [1, 3, 4, 5, 4, 2, 1];
/** Each path picks one node per layer; they leave one plug and reach the other. */
const PATHS = [
  [0, 0, 0, 1, 1, 0, 0],
  [0, 1, 2, 2, 1, 0, 0],
  [0, 2, 3, 3, 2, 0, 0],
];
/** Straight sections between two nodes on a curve. Fine enough to read as a curve. */
const SEGMENTS = 10;

/** Length of the pulse's longest layer, as a fraction of its path. */
const PULSE = 0.15;
/** How far past either end of the path a pulse rests, so no round cap shows there. */
const CLEAR = 0.01;
/** Share of the cycle spent still at each end. */
const HOLD = 0.06;
/** A node fires fast and dies away slowly, as shares of the cycle. A symmetric blink reads as a light. */
const ATTACK = 0.012;
const DECAY = 0.07;
/** How far each signal fires behind the one before. In lockstep they read as one shape. */
const STAGGER = 0.03;
/** Exactly smoothstep: bezier x(t) = t, y(t) = 3t² - 2t³. */
const EASE = "0.33 0 0.67 1";

export interface Point {
  x: number;
  y: number;
}
/**
 * Where a cable puts a point of the diagram: `f` is the fraction of the way along it, from
 * 0 to 1, and `v` the offset from the middle of the bundle.
 */
export type Cable = (f: number, v: number) => Point;
/** One SMIL track: `times` are keyTimes, `values` the value at each. */
export interface Track {
  times: number[];
  values: number[];
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

const tenth = (n: number) => Math.round(n * 10) / 10;

/** Pulled tight: a straight line, with `v` measured square across it. */
export function taut(a: Point, b: Point): Cable {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  return (f, v) => ({
    x: a.x + dx * f - (dy / d) * v,
    y: a.y + dy * f + (dx / d) * v,
  });
}

/**
 * One strand hanging under its own weight: a true catenary through both anchors, with its
 * lowest point `sag` below them. Real cable hangs in this curve and no other, which is why
 * the user's "loose power cables" needed the equation rather than a bezier tuned to look
 * close (tried first, and it hung at angles no cable would). A catenary also never leaves
 * the span between its anchors, so a slack cable hangs straight down from them.
 *
 * Addressed by arc length, because glowTrack() times each layer's flash on the pulse
 * covering an even share of the path. A catenary has it in closed form, s = m sinh(x / m),
 * so that takes no lookup table. Worked in y-up coordinates, as the textbooks do.
 */
function catenary(a: Point, b: Point, sag: number): (f: number) => Point {
  const span = Math.max(b.x - a.x, 1); // A zero span has no catenary. Clamp, then scale x back.
  const depth = Math.max(sag, 0.01);

  // The catenary parameter, m, from the sag: depth = m (cosh(span / 2m) - 1). No closed
  // form, but that falls steadily as m grows, so bisect it. The floor keeps cosh finite.
  let lo = span / 1400;
  let hi = 1e7;
  for (let i = 0; i < 60; i++) {
    const m = Math.sqrt(lo * hi);
    if (m * (Math.cosh(span / (2 * m)) - 1) > depth) lo = m;
    else hi = m;
  }
  const m = Math.sqrt(lo * hi);

  // The vertex's x, shifted so the curve passes through both anchors at their own heights.
  const rise = a.y - b.y;
  const x0 = span / 2 - m * Math.asinh(rise / (2 * m * Math.sinh(span / (2 * m))));
  const top = -a.y - m * Math.cosh(x0 / m);
  const s0 = m * Math.sinh(-x0 / m);
  const s1 = m * Math.sinh((span - x0) / m);
  const xScale = (b.x - a.x) / span;

  return (f) => {
    const s = s0 + (s1 - s0) * f;
    return {
      x: a.x + (x0 + m * Math.asinh(s / m)) * xScale,
      y: -(top + Math.hypot(m, s)),
    };
  };
}

/**
 * Loose cables: every strand hangs from the same two anchors with its own slack, so they
 * pinch together at the plugs and fan out in the belly, the way a real bundle does. `v`
 * adds to the sag of that strand.
 */
export function hanging(a: Point, b: Point, sag: number): Cable {
  const strands = new Map<number, (f: number) => Point>();
  return (f, v) => {
    let strand = strands.get(v);
    if (!strand) {
      strand = catenary(a, b, sag + v);
      strands.set(v, strand);
    }
    return strand(f);
  };
}

/** Where a layer sits along the cable, and a node's offset across it. */
const along = (col: number) => col / (LAYERS.length - 1);
const across = (col: number, row: number, spread: number) =>
  (row - ((LAYERS[col] ?? 1) - 1) / 2) * spread;

/** A flat-diagram position laid onto the cable. */
function lay(line: Cable, f: number, offset: number): Point {
  const p = line(f, offset);
  return { x: tenth(p.x), y: tenth(p.y) };
}

export interface Wiring {
  /** The mesh, as one path, so 60 lines cost one DOM node. */
  edges: string;
  /** The links from each plug into the mesh, apart so they can read as a physical cable. */
  leads: string;
  nodes: Point[];
  signals: string[];
  /**
   * The flares: one per signal per layer, with what sets its timing. A node two signals
   * share gets two, so it fires for each of them.
   */
  glows: (Point & { col: number; path: number })[];
}

/** Smoothstep: flat at both ends. */
const ease = (k: number) => k * k * (3 - 2 * k);

/**
 * The network laid along a cable. `spread` is the gap between neighbours in a layer.
 *
 * `flowing` is for slack cable. A link that eases from one strand to the next arrives at a
 * node running along the strand, so a line passes through the node without a corner, the
 * way wire does. Taut, straight links are the network's own look, so they stay.
 */
export function wire(line: Cable, spread: number, flowing = false): Wiring {
  /** One link between neighbouring layers, bent to follow the cable, without its move-to. */
  const link = (col: number, from: number, to: number): string => {
    const start = along(col);
    const end = along(col + 1);
    const a = across(col, from, spread);
    const b = across(col + 1, to, spread);
    let d = "";
    for (let i = 1; i <= SEGMENTS; i++) {
      const k = i / SEGMENTS;
      const p = lay(line, start + (end - start) * k, a + (b - a) * (flowing ? ease(k) : k));
      d += `L${p.x} ${p.y}`;
    }
    return d;
  };
  const moveTo = (col: number, row: number) => {
    const p = lay(line, along(col), across(col, row, spread));
    return `M${p.x} ${p.y}`;
  };

  const links = LAYERS.slice(1).map((n, col) =>
    Array.from({ length: LAYERS[col] ?? 0 }, (_, from) =>
      Array.from({ length: n }, (_, to) => moveTo(col, from) + link(col, from, to)).join(""),
    ).join(""),
  );
  const leads = `${links[0]}${links.at(-1)}`;
  const edges = links.slice(1, -1).join("");

  const nodes = LAYERS.flatMap((n, col) =>
    Array.from({ length: n }, (_, row) => lay(line, along(col), across(col, row, spread))),
  );

  const signals = PATHS.map(
    (rows) =>
      moveTo(0, rows[0] ?? 0) +
      rows
        .slice(1)
        .map((to, i) => link(i, rows[i] ?? 0, to))
        .join(""),
  );

  const glows = PATHS.flatMap((rows, path) =>
    rows.map((row, col) => ({ ...lay(line, along(col), across(col, row, spread)), col, path })),
  );

  return { edges, leads, nodes, signals, glows };
}

/**
 * One signal is a comet, not a dash (the user's request, 2026-11-05: plain dashes looked
 * like lines moving). A stroke can't fade along a curved path, so it's built from stacked
 * dashes that share a leading edge: the short ones are thick and bright, the long ones thin
 * and faint, and together they taper to nothing. Shares of PULSE, widest and softest first.
 * The bloom stands in for a blur filter, which would repaint on every frame.
 */
export const COMET = [
  { share: 0.42, width: 5, opacity: 0.1, hot: false },
  { share: 1, width: 0.5, opacity: 0.14, hot: false },
  { share: 0.74, width: 0.7, opacity: 0.18, hot: false },
  { share: 0.52, width: 0.9, opacity: 0.26, hot: false },
  { share: 0.32, width: 1.1, opacity: 0.42, hot: false },
  { share: 0.16, width: 1.4, opacity: 0.8, hot: false },
  { share: 0.05, width: 1.9, opacity: 1, hot: true },
].map(({ share, ...layer }) => ({ ...layer, length: round(share * PULSE) }));

/**
 * A comet layer's stroke-dashoffset: hold, forward, hold, back, hold.
 *
 * The two passes pin different edges of the dash, because the bright end has to lead. Going
 * forward that's the dash's far edge, so a dash of any length sits at `length - head`. Coming
 * back it's the near edge, so it sits at `-lead`. The switch happens in the holds, with every
 * dash off the end of the path, so nothing visibly jumps.
 */
export function pulseTrack(length: number): Track {
  const reach = 1 + PULSE + CLEAR;
  return {
    times: [0, HOLD, 0.5 - HOLD, 0.5 + HOLD, 1 - HOLD, 1],
    values: [
      length + CLEAR,
      length + CLEAR,
      length - reach,
      -1 - CLEAR,
      reach - 1,
      length + CLEAR,
    ].map(round),
  };
}
/** The dash pattern: one dash, and a gap too long for the next to reach the path. */
export const pulseDash = (length: number) => `${length} 3`;
/** keySplines for pulseTrack: still, eased, still, eased, still. */
export const PULSE_SPLINES = ["0 0 1 1", EASE, "0 0 1 1", EASE, "0 0 1 1"].join(";");

/** When the leading edge reaches a fraction `f` of the way along its pass, inverting the smoothstep. */
function reachedAt(f: number): number {
  const travelled = (f + CLEAR) / (1 + PULSE + 2 * CLEAR);
  const x = 0.5 - Math.sin(Math.asin(1 - 2 * travelled) / 3);
  return HOLD + x * (0.5 - 2 * HOLD);
}

/**
 * A node's flare: it fires as the leading edge arrives, on each pass, and dies away. The two
 * end layers stay lit through the hold, until the signal leaves them again.
 */
export function glowTrack(col: number): Track {
  const last = LAYERS.length - 1;
  const at = reachedAt(col / last);
  const back = 0.5 + reachedAt(1 - col / last);
  if (col === 0) {
    return {
      times: [0, at, at + DECAY, back - ATTACK, back, 1].map(round),
      values: [1, 1, 0, 0, 1, 1],
    };
  }
  if (col === last) {
    return {
      times: [0, at - ATTACK, at, back, back + DECAY, 1].map(round),
      values: [0, 0, 1, 1, 0, 0],
    };
  }
  return {
    times: [0, at - ATTACK, at, at + DECAY, back - ATTACK, back, back + DECAY, 1].map(round),
    values: [0, 0, 1, 0, 0, 1, 0, 0],
  };
}

/** A signal's head start, in seconds, as a negative SMIL begin. Keeps the loop seamless. */
export const beginOf = (path: number) => `${round(-path * STAGGER * PERIOD_S)}s`;
