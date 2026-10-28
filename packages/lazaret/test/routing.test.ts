import { describe, expect, it } from "vitest";
import { compilePattern, matchPattern, normalizePath } from "../src";
import { fillTemplate } from "../src/routing/matcher";
import { encodePath } from "../src/routing/normalize";

// Paths as the Worker sees them, i.e. after WHATWG URL parsing.
const pathOf = (raw: string) => new URL(raw, "https://edge.test").pathname;

describe("normalizePath", () => {
  it.each([
    ["/api/tickets", "/api/tickets", []],
    ["/api/tickets/", "/api/tickets", []],
    ["/api//tickets", "/api/tickets", ["empty_segment"]],
    ["/api/..%2fadmin", "/admin", ["encoded_separator", "dot_segment"]],
    ["/api/%2e%2e/admin", "/admin", []], // WHATWG URL resolves %2e%2e itself
    ["/%61dmin", "/admin", []],
    ["/api/%252e%252e/admin", "/api/%2e%2e/admin", ["double_encoding"]],
    ["/api/%E0%A4%A", "/api/%E0%A4%A", ["malformed_encoding"]],
  ])("%s → %s", (raw, expected, anomalies) => {
    const norm = normalizePath(pathOf(raw));
    expect(norm.path).toBe(expected);
    expect(norm.anomalies.sort()).toEqual([...anomalies].sort());
  });

  it("treats backslashes as separators (as IIS-style origins do)", () => {
    const norm = normalizePath("/api\\..\\admin");
    expect(norm.path).toBe("/admin");
    expect(norm.anomalies).toContain("backslash");
  });

  it("flags null bytes", () => {
    expect(normalizePath("/api/x%00.php").anomalies).toContain("null_byte");
  });

  it("re-encodes segments for forwarding", () => {
    expect(encodePath(["files", "a b?c"])).toBe("/files/a%20b%3Fc");
  });
});

describe("route patterns", () => {
  const segs = (p: string) => normalizePath(p).segments;

  it("captures params and keeps their case", () => {
    const p = compilePattern("PATCH /api/tickets/:id");
    expect(matchPattern(p, "PATCH", segs("/api/tickets/AbC123"))).toEqual({ id: "AbC123" });
    expect(matchPattern(p, "POST", segs("/api/tickets/1"))).toBeNull();
    expect(matchPattern(p, "PATCH", segs("/api/tickets/1/replies"))).toBeNull();
  });

  it("matches literals case-insensitively so /Admin can't dodge a BLOCK", () => {
    const p = compilePattern("* /admin/*");
    expect(matchPattern(p, "GET", segs("/ADMIN/users"))).toEqual({});
  });

  it("lets a trailing * cover the bare prefix too", () => {
    const p = compilePattern("/admin/*");
    expect(matchPattern(p, "DELETE", segs("/admin"))).toEqual({});
    expect(matchPattern(p, "DELETE", segs("/administrator"))).toBeNull();
  });

  it("supports method lists and single-segment wildcards", () => {
    const p = compilePattern("GET|HEAD /api/*/status");
    expect(matchPattern(p, "HEAD", segs("/api/tickets/status"))).toEqual({});
    expect(matchPattern(p, "GET", segs("/api/a/b/status"))).toBeNull();
  });

  it("rejects malformed patterns", () => {
    expect(() => compilePattern("GET api/x")).toThrow(/must start with/);
    expect(() => compilePattern("GET /a/:id/:id")).toThrow(/duplicate/);
    expect(() => compilePattern("G3T /a")).toThrow(/method/);
  });

  it("fills resource templates from params", () => {
    expect(fillTemplate("ticket:{id}", { id: "42" })).toBe("ticket:42");
  });
});
