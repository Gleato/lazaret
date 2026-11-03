// The folder on the home page (src/home/Folder.astro): which divider is in front,
// whether the cover has been opened, and the keyboard and URL rules around them.
// The state is a plain value and every rule is a pure function, so the behaviour is
// unit-tested in Node (test/folder.test.ts); the DOM half below only draws it.
//
// Rules the user set (2026-11-02):
//   - the folder starts closed, with a hint to open it;
//   - opening it is one-way for the visit: switching tabs never closes it again;
//   - the three tabs stay where they are; the chosen one comes to the front.

export const TABS = ["profile", "projects", "experience"] as const;
export type TabId = (typeof TABS)[number];

export interface FolderState {
  open: boolean;
  active: TabId;
  /** Stacking order, back to front. The last one is the divider in front. */
  order: TabId[];
}

export function initialState(hash: string): FolderState {
  const fromHash = tabFromHash(hash);
  // A deep link (#projects) is someone who already knows what's inside: open at once.
  const active = fromHash ?? "profile";
  return { open: fromHash !== null, active, order: bringToFront([...TABS].reverse(), active) };
}

export function tabFromHash(hash: string): TabId | null {
  const id = hash.replace(/^#/, "").toLowerCase();
  return (TABS as readonly string[]).includes(id) ? (id as TabId) : null;
}

/** Selecting a tab opens the folder (if it wasn't) and brings that divider forward. */
export function select(state: FolderState, tab: TabId): FolderState {
  if (state.open && state.active === tab) return state;
  return { open: true, active: tab, order: bringToFront(state.order, tab) };
}

function bringToFront(order: readonly TabId[], tab: TabId): TabId[] {
  return [...order.filter((t) => t !== tab), tab];
}

/** WAI-ARIA tabs keys: arrows wrap, Home and End jump. Null for any other key. */
export function keyTarget(current: TabId, key: string): TabId | null {
  const i = TABS.indexOf(current);
  const n = TABS.length;
  switch (key) {
    case "ArrowRight":
      return TABS[(i + 1) % n] ?? null;
    case "ArrowLeft":
      return TABS[(i - 1 + n) % n] ?? null;
    case "Home":
      return TABS[0];
    case "End":
      return TABS[n - 1] ?? null;
    default:
      return null;
  }
}

/**
 * The expansion scores pressed into the fold. A real folder has a few score lines so
 * it can fold flat around a thicker stack; here there is one per sheet the open tab
 * holds, so the crease itself says how many pages are inside.
 */
export function scoreCount(pages: number): number {
  return Math.max(1, Math.min(6, Math.floor(pages)));
}
