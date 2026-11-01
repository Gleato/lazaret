// Geometry for the Memory panel's learning-curve charts (M7.1). Pure, so it is unit
// tested and rendered at build time as plain SVG: no chart library, nothing to load.
//
// One chart, one measure, one axis (never two scales on one plot). Marks follow the
// dataviz specs: 2px lines, r=4 markers with a 2px paper ring, columns at most 24px
// wide with a 4px rounded cap and a square foot on the baseline, hairline grid.

export interface CurvePoint {
  /** Window number; 0 is "before any learning" where a chart has a baseline. */
  x: number;
  /** Axis label for the point, e.g. "1" or "before". */
  label: string;
  value: number | null;
  /** The value as a reader sees it, e.g. "283" or "31%". */
  display: string;
}

export const VIEW = { w: 320, h: 176, left: 34, right: 10, top: 22, bottom: 26 } as const;

/** A round axis maximum at or above `max`: 1, 2, 2.5, 5 or 10 times a power of ten. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

export interface Plot {
  ticks: { y: number; label: string }[];
  marks: { cx: number; cy: number; baseY: number; point: CurvePoint }[];
  /** The 2px line through the points that have a value (lines only). */
  path: string;
  slot: number;
}

export function plot(points: CurvePoint[], yMax: number, fmt: (v: number) => string): Plot {
  const { w, h, left, right, top, bottom } = VIEW;
  const innerW = w - left - right;
  const innerH = h - top - bottom;
  const slot = innerW / Math.max(points.length, 1);
  const y = (v: number) => top + innerH - (Math.min(v, yMax) / yMax) * innerH;
  const marks = points.map((p, i) => ({
    cx: left + slot * (i + 0.5),
    cy: p.value === null ? y(0) : y(p.value),
    baseY: y(0),
    point: p,
  }));
  const path = marks
    .filter((m) => m.point.value !== null)
    .map((m, i) => `${i ? "L" : "M"}${m.cx.toFixed(1)},${m.cy.toFixed(1)}`)
    .join(" ");
  const ticks = [0, 0.5, 1].map((f) => ({ y: y(yMax * f), label: fmt(yMax * f) }));
  return { ticks, marks, path, slot };
}

/**
 * A column from the baseline up to `top`, at most 24px wide, with a 4px rounded cap
 * and a square foot. A zero-height column draws nothing (its value is still in the
 * tooltip and the table).
 */
export function columnPath(cx: number, top: number, base: number, slot: number): string {
  const width = Math.min(24, slot * 0.6);
  const height = base - top;
  if (height <= 0.5) return "";
  const r = Math.min(4, width / 2, height);
  const x0 = cx - width / 2;
  const x1 = cx + width / 2;
  return [
    `M${x0.toFixed(1)},${base.toFixed(1)}`,
    `V${(top + r).toFixed(1)}`,
    `Q${x0.toFixed(1)},${top.toFixed(1)} ${(x0 + r).toFixed(1)},${top.toFixed(1)}`,
    `H${(x1 - r).toFixed(1)}`,
    `Q${x1.toFixed(1)},${top.toFixed(1)} ${x1.toFixed(1)},${(top + r).toFixed(1)}`,
    `V${base.toFixed(1)}`,
    "Z",
  ].join(" ");
}
