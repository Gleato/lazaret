// The Profile sheet's photo strip. Scrolling is native (scroll-snap), so a thumb swipe
// is the browser's own momentum scroll; this file adds what native scrolling lacks for
// a mouse: drag to scroll, arrow buttons that step one photo, and arrow keys.
// The geometry is pure and tested (test/photo-strip.test.ts).

/** The photo whose left edge is nearest the scroll position. */
export function nearestIndex(scrollLeft: number, offsets: readonly number[]): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  offsets.forEach((o, i) => {
    const d = Math.abs(o - scrollLeft);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

/** Where to scroll to step `dir` photos from here, clamped to what can scroll. */
export function stepTarget(
  scrollLeft: number,
  offsets: readonly number[],
  dir: -1 | 1,
  maxScroll: number,
): number {
  const i = nearestIndex(scrollLeft, offsets);
  const next = offsets[Math.min(offsets.length - 1, Math.max(0, i + dir))] ?? 0;
  return Math.min(maxScroll, Math.max(0, next));
}

/** A press only counts as a drag once it moves this far; below it, it's a click. */
export const DRAG_THRESHOLD_PX = 6;

export function initPhotoStrip(root: HTMLElement): void {
  const track = root.querySelector<HTMLElement>("[data-strip-track]");
  const prev = root.querySelector<HTMLButtonElement>("[data-strip-prev]");
  const next = root.querySelector<HTMLButtonElement>("[data-strip-next]");
  const count = root.querySelector<HTMLElement>("[data-strip-count]");
  if (!track || !prev || !next) return;
  const items = [...track.children] as HTMLElement[];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");

  const offsets = () => items.map((el) => el.offsetLeft - track.offsetLeft);
  const max = () => track.scrollWidth - track.clientWidth;

  const sync = () => {
    const m = max();
    prev.disabled = track.scrollLeft <= 2;
    next.disabled = track.scrollLeft >= m - 2;
    if (count)
      count.textContent = `${nearestIndex(track.scrollLeft, offsets()) + 1} of ${items.length}`;
  };
  const go = (dir: -1 | 1) =>
    track.scrollTo({
      left: stepTarget(track.scrollLeft, offsets(), dir, max()),
      behavior: reduce.matches ? "auto" : "smooth",
    });

  prev.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));
  track.addEventListener("scroll", () => requestAnimationFrame(sync), { passive: true });
  track.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    go(e.key === "ArrowLeft" ? -1 : 1);
  });
  new ResizeObserver(sync).observe(track);

  // Mouse drag. Touch and pens keep the native scroll (with its momentum); snapping is
  // switched off while dragging so the strip follows the hand, then back on to settle.
  let startX = 0;
  let startScroll = 0;
  let dragging = false;
  let moved = false;
  track.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startScroll = track.scrollLeft;
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    if (!moved) {
      moved = true;
      track.dataset.dragging = "";
    }
    track.scrollLeft = startScroll - dx;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (!moved) return;
    delete track.dataset.dragging;
    // Settle on the nearest photo, the way a flick would.
    track.scrollTo({
      left: Math.min(max(), offsets()[nearestIndex(track.scrollLeft, offsets())] ?? 0),
      behavior: reduce.matches ? "auto" : "smooth",
    });
  };
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  // A drag that ends over a photo must not count as a click on it.
  track.addEventListener(
    "click",
    (e) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
      }
    },
    true,
  );
  track.addEventListener("dragstart", (e) => e.preventDefault());
  sync();
}
