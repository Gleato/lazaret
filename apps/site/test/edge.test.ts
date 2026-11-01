import { describe, expect, it } from "vitest";
import worker from "../edge/worker";

// gleator.com's edge worker (edge/worker.ts): www goes to the apex, everything else
// is served from the static build untouched.

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
});
