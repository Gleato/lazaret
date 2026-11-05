import { describe, expect, it, vi } from "vitest";
import { shareLink } from "../src/lib/share";

const URL_ = "https://gleator.com/";
const abort = () => Object.assign(new Error("closed"), { name: "AbortError" });

describe("shareLink", () => {
  it("uses the share sheet on touch devices", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const copy = vi.fn().mockResolvedValue(undefined);
    expect(await shareLink(URL_, { share, copy, touch: true })).toBe("shared");
    expect(share).toHaveBeenCalledWith({ url: URL_ });
    expect(copy).not.toHaveBeenCalled();
  });

  it("copies on desktop even when the browser has a share API", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const copy = vi.fn().mockResolvedValue(undefined);
    expect(await shareLink(URL_, { share, copy, touch: false })).toBe("copied");
    expect(share).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledWith(URL_);
  });

  it("stays quiet when the visitor closes the share sheet", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    const share = vi.fn().mockRejectedValue(abort());
    expect(await shareLink(URL_, { share, copy, touch: true })).toBe("cancelled");
    expect(copy).not.toHaveBeenCalled();
  });

  it("falls back to copying when sharing is blocked", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    const share = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    expect(await shareLink(URL_, { share, copy, touch: true })).toBe("copied");
  });

  it("copies on touch devices without a share API", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    expect(await shareLink(URL_, { copy, touch: true })).toBe("copied");
  });

  it("reports failure when the clipboard refuses or is missing", async () => {
    const copy = vi.fn().mockRejectedValue(new Error("denied"));
    expect(await shareLink(URL_, { copy, touch: false })).toBe("failed");
    expect(await shareLink(URL_, { touch: false })).toBe("failed");
  });
});
