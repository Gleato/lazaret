import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  createGateway,
  defineLazaret,
  type LedgerEvent,
  type LiveFrame,
  PUBLIC_EVENT_TYPES,
  publicEvent,
  type Reviewer,
} from "../src";
import { fakeReviewer, verdict } from "./fakes";
import { entry } from "./helpers";

// The public view (M7): the projection that strips private data, the WebSocket
// stream from the Ledger, and the read-only endpoints under /__lazaret/.

const SESSION = "f00dfeedcafe0123456789abcdef0123";
const TOKEN = "Bearer sk-live-SECRET-TOKEN";

function everyEvent(): LedgerEvent[] {
  const e = entry({
    sessionId: SESSION,
    request: {
      method: "POST",
      path: "/api/tickets",
      query: "api_key=QUERY-SECRET",
      headers: {
        authorization: TOKEN,
        cookie: "sid=COOKIE-SECRET",
        "x-forwarded-for": "198.51.100.7",
      },
      body: `${"x".repeat(500)}TAIL-SECRET`,
      bodyEncoding: "utf8",
    },
  });
  const v = { verdict: "drop" as const, category: "xss", confidence: 0.9, rationale: "script tag" };
  const all: LedgerEvent[] = [
    { type: "BATCH_OPENED", batchId: "b-1", at: 1 },
    { type: "ENTRY_APPENDED", entryId: "e1", batchId: "b-1", entry: e, at: 1 },
    { type: "BATCH_SEALED", batchId: "b-1", reason: "risk", at: 2 },
    { type: "REVIEW_STARTED", batchId: "b-1", attempt: 1, at: 3 },
    { type: "REVIEW_FAILED", batchId: "b-1", attempt: 1, error: "overloaded", at: 4 },
    { type: "ENTRY_VERDICT", entryId: "e1", verdict: v, at: 5 },
    { type: "COMMIT_STARTED", batchId: "b-1", at: 6 },
    { type: "ENTRY_COMMITTED", entryId: "e1", originStatus: 201, at: 7 },
    { type: "BATCH_SETTLED", batchId: "b-1", at: 8 },
    { type: "BATCH_QUARANTINED", batchId: "b-1", reason: "malformed", at: 9 },
    { type: "SESSION_FLAGGED", sessionId: SESSION, reason: "dropped e1", at: 10 },
    {
      type: "ENTRY_RESOLVED",
      entryId: "e1",
      decision: "drop",
      operator: "OPERATOR-NAME",
      note: "OPERATOR-NOTE",
      at: 11,
    },
    { type: "ENTRY_REPORTED", entryId: "e1", operator: "OPERATOR-NAME", note: "x", at: 12 },
  ];
  return all;
}

