import { describe, expect, it } from "vitest";
import { initialState, keyTarget, scoreCount, select, TABS, tabFromHash } from "../src/lib/folder";

// The folder's rules (src/lib/folder.ts): closed until opened, one-way open, the chosen
// divider in front, WAI-ARIA keys, and deep links.

describe("folder", () => {
  it("starts closed on Profile without a deep link", () => {
    const s = initialState("");
    expect(s.open).toBe(false);
    expect(s.active).toBe("profile");
    expect(s.order.at(-1)).toBe("profile");
  });

  it("opens straight onto a deep-linked tab", () => {
    const s = initialState("#Projects");
    expect(s).toMatchObject({ open: true, active: "projects" });
    expect(s.order.at(-1)).toBe("projects");
    expect(initialState("#nope").open).toBe(false);
  });

  it("selecting opens the folder, and it never closes again", () => {
    let s = initialState("");
    s = select(s, "profile");
    expect(s.open).toBe(true);
    for (const tab of ["experience", "projects", "profile", "projects"] as const) {
      s = select(s, tab);
      expect(s.open).toBe(true);
      expect(s.active).toBe(tab);
    }
  });

  it("brings the chosen divider to the front and keeps every tab once", () => {
    let s = select(initialState(""), "experience");
    s = select(s, "projects");
    expect(s.order.at(-1)).toBe("projects");
    expect(s.order.at(-2)).toBe("experience");
    expect([...s.order].sort()).toEqual([...TABS].sort());
  });

  it("re-selecting the open tab is a no-op (same object, no motion)", () => {
    const s = select(initialState(""), "profile");
    expect(select(s, "profile")).toBe(s);
  });

  it("arrow keys wrap; Home and End jump; other keys do nothing", () => {
    expect(keyTarget("profile", "ArrowLeft")).toBe("experience");
    expect(keyTarget("experience", "ArrowRight")).toBe("profile");
    expect(keyTarget("projects", "Home")).toBe("profile");
    expect(keyTarget("projects", "End")).toBe("experience");
    expect(keyTarget("projects", "Enter")).toBeNull();
  });

  it("reads hashes case-insensitively and rejects unknown ones", () => {
    expect(tabFromHash("#experience")).toBe("experience");
    expect(tabFromHash("EXPERIENCE")).toBe("experience");
    expect(tabFromHash("#demo")).toBeNull();
  });

  it("scores one crease per page, between one and six", () => {
    expect(scoreCount(0)).toBe(1);
    expect(scoreCount(3)).toBe(3);
    expect(scoreCount(40)).toBe(6);
  });
});
