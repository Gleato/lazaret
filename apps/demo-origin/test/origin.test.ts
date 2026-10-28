import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { REPLAYED_HEADER } from "../src/dedupe";
import { call, count, loginAs } from "./helpers";

// Tidewater Support against a real local D1. Each test file gets a fresh database
// (migrations + seed), and tests within the file share it, so ids are unique per test.

let mara: string;
let theo: string;
let sam: string;
beforeAll(async () => {
  [mara, theo, sam] = await Promise.all([loginAs("mara"), loginAs("theo"), loginAs("sam")]);
});

describe("trust boundary", () => {
  it("refuses requests that don't come through Lazaret", async () => {
    const res = await call("GET", "/api/tickets", { token: mara, unsigned: true });
    expect(res.status).toBe(403);
    expect(res.json.error).toMatch(/through Lazaret/);
  });

  it("refuses a signed request whose body was swapped", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ subject: "a", body: "b" }));
    const { signRequest } = await import("@gleator/lazaret");
    const headers = await signRequest(
      {
        id: "x1",
        method: "POST",
        target: "/api/tickets",
        body,
        timestamp: Math.floor(Date.now() / 1000),
      },
      env.LAZARET_SIGNING_SECRET,
    );
    const { default: worker } = await import("../src");
    const res = await worker.fetch(
      new Request("https://tidewater.internal/api/tickets", {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${mara}` },
        body: JSON.stringify({ subject: "swapped", body: "evil" }),
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await count("tickets", "subject = 'swapped'")).toBe(0);
  });

  it("requires sign-in for API routes", async () => {
    expect((await call("GET", "/api/tickets")).status).toBe(401);
  });
});

describe("login", () => {
  it("issues a token for the seeded demo account and stores only its hash", async () => {
    const res = await call("POST", "/api/login", {
      body: { email: "MARA@tidewater.test", password: "tidewater-demo" },
    });
    expect(res.status).toBe(200);
    expect(res.json.account).toMatchObject({ id: "acct_mara", role: "customer" });
    expect(res.json.account.password_hash).toBeUndefined();
    expect(await count("auth_tokens", "token_hash = ?", res.json.token)).toBe(0);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const wrong = await call("POST", "/api/login", {
      body: { email: "mara@tidewater.test", password: "nope" },
    });
    const unknown = await call("POST", "/api/login", {
      body: { email: "nobody@tidewater.test", password: "nope" },
    });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.json).toEqual(unknown.json);
  });
});

describe("tickets", () => {
  it("uses the Lazaret entry id as the ticket id (receipt id convention)", async () => {
    const res = await call("POST", "/api/tickets", {
      token: mara,
      body: { subject: "Invoice address", body: "Please update the address on invoice 1042." },
    });
    expect(res.status).toBe(201);
    expect(res.json.ticket.id).toBe(res.id);
    expect(res.json.ticket.account_id).toBe("acct_mara");
  });

  it("dedupes a Committer re-send: same response, one row, no second side effect", async () => {
    const id = crypto.randomUUID();
    const body = { subject: "Dedupe me", body: "Sent twice by a crashing Committer." };
    const first = await call("POST", "/api/tickets", { token: mara, body, id });
    const again = await call("POST", "/api/tickets", { token: mara, body, id });
    expect(again.status).toBe(first.status);
    expect(again.json).toEqual(first.json);
    expect(again.res.headers.get(REPLAYED_HEADER)).toBe("1");
    expect(await count("tickets", "id = ?", id)).toBe(1);
  });

  it("dedupes concurrent copies of the same write", async () => {
    const id = crypto.randomUUID();
    const body = { subject: "Race", body: "Two copies at once." };
    const results = await Promise.all(
      [1, 2, 3].map(() => call("POST", "/api/tickets", { token: mara, body, id })),
    );
    expect(new Set(results.map((r) => r.status))).toEqual(new Set([201]));
    expect(await count("tickets", "id = ?", id)).toBe(1);
  });

  it("shows customers only their own tickets, and agents everyone's", async () => {
    const own = await call("GET", "/api/tickets", { token: theo });
    expect(own.json.tickets.length).toBeGreaterThan(0);
    expect(
      own.json.tickets.every((t: { account_id: string }) => t.account_id === "acct_theo"),
    ).toBe(true);
    const all = await call("GET", "/api/tickets", { token: sam });
    const owners = new Set(all.json.tickets.map((t: { account_id: string }) => t.account_id));
    expect(owners.has("acct_mara") && owners.has("acct_theo")).toBe(true);
  });

  it("answers 404, not 403, for someone else's ticket", async () => {
    expect((await call("GET", "/api/tickets/tkt_seed_1", { token: mara })).status).toBe(404);
    const view = await call("GET", "/api/tickets/tkt_seed_2", { token: mara });
    expect(view.status).toBe(200);
    expect(view.json.replies[0]).toMatchObject({ author: "Sam Rivera", author_role: "agent" });
  });

  it("validates input and records the refusal so a re-send gets the same answer", async () => {
    const id = crypto.randomUUID();
    const first = await call("POST", "/api/tickets", { token: mara, body: { subject: "" }, id });
    expect(first.status).toBe(400);
    const again = await call("POST", "/api/tickets", {
      token: mara,
      body: { subject: "" },
      id,
    });
    expect(again.json).toEqual(first.json);
  });
});

describe("replies", () => {
  it("resolves a reply addressed to a receipt id once that ticket has committed", async () => {
    const receipt = crypto.randomUUID();
    // The reply commits first (e.g. it landed in an earlier batch): a definitive 404.
    const early = await call("POST", `/api/tickets/${receipt}/replies`, {
      token: mara,
      body: { body: "Any update?" },
    });
    expect(early.status).toBe(404);

    await call("POST", "/api/tickets", {
      token: mara,
      id: receipt,
      body: { subject: "Login loop", body: "The app keeps sending me back to login." },
    });
    const reply = await call("POST", `/api/tickets/${receipt}/replies`, {
      token: mara,
      body: { body: "Any update?" },
    });
    expect(reply.status).toBe(201);
    expect(reply.json.reply.ticket_id).toBe(receipt);
  });

  it("marks a ticket answered when an agent replies", async () => {
    const t = await call("POST", "/api/tickets", {
      token: theo,
      body: { subject: "Password reset", body: "The reset email never arrives." },
    });
    await call("POST", `/api/tickets/${t.id}/replies`, {
      token: sam,
      body: { body: "Resent it, please check spam." },
    });
    const view = await call("GET", `/api/tickets/${t.id}`, { token: theo });
    expect(view.json.ticket.status).toBe("answered");
  });

  it("won't let a customer reply on someone else's ticket", async () => {
    const res = await call("POST", "/api/tickets/tkt_seed_1/replies", {
      token: mara,
      body: { body: "hijack" },
    });
    expect(res.status).toBe(404);
    expect(await count("replies", "body = 'hijack'")).toBe(0);
  });
});

describe("attachments", () => {
  const png = btoa("\x89PNG\r\n\x1a\nfake");

  it("stores an allowed file and returns metadata only", async () => {
    const res = await call("POST", "/api/tickets/tkt_seed_2/attachments", {
      token: mara,
      body: { filename: "screenshot.png", content_type: "image/png", content_base64: png },
    });
    expect(res.status).toBe(201);
    expect(res.json.attachment).toMatchObject({ filename: "screenshot.png", size: 12 });
    expect(res.json.attachment.content_base64).toBeUndefined();
  });

  it.each([
    [{ filename: "x.html", content_type: "text/html", content_base64: png }, 415],
    [{ filename: "../etc/passwd", content_type: "text/plain", content_base64: png }, 400],
    [{ filename: "a.txt", content_type: "text/plain", content_base64: "%%%" }, 400],
    [{ filename: "big.txt", content_type: "text/plain", content_base64: "A".repeat(90_000) }, 400],
  ])("rejects %o", async (body, status) => {
    const res = await call("POST", "/api/tickets/tkt_seed_2/attachments", { token: mara, body });
    expect(res.status).toBe(status);
  });
});

describe("profile", () => {
  it("ignores mass-assignment fields even if one reaches origin", async () => {
    const res = await call("PATCH", "/api/me", {
      token: theo,
      body: { display_name: "Theo P.", role: "admin", balance_cents: 999_999 },
    });
    expect(res.status).toBe(200);
    expect(res.json.ignored).toEqual(["role", "balance_cents"]);
    const me = await call("GET", "/api/me", { token: theo });
    expect(me.json.account).toMatchObject({
      display_name: "Theo P.",
      role: "customer",
      balance_cents: 1500,
    });
  });
});

describe("credits", () => {
  it("only lets agents issue credits", async () => {
    const res = await call("POST", "/api/accounts/acct_mara/credits", {
      token: mara,
      body: { amount_cents: 500_00, reason: "I deserve it" },
    });
    expect(res.status).toBe(403);
  });

  it("issues a credit exactly once even when re-sent", async () => {
    const id = crypto.randomUUID();
    const body = { amount_cents: 2400, reason: "Duplicate charge TW-88412" };
    const before =
      (
        await env.DB.prepare("SELECT balance_cents FROM accounts WHERE id = 'acct_theo'").first<{
          balance_cents: number;
        }>()
      )?.balance_cents ?? 0;
    await call("POST", "/api/accounts/acct_theo/credits", { token: sam, body, id });
    await call("POST", "/api/accounts/acct_theo/credits", { token: sam, body, id });
    const after = await env.DB.prepare(
      "SELECT balance_cents FROM accounts WHERE id = 'acct_theo'",
    ).first<{ balance_cents: number }>();
    expect(after?.balance_cents).toBe(before + 2400);
    expect(await count("credits", "id = ?", id)).toBe(1);
  });

  it.each([0, -100, 1.5, 50_001, "100"])("rejects amount %o", async (amount_cents) => {
    const res = await call("POST", "/api/accounts/acct_theo/credits", {
      token: sam,
      body: { amount_cents, reason: "test" },
    });
    expect(res.status).toBe(400);
  });

  it("won't credit staff accounts", async () => {
    const res = await call("POST", "/api/accounts/acct_sam/credits", {
      token: sam,
      body: { amount_cents: 100, reason: "self" },
    });
    expect(res.status).toBe(404);
  });
});

describe("api keys and admin", () => {
  it("shows a new API key once and stores only its hash", async () => {
    const res = await call("POST", "/api/keys", { token: mara, body: { label: "CI" } });
    expect(res.status).toBe(201);
    expect(res.json.key).toMatch(/^twk_[0-9a-f]{48}$/);
    expect(await count("api_keys", "key_hash = ?", res.json.key)).toBe(0);
    expect(await count("lazaret_requests", "instr(body, ?) > 0", res.json.key)).toBe(0);
  });

  it("keeps /admin role-checked behind Lazaret's edge BLOCK", async () => {
    expect((await call("GET", "/admin/accounts", { token: sam })).status).toBe(403);
  });

  it("answers 404 and 405 for unknown routes and methods", async () => {
    expect((await call("GET", "/api/nope", { token: mara })).status).toBe(404);
    const res = await call("DELETE", "/api/tickets", { token: mara });
    expect(res.status).toBe(405);
    expect(res.res.headers.get("allow")).toContain("GET");
  });
});
