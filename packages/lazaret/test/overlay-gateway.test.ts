import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createGateway, defineLazaret, type MergeFn } from "../src";
import { verdict } from "./fakes";

// The author-only overlay end to end: real Gateway, real Ledger, fake origin.

const tickets: Record<string, { id: string; subject: string; status: string }> = {
  "1": { id: "1", subject: "Printer on fire", status: "open" },
  "2": { id: "2", subject: "Login broken", status: "open" },
};

const origin = vi.fn(async (req: Request) => {
  const path = new URL(req.url).pathname;
  if (path === "/api/tickets") {
    return Response.json(
      { tickets: Object.values(tickets) },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  }
  const id = path.match(/^\/api\/tickets\/(\w+)$/)?.[1];
  if (id && tickets[id]) return Response.json(tickets[id]);
  if (path === "/api/plain")
    return new Response("plain text", { headers: { "content-type": "text/plain" } });
  return Response.json({ error: "not found" }, { status: 404 });
});

let counter = 0;
function setup(merge?: MergeFn) {
  const shard = `overlay-${++counter}`;
  const config = defineLazaret({
    origin: "https://origin.test",
    ledger: { binding: "LEDGER", shard },
    session: { cookie: "sid" },
    routes: [
      { match: "GET /api/*", policy: "PASS" },
      {
        match: "POST /api/tickets",
        policy: "ESCROW",
        resources: ["ticket:new"],
        overlay: { on: "GET /api/tickets", merge: merge ?? "append-json-array", path: "tickets" },
      },
      {
        match: "PATCH /api/tickets/:id",
        policy: "ESCROW",
        resources: ["ticket:{id}"],
        overlay: [
          { on: "GET /api/tickets", merge: "patch-json-by-id", path: "tickets" },
          { on: "GET /api/tickets/:id", merge: "merge-json-object" },
        ],
      },
    ],
  });
  const gateway = createGateway(config, { fetchOrigin: origin });
  const as = (user: string) => {
    const headers = {
      cookie: `sid=${user}`,
      "user-agent": "Mozilla/5.0",
      "cf-connecting-ip": "203.0.113.9",
    };
    return {
      get: (path: string) =>
        gateway.fetch(new Request(`https://edge.test${path}`, { headers }), env),
      write: async (method: string, path: string, body: unknown) => {
        const res = await gateway.fetch(
          new Request(`https://edge.test${path}`, {
            method,
            body: JSON.stringify(body),
            headers: { ...headers, "content-type": "application/json" },
          }),
          env,
        );
        return (await res.json()) as { receipt: string; batchId: string };
      },
    };
  };
  return { as, ledger: env.LEDGER.get(env.LEDGER.idFromName(shard)) };
}

type List = {
  tickets: { id?: string; subject: string; status?: string; _lazaret?: { receipt: string } }[];
};

describe("author-only read overlay", () => {
  it("shows a pending write to its author, and only to its author", async () => {
    const { as } = setup();
    const { receipt } = await as("alice").write("POST", "/api/tickets", {
      subject: "My new ticket",
    });

    const mine = await as("alice").get("/api/tickets");
    const list = (await mine.json()) as List;
    expect(list.tickets.map((t) => t.subject)).toEqual([
      "Printer on fire",
      "Login broken",
      "My new ticket",
    ]);
    expect(list.tickets[2]?._lazaret).toEqual({ pending: true, receipt });
    expect(mine.headers.get("cache-control")).toBe("private, no-store");
    expect(mine.headers.get("x-lazaret-overlay")).toBe("1");

    const theirs = await as("bob").get("/api/tickets");
    expect(((await theirs.json()) as List).tickets).toHaveLength(2);
    expect(theirs.headers.get("x-lazaret-overlay")).toBeNull();
    expect(theirs.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("scopes patches by route params: an edit to ticket 1 never shows on ticket 2", async () => {
    const { as } = setup();
    await as("alice").write("PATCH", "/api/tickets/1", { status: "closed" });

    expect(await (await as("alice").get("/api/tickets/1")).json()).toMatchObject({
      id: "1",
      status: "closed",
    });
    expect(await (await as("alice").get("/api/tickets/2")).json()).toEqual(tickets["2"]);
    const list = (await (await as("alice").get("/api/tickets")).json()) as List;
    expect(list.tickets.map((t) => t.status)).toEqual(["closed", "open"]);
  });

  it("stops overlaying once a write is dropped, or committed to origin", async () => {
    const { as, ledger } = setup();
    const kept = await as("alice").write("POST", "/api/tickets", { subject: "Keep me" });
    const bad = await as("alice").write("POST", "/api/tickets", { subject: "Drop me" });
    const batchId = (await ledger.seal()) ?? "";
    await ledger.startReview(batchId);
    await ledger.recordVerdicts(batchId, {
      [kept.receipt]: verdict("allow"),
      [bad.receipt]: verdict("drop"),
    });

    // Approved but not yet committed: still overlaid. Dropped: gone.
    let list = (await (await as("alice").get("/api/tickets")).json()) as List;
    expect(list.tickets.map((t) => t.subject)).toEqual([
      "Printer on fire",
      "Login broken",
      "Keep me",
    ]);

    await ledger.startCommit(batchId);
    await ledger.markCommitted(kept.receipt, 201);
    await ledger.settle(batchId);
    list = (await (await as("alice").get("/api/tickets")).json()) as List;
    expect(list.tickets).toHaveLength(2); // origin owns it now
  });

  it("serves receipt status to the author only", async () => {
    const { as } = setup();
    origin.mockClear();
    const { receipt } = await as("alice").write("POST", "/api/tickets", { subject: "Hi" });

    const mine = await as("alice").get(`/__lazaret/receipts/${receipt}`);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ receipt, status: "PENDING", batchStatus: "OPEN" });
    expect((await as("bob").get(`/__lazaret/receipts/${receipt}`)).status).toBe(404);
    expect((await as("alice").get("/__lazaret/receipts/nope")).status).toBe(404);
    expect((await as("alice").get("/__lazaret/anything-else")).status).toBe(404);
    expect(origin).not.toHaveBeenCalled();
  });

  it("passes non-JSON and non-200 responses through untouched", async () => {
    const { as } = setup();
    await as("alice").write("POST", "/api/tickets", { subject: "Hi" });
    const plain = await as("alice").get("/api/plain");
    expect(await plain.text()).toBe("plain text");
    expect((await as("alice").get("/api/tickets/999")).status).toBe(404);
  });

  it("never fails a read because a custom merger threw", async () => {
    const { as } = setup(() => {
      throw new Error("bug in custom merger");
    });
    await as("alice").write("POST", "/api/tickets", { subject: "Hi" });
    const res = await as("alice").get("/api/tickets");
    expect(res.status).toBe(200);
    expect(((await res.json()) as List).tickets).toHaveLength(2);
  });
});