describe("public projection", () => {
  it("covers every event type", () => {
    expect(new Set(everyEvent().map((e) => e.type))).toEqual(new Set(PUBLIC_EVENT_TYPES));
  });

  it("never carries headers, queries, IPs, operator names, full sessions or whole bodies", () => {
    const out = JSON.stringify(
      everyEvent().map((event, i) => publicEvent({ seq: i + 1, event }, 280)),
    );
    for (const secret of [
      "SECRET-TOKEN",
      "COOKIE-SECRET",
      "QUERY-SECRET",
      "198.51.100.7",
      "OPERATOR-NAME",
      "OPERATOR-NOTE",
      "TAIL-SECRET",
      SESSION,
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain(SESSION.slice(0, 8));
  });

  it("cuts bodies to the preview length, and hides them at 0", () => {
    const [, appended] = everyEvent();
    const shown = publicEvent({ seq: 2, event: appended as LedgerEvent }, 10);
    expect(shown).toMatchObject({ entry: { body: "xxxxxxxxxx", bodyTruncated: true } });
    const hidden = publicEvent({ seq: 2, event: appended as LedgerEvent }, 0);
    expect(hidden).toMatchObject({ entry: { body: null, bodyTruncated: true } });
  });
});

let counter = 0;
function setup(reviewer?: Reviewer) {
  const n = ++counter;
  const shard = `live-${n}`;
  const config = defineLazaret({
    origin: "https://origin.test",
    ledger: { binding: "LEDGER", shard },
    routes: [
      { match: "POST /api/tickets", policy: "ESCROW" },
      { match: "POST /api/login", policy: "INLINE_REVIEW" },
      { match: "* /admin/*", policy: "BLOCK" },
    ],
    review: { budgetShard: `live-budget-${n}`, dailyBudgetUsd: 2 },
    live: { enabled: true, bodyPreviewChars: 40 },
  });
  const gateway = createGateway(config, {
    fetchOrigin: vi.fn(async () => Response.json({ ok: true })),
    ...(reviewer ? { reviewer } : {}),
  });
  const send = (path: string, init: RequestInit = {}) =>
    gateway.fetch(
      new Request(`https://edge.test${path}`, {
        ...init,
        headers: {
          "user-agent": "Mozilla/5.0 (test)",
          "cf-connecting-ip": "203.0.113.9",
          authorization: TOKEN,
          ...init.headers,
        },
      }),
      env,
    );
  const ticket = (body: string) =>
    send("/api/tickets", {
      method: "POST",
      body: JSON.stringify({ body }),
      headers: { "content-type": "application/json" },
    });
  const ledger = env.LEDGER.get(env.LEDGER.idFromName(shard));
  return { send, ticket, ledger, shard };
}

/** Connect a viewer and collect frames until `until` is satisfied. */
async function connect(send: (path: string, init?: RequestInit) => Promise<Response>, after = 0) {
  const res = await send(`/__lazaret/live?after=${after}`, { headers: { upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const frames: LiveFrame[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (m) => {
    frames.push(...(JSON.parse(m.data as string) as LiveFrame[]));
    for (const w of waiters.splice(0)) w();
  });
  const until = async (pred: (f: LiveFrame[]) => boolean) => {
    const deadline = Date.now() + 2_000;
    while (!pred(frames)) {
      if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(frames)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return { ws, frames, until };
}

const seqs = (frames: LiveFrame[]) =>
  frames.flatMap((f) => ("seq" in f ? [(f as { seq: number }).seq] : []));

describe("live stream", () => {
  it("replays the log, then streams new events live, in order", async () => {
    const { send, ticket, shard } = setup();
    await ticket("first");
    const viewer = await connect(send);
    await viewer.until((f) => seqs(f).length === 2);
    expect(viewer.frames[0]).toMatchObject({ type: "HELLO", shard, head: 2, previewChars: 40 });

    await ticket("second");
    await viewer.until((f) => seqs(f).length === 3);
    expect(seqs(viewer.frames)).toEqual([1, 2, 3]);
    const appended = viewer.frames.filter((f) => f.type === "ENTRY_APPENDED");
    expect(appended.map((f) => (f as { entry: { body: string } }).entry.body)).toEqual([
      '{"body":"first"}',
      '{"body":"second"}',
    ]);
    expect(JSON.stringify(viewer.frames)).not.toContain("SECRET-TOKEN");
    viewer.ws.close();
  });

  it("resumes after a reconnect with no gap and no duplicate", async () => {
    const { send, ticket } = setup();
    await ticket("a");
    const first = await connect(send);
    await first.until((f) => seqs(f).length === 2);
    first.ws.close();
    await ticket("b");
    const second = await connect(send, 2);
    await second.until((f) => seqs(f).length >= 1);
    expect(seqs(second.frames)).toEqual([3]);
    second.ws.close();
  });

  it("keeps streaming after the Ledger is evicted (hibernation)", async () => {
    const { send, ticket, ledger } = setup();
    const viewer = await connect(send);
    await viewer.until((f) => f.some((x) => x.type === "HELLO"));
    await evictDurableObject(ledger);
    await ticket("after eviction");
    await viewer.until((f) => f.some((x) => x.type === "ENTRY_APPENDED"));
    viewer.ws.close();
  });

  it("shows inline decisions and gate blocks as observations, never with a body", async () => {
    const { reviewer } = fakeReviewer(() => verdict("drop", 0.9, "credential_attack"));
    const { send } = setup(reviewer);
    const viewer = await connect(send);
    await send("/api/login", {
      method: "POST",
      body: JSON.stringify({ user: "ann", password: "PASSWORD-SECRET" }),
      headers: { "content-type": "application/json" },
    });
    await send("/admin/users", { method: "DELETE" });
    await viewer.until((f) => f.some((x) => x.type === "OBSERVED"));
    expect(viewer.frames.find((f) => f.type === "OBSERVED")).toMatchObject({
      kind: "inline",
      outcome: "deny",
      category: "credential_attack",
      route: "POST /api/login",
    });
    expect(JSON.stringify(viewer.frames)).not.toContain("PASSWORD-SECRET");
    viewer.ws.close();
  });

  it("sends RESET and closes viewers when a shard is retired", async () => {
    const { send, ledger } = setup();
    const viewer = await connect(send);
    await viewer.until((f) => f.length >= 1);
    expect(await ledger.closeLive()).toBe(1);
    await viewer.until((f) => f.some((x) => x.type === "RESET"));
  });

  it("refuses a plain GET on the live endpoint", async () => {
    expect((await setup().send("/__lazaret/live")).status).toBe(426);
  });
});

describe("public endpoints", () => {
  it("reports budget and inline health", async () => {
    const { reviewer } = fakeReviewer(() => verdict("allow", 0.96));
    const { send } = setup(reviewer);
    await send("/api/login", {
      method: "POST",
      body: JSON.stringify({ user: "ann", password: "x" }),
      headers: { "content-type": "application/json" },
    });
    // observe() is fire-and-forget; give it a moment to land.
    await new Promise((r) => setTimeout(r, 50));
    const status = (await (await send("/__lazaret/status")).json()) as {
      budget: { capUsd: number; exhausted: boolean };
      inline: { total: number; degraded: number; timeoutMs: number };
    };
    expect(status.budget).toMatchObject({ capUsd: 2, exhausted: false });
    expect(status.inline).toMatchObject({ total: 1, degraded: 0, timeoutMs: 3000 });
  });

  it("shows the human queue redacted", async () => {
    const { send, ticket, ledger } = setup();
    const { receipt } = (await (await ticket("hold me")).json()) as { receipt: string };
    const batchId = (await ledger.getState()).entries[receipt]?.batchId as string;
    await ledger.seal();
    await ledger.quarantine(batchId, "test");
    const body = (await (await send("/__lazaret/queue")).json()) as {
      entries: { entryId: string; session: string }[];
    };
    expect(body.entries.map((e) => e.entryId)).toEqual([receipt]);
    expect(JSON.stringify(body)).not.toContain("SECRET-TOKEN");
  });

  it("are off unless live is enabled", async () => {
    const gateway = createGateway(
      defineLazaret({ origin: "https://origin.test", ledger: { binding: "LEDGER" }, routes: [] }),
      { fetchOrigin: async () => new Response("origin") },
    );
    const res = await gateway.fetch(new Request("https://edge.test/__lazaret/status"), env);
    expect(res.status).toBe(404);
  });

  it("rolls the shard over when it is a function of time", async () => {
    let now = Date.UTC(2026, 9, 28, 10);
    const config = defineLazaret({
      origin: "https://origin.test",
      ledger: { binding: "LEDGER", shard: (t) => `roll-${new Date(t).getUTCHours()}` },
      routes: [{ match: "POST /api/tickets", policy: "ESCROW" }],
      live: { enabled: true },
    });
    const gateway = createGateway(config, {
      fetchOrigin: async () => new Response("x"),
      now: () => now,
    });
    const status = async () =>
      (
        (await (
          await gateway.fetch(new Request("https://edge.test/__lazaret/status"), env)
        ).json()) as {
          shard: string;
        }
      ).shard;
    expect(await status()).toBe("roll-10");
    now += 3_600_000;
    expect(await status()).toBe("roll-11");
  });
});
