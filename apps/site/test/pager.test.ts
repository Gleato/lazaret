import { describe, expect, it } from "vitest";
import { pagerView, turn } from "../src/lib/pager";

describe("pager", () => {
  it("with one page, both arrows are grey: Page 1 of 1", () => {
    expect(pagerView(0, 1)).toEqual({
      index: 0,
      count: 1,
      canPrev: false,
      canNext: false,
      label: "Page 1 of 1",
    });
  });

  it("arrows are dark only when there is a page that way", () => {
    expect(pagerView(0, 3)).toMatchObject({ canPrev: false, canNext: true });
    expect(pagerView(1, 3)).toMatchObject({ canPrev: true, canNext: true, label: "Page 2 of 3" });
    expect(pagerView(2, 3)).toMatchObject({ canPrev: true, canNext: false });
  });

  it("turning stops at either end instead of wrapping", () => {
    expect(turn(0, 3, -1)).toBe(0);
    expect(turn(2, 3, 1)).toBe(2);
    expect(turn(1, 3, 1)).toBe(2);
  });

  it("clamps nonsense input", () => {
    expect(pagerView(9, 0)).toMatchObject({ index: 0, count: 1 });
  });
});
