import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, count, loginAs } from "./helpers";

// The public demo's hourly reset (src/seed.ts): everything visitors wrote goes, the
// seed comes back exactly as the migration made it. In its own file, because it wipes
// the shared test database.

const TABLES = ["accounts", "tickets", "replies", "attachments", "credits", "api_keys"];
const dump = async () =>
  Object.fromEntries(
    await Promise.all(
      TABLES.map(async (t) => [
        t,
        (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()).results,
      ]),
    ),
  );

describe("POST /admin/reset", () => {
  it("restores a freshly migrated database", async () => {
    const fresh = await dump();
    const mara = await loginAs("mara");
    await call("POST", "/api/tickets", {
      token: mara,
      body: { subject: "Visitor ticket", body: "written during the hour" },
    });
    await call("PATCH", "/api/me", { token: mara, body: { display_name: "Changed" } });
    expect(await count("tickets")).toBeGreaterThan(2);

    const res = await call("POST", "/admin/reset");
    expect(res.status).toBe(200);
    expect(await dump()).toEqual(fresh);
    expect(await count("auth_tokens")).toBe(0); // sessions end with the hour
  });

  it("is refused without Lazaret's signature", async () => {
    expect((await call("POST", "/admin/reset", { unsigned: true })).status).toBe(403);
  });
});
