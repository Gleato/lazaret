// The paper-clipped page stacks (Projects, Edu x Exp): one page shows at a time and
// the arrows turn it. Arrows are dark only when there is a page to turn to (the board:
// "gray if none exist, only dark if can move"). Pure, tested in test/pager.test.ts.

export interface PagerView {
  index: number;
  count: number;
  canPrev: boolean;
  canNext: boolean;
  label: string;
}

export function pagerView(index: number, count: number): PagerView {
  const n = Math.max(1, Math.floor(count));
  const i = clamp(Math.floor(index), 0, n - 1);
  return { index: i, count: n, canPrev: i > 0, canNext: i < n - 1, label: `Page ${i + 1} of ${n}` };
}

/** Turn by `step` pages; stays put at either end instead of wrapping, like paper. */
export function turn(index: number, count: number, step: number): number {
  return pagerView(index + step, count).index;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
