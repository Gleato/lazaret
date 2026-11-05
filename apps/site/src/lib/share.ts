// The routing slip's "Share link" button (src/home/CoverInside.astro). It replaced three
// role checkboxes on 2026-11-05: they all would have done the same thing, so one button
// says it honestly. Touch devices get the native share sheet; everywhere else copies,
// because desktop share menus are patchy and a copied link goes anywhere.
// The decision is pure and tested (test/share.test.ts).

export type ShareResult = "shared" | "copied" | "cancelled" | "failed";

export interface ShareDeps {
  /** navigator.share, when the browser has it. */
  share?: (data: { url: string }) => Promise<void>;
  /** navigator.clipboard.writeText, when the browser allows it. */
  copy?: (text: string) => Promise<void>;
  /** A touch-first device, where the share sheet is the natural route. */
  touch: boolean;
}

export async function shareLink(
  url: string,
  { share, copy, touch }: ShareDeps,
): Promise<ShareResult> {
  if (touch && share) {
    try {
      await share({ url });
      return "shared";
    } catch (err) {
      // Closing the sheet is a choice, not a failure: stay quiet. Anything else
      // (a blocked share, say) still has the clipboard to fall back on.
      if (err instanceof Error && err.name === "AbortError") return "cancelled";
    }
  }
  if (!copy) return "failed";
  try {
    await copy(url);
    return "copied";
  } catch {
    return "failed";
  }
}

/** How long the confirmation stays on the button before it reads "Share link" again. */
export const CONFIRM_MS = 2200;

export function initShare(button: HTMLButtonElement): void {
  const label = button.querySelector<HTMLElement>("[data-share-label]");
  const url = button.dataset.url;
  if (!label || !url) return;
  const idle = label.textContent ?? "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  button.addEventListener("click", async () => {
    const result = await shareLink(url, {
      share: navigator.share?.bind(navigator),
      copy: navigator.clipboard?.writeText.bind(navigator.clipboard),
      touch: matchMedia("(pointer: coarse)").matches,
    });
    if (result !== "copied" && result !== "failed") return;
    clearTimeout(timer);
    button.dataset.state = result;
    // On failure the address itself is the way out: it can be read and retyped.
    label.textContent = result === "copied" ? "Link copied" : url.replace(/^https?:\/\/|\/$/g, "");
    timer = setTimeout(() => {
      delete button.dataset.state;
      label.textContent = idle;
    }, CONFIRM_MS);
  });
}
