import {
  type FolderState,
  initialState,
  keyTarget,
  scoreCount,
  select,
  type TabId,
  tabFromHash,
} from "../lib/folder";

// The DOM half of the folder (Folder.astro). The rules live in lib/folder.ts; this
// file only draws a state and runs the three motions: the cover opening, the body
// growing to fit the sheet, and one divider coming forward over another.

const OPEN_MS = 950;
const GROW_MS = 520;
const SWAP_OUT_MS = 170;
const SWAP_IN_MS = 340;
const EASE_LID = "cubic-bezier(0.5, 0, 0.18, 1)";
const EASE = "cubic-bezier(0.25, 0.8, 0.25, 1)";

export function initFolder(root: HTMLElement): void {
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel) as T;
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  const sheets = new Map(
    [...root.querySelectorAll<HTMLElement>("[data-sheet]")].map((s) => [
      s.dataset.sheet as TabId,
      s,
    ]),
  );
  const body = q<HTMLElement>("[data-body]");
  const sheetBox = q<HTMLElement>("[data-sheets]");
  const shell = q<HTMLElement>("[data-shell]");
  const cover = q<HTMLElement>("[data-cover]");
  const hinge = q<HTMLElement>("[data-hinge]");
  const frontScores = root.querySelector<HTMLElement>(".front-scores");
  const pages = JSON.parse(root.dataset.pages ?? "{}") as Record<TabId, number>;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const still = () => reduce.matches;

  let state: FolderState = initialState(location.hash);
  let busy: Promise<void> = Promise.resolve();

  // ── Drawing a state (no motion) ─────────────────────────────────────────────
  function drawTabs(s: FolderState): void {
    root.dataset.active = s.active;
    for (const tab of tabs) {
      const id = tab.dataset.tab as TabId;
      const on = id === s.active;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      // Back-to-front order decides which tab overlaps which; the one in front is on top.
      tab.style.setProperty("--z", String(s.order.indexOf(id) + 1));
    }
    const n = String(scoreCount(pages[s.active] ?? 1));
    hinge.dataset.scores = n;
    if (frontScores) frontScores.dataset.scores = n;
  }

  function showSheet(id: TabId): void {
    for (const [key, el] of sheets) el.hidden = key !== id;
  }

  function drawOpen(): void {
    root.dataset.state = "open";
    body.inert = false;
    cover.inert = false;
  }

  // ── Motions ─────────────────────────────────────────────────────────────────
  const run = (el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) =>
    el.animate(frames, { fill: "none", ...opts }).finished.catch(() => undefined);

  async function open(): Promise<void> {
    root.dataset.state = "opening";
    cover.inert = true;
    if (!still()) {
      const lidH = cover.offsetHeight;
      const hingeH = Number.parseFloat(getComputedStyle(root).getPropertyValue("--hinge-h")) || 18;
      const front = cover.querySelector(".cover-front .shade");
      const inside = cover.querySelector(".cover-inside .shade");
      await Promise.all([
        // The lid swings toward the reader and down over its bottom hinge.
        // It lands one hinge-width lower: the fold opens up between back and front.
        run(
          cover,
          [
            { transform: "rotateX(0deg)" },
            { transform: `translateY(${hingeH}px) rotateX(-180deg)` },
          ],
          {
            duration: OPEN_MS,
            easing: EASE_LID,
          },
        ),
        // Room for it to land in, opening up under the folder as it falls (the hinge
        // itself is already in flow once the state is "opening").
        run(shell, [{ paddingBottom: "0px" }, { paddingBottom: `${lidH}px` }], {
          duration: OPEN_MS,
          easing: EASE_LID,
        }),
        // Light: the outside darkens as it turns away, the inside brightens as it lands.
        front &&
          run(front, [{ opacity: 0 }, { opacity: 0.32, offset: 0.5 }, { opacity: 0.32 }], {
            duration: OPEN_MS,
            easing: EASE_LID,
          }),
        inside &&
          run(inside, [{ opacity: 0.3 }, { opacity: 0.3, offset: 0.5 }, { opacity: 0 }], {
            duration: OPEN_MS,
            easing: EASE_LID,
          }),
      ]);
    }
    // Flat on the desk: from here the inside is laid out normally, under the hinge.
    const fromH = body.offsetHeight;
    drawOpen();
    if (!still()) {
      const toH = body.offsetHeight;
      await run(body, [{ height: `${fromH}px` }, { height: `${toH}px` }], {
        duration: GROW_MS,
        easing: EASE,
      });
    }
  }

  async function swap(from: TabId, to: TabId): Promise<void> {
    const outgoing = sheets.get(from);
    const incoming = sheets.get(to);
    if (!outgoing || !incoming || outgoing === incoming) return;
    if (still()) {
      showSheet(to);
      return;
    }
    const fromH = sheetBox.offsetHeight;
    // The old sheet stays where it was, out of flow, while the new one takes its place.
    Object.assign(outgoing.style, { position: "absolute", inset: "0 0 auto 0" });
    incoming.hidden = false;
    const toH = sheetBox.offsetHeight;
    sheetBox.style.overflow = "clip";
    // Room for what hangs off a sheet's edge (the paperclip) while the swap clips.
    sheetBox.style.overflowClipMargin = "48px";
    const raised = tabs.find((t) => t.dataset.tab === to);
    await Promise.all([
      run(
        outgoing,
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translateY(10px) scale(0.995)" },
        ],
        {
          duration: SWAP_OUT_MS,
          easing: "ease-in",
          fill: "forwards",
        },
      ),
      run(
        incoming,
        [
          { opacity: 0, transform: "translateY(-12px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: SWAP_IN_MS, delay: SWAP_OUT_MS * 0.5, easing: EASE, fill: "backwards" },
      ),
      run(sheetBox, [{ height: `${fromH}px` }, { height: `${toH}px` }], {
        duration: SWAP_OUT_MS * 0.5 + SWAP_IN_MS,
        easing: EASE,
      }),
      // The chosen tab rises off the stack and settles in front.
      raised &&
        run(
          raised,
          [
            { transform: "translateY(4px)" },
            { transform: "translateY(-3px)", offset: 0.55 },
            { transform: "none" },
          ],
          { duration: 380, easing: EASE },
        ),
    ]);
    outgoing.hidden = true;
    outgoing.getAnimations().forEach((a) => {
      a.cancel();
    });
    outgoing.removeAttribute("style");
    sheetBox.style.removeProperty("overflow");
    sheetBox.style.removeProperty("overflow-clip-margin");
  }

  // ── Selecting ───────────────────────────────────────────────────────────────
  function choose(tab: TabId, { focus = false, push = true } = {}): void {
    const before = state;
    const after = select(before, tab);
    if (after === before) return;
    state = after;
    // Motions queue up, so fast clicking never leaves two sheets half-drawn.
    busy = busy.then(async () => {
      drawTabs(after);
      if (!before.open) {
        showSheet(after.active);
        await open();
      } else {
        await swap(before.active, after.active);
      }
    });
    if (push) history.replaceState(null, "", `#${tab}`);
    if (focus) tabs.find((t) => t.dataset.tab === tab)?.focus({ preventScroll: true });
    // Switching from far down a long sheet: bring the top of the folder back into view.
    if (before.open && root.getBoundingClientRect().top < 0) {
      root.scrollIntoView({ behavior: still() ? "auto" : "smooth", block: "start" });
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => choose(tab.dataset.tab as TabId));
    tab.addEventListener("keydown", (e) => {
      const target = keyTarget(tab.dataset.tab as TabId, e.key);
      if (!target) return;
      e.preventDefault();
      choose(target, { focus: true });
    });
  }
  q<HTMLButtonElement>("[data-open]").addEventListener("click", () =>
    choose(state.active, { focus: true }),
  );
  window.addEventListener("hashchange", () => {
    const tab = tabFromHash(location.hash);
    if (tab) choose(tab, { push: false });
  });

  // ── First paint ─────────────────────────────────────────────────────────────
  drawTabs(state);
  showSheet(state.active);
  if (state.open) drawOpen();
  else body.inert = true;
}
