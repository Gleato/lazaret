import { describe, expect, it } from "vitest";
import { ANALYTICS, astroCsp, TURNSTILE } from "../csp";

// The policy itself (csp.mjs): what each page may load and connect to.

describe("site CSP", () => {
  const prod = astroCsp("https://demo.gleator.com");
  const directive = (name: string) => prod.directives.find((d) => d.startsWith(`${name} `));

  it("connects only to itself and the demo, over HTTPS and its WebSocket", () => {
    expect(directive("connect-src")).toBe(
      `connect-src 'self' https://demo.gleator.com wss://demo.gleator.com ${ANALYTICS.report}`,
    );
  });

  it("uses ws: for a plain-HTTP local demo", () => {
    expect(astroCsp("http://localhost:8787").directives).toContain(
      `connect-src 'self' http://localhost:8787 ws://localhost:8787 ${ANALYTICS.report}`,
    );
  });

  it("allows scripts only from the site (hashed inline), Turnstile and Cloudflare's beacon", () => {
    expect(prod.scriptDirective.resources).toEqual(["'self'", TURNSTILE, ANALYTICS.script]);
    expect(astroCsp("https://demo.gleator.com", ["sha256-abc="]).scriptDirective.hashes).toEqual([
      "sha256-abc=",
    ]);
    expect(directive("frame-src")).toBe(`frame-src ${TURNSTILE}`);
  });

  it("allows inline style attributes but not unhashed <style> elements", () => {
    expect(prod.styleDirective.resources).toEqual([
      "'self'",
      { resource: "'unsafe-inline'", kind: "attribute" },
    ]);
  });

  it("shuts the usual side doors", () => {
    expect(prod.directives).toEqual(
      expect.arrayContaining(["default-src 'self'", "object-src 'none'", "base-uri 'self'"]),
    );
  });
});
