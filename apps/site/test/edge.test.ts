import { describe, expect, it } from "vitest";
import { EDGE_HEADERS } from "../csp";
import worker from "../edge/worker";

// gleator.com's edge worker (edge/worker.ts): www goes to the apex, everything else
// is served from the static build with the security headers added.

const assets = { fetch: async (r: Request) => new Response(`asset ${new URL(r.url).pathname}`) };
const env = { ASSETS: assets };

describe("site edge worker", () => {
  it("301s www to the apex, keeping path and query", async () => {
    const res = await worker.fetch(new Request("https://www.gleator.com/a/b?x=1"), env);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://gleator.com/a/b?x=1");
  });

  it("serves the apex from static assets", async () => {
    const res = await worker.fetch(new Request("https://gleator.com/evals"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset /evals");
  });

  it("adds the security headers, keeping the asset's own", async () => {
    const typed = {
      fetch: async () =>
        new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } }),
    };
    const res = await worker.fetch(new Request("https://gleator.com/nope"), { ASSETS: typed });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html");
    for (const [name, value] of Object.entries(EDGE_HEADERS))
      expect(res.headers.get(name)).toBe(value);
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });
});
