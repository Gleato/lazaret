import { describe, expect, it } from "vitest";
import { turnstileApi } from "../src/lib/demo-client";

// A `<div id="turnstile">` becomes `window.turnstile` (named element access). The loader
// must not mistake it for Cloudflare's API: that bug broke the long page's bot check.

describe("turnstileApi", () => {
  it("ignores an element that happens to be called turnstile", () => {
    expect(turnstileApi({ turnstile: { tagName: "DIV" } })).toBeNull();
    expect(turnstileApi({})).toBeNull();
  });

  it("returns the real API once Cloudflare's script has loaded", () => {
    const api = { render: () => undefined };
    expect(turnstileApi({ turnstile: api })).toBe(api);
  });
});
