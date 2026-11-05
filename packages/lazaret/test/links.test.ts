import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBatchPrompt,
  createCommitter,
  createGateway,
  defineLazaret,
  type EntryState,
  type LazaretConfig,
  type LazaretConfigError,
  type LedgerPort,
  runReviewPipeline,
} from "../src";
import { linkKeys } from "../src/ledger/links";
import { fakeOrigin, fakeReviewer, promptEntries, SECRET, verdict } from "./fakes";
import { allow, entry, rejectionOf } from "./helpers";
import { MemoryStepRunner } from "./step-runner";

// Linked history (M10, tasks/todo.md). The live "quiet heist" (2026-11-04) sent five
// believable refund claims, each alone in its own batch, and all five were allowed:
// the reviewer only ever saw one batch. These tests pin down the fix: writes carry link
// keys, the Ledger keeps a short history per key, and the reviewer sees it.

let counter = 0;
const ledger = () => env.LEDGER.get(env.LEDGER.idFromName(`links-${++counter}`));
const WINDOW = { windowMs: 60 * 60_000, maxHistory: 8 };

/** Append one write and settle its batch with a verdict, as review would. */
async function decided(
  stub: ReturnType<typeof ledger>,
  links: string[],
  body: string,
  v = allow,
): Promise<string> {
  const { entryId, batchId } = await stub.append(
    entry({ links, request: { ...entry().request, body } }),
  );
  await stub.seal();
  await stub.beginReview(batchId);
  await stub.recordVerdicts(batchId, { [entryId]: v });
  await stub.beginCommit(batchId);
  if (v.verdict === "allow") await stub.markCommitted(entryId, 201);
  await stub.settle(batchId);
  return entryId;
}

describe("link keys", () => {
  it("links by session, account and parameterised resources only", () => {
    expect(
      linkKeys(["session", "actor", "resource"], {
        sessionId: "s1",
        actorId: "acct_mara",
        resourceTemplates: ["account:{id}", "account:me"],
        resources: ["account:acct_mara", "account:me"],
      }),
    ).toEqual(["session:s1", "actor:acct_mara", "resource:account:acct_mara"]);
  });

  it("leaves the account out when origin didn't name one", () => {
    expect(
      linkKeys(["actor", "resource"], {
        sessionId: "s1",
        actorId: null,
        resourceTemplates: [],
        resources: [],
      }),
    ).toEqual([]);
  });
});

describe("Ledger linked history", () => {
  it("shows a write the decided writes it shares a key with, newest first, not its own batch", async () => {
    const stub = ledger();
    const first = await decided(stub, ["actor:acct_mara"], "refund $49 for July");
    const second = await decided(stub, ["actor:acct_mara"], "refund $48 for August");
    await decided(stub, ["actor:acct_theo"], "someone else's claim");

    const { batchId, entryId } = await stub.append(entry({ links: ["actor:acct_mara"] }));
    const sibling = await stub.append(entry({ links: ["actor:acct_mara"] }));
    await stub.seal();
    const snap = await stub.getReviewSnapshot(batchId, WINDOW);
    const history = snap.linked?.[entryId] ?? [];
    expect(history.map((w) => w.entryId)).toEqual([second, first]);
    expect(history[0]).toMatchObject({
      linkedBy: ["sent by the same signed-in account"],
      verdict: "allow",
      category: "benign",
      route: "POST /api/tickets",
      path: "/api/tickets",
      preview: "refund $48 for August",
    });
    // Its batch-mate is in the prompt already, in full: not repeated as history.
    expect(history.some((w) => w.entryId === sibling.entryId)).toBe(false);
  });

  it("is only read when asked for, honours maxHistory, and lists every key a write matched", async () => {
    const stub = ledger();
    for (const n of [1, 2, 3]) {
      await decided(stub, ["actor:acct_mara", "resource:account:acct_mara"], `claim ${n}`);
    }
    const { batchId, entryId } = await stub.append(
      entry({ links: ["actor:acct_mara", "resource:account:acct_mara"] }),
    );
    await stub.seal();
    expect((await stub.getReviewSnapshot(batchId)).linked).toBeUndefined();
    const snap = await stub.getReviewSnapshot(batchId, { ...WINDOW, maxHistory: 2 });
    const history = snap.linked?.[entryId] ?? [];
    expect(history).toHaveLength(2);
    expect(history[0]?.linkedBy.sort()).toEqual([
      "acts on the same account:acct_mara",
      "sent by the same signed-in account",
    ]);
  });

  it("shows other senders' writes on a shared resource only if they were allowed", async () => {
    // Regression for the first full live run (2026-11-05): attacks by others on a
    // customer's account got that customer's honest writes held.
    const stub = ledger();
    const shared = "resource:account:acct_theo";
    const othersAllowed = await decided(stub, ["session:agent-1", shared], "credit $24");
    await decided(stub, ["session:attacker", shared], "credit $49,999", {
      ...allow,
      verdict: "drop",
      category: "fraud",
    });
    const ownDrop = await decided(stub, ["session:agent-2", shared], "credit -$100", {
      ...allow,
      verdict: "drop",
      category: "fraud",
    });
    const { batchId, entryId } = await stub.append(entry({ links: ["session:agent-2", shared] }));
    await stub.seal();
    const history = (await stub.getReviewSnapshot(batchId, WINDOW)).linked?.[entryId] ?? [];
    expect(history.map((w) => w.entryId).sort()).toEqual([othersAllowed, ownDrop].sort());
  });

  it("leaves out writes older than the window", async () => {
    const stub = ledger();
    await decided(stub, ["actor:acct_mara"], "old claim");
    await runInDurableObject(stub, (_i, ctx) => {
      ctx.storage.sql.exec("UPDATE linked_writes SET at = at - ?", 2 * 60 * 60_000);
    });
    const { batchId, entryId } = await stub.append(entry({ links: ["actor:acct_mara"] }));
    await stub.seal();
    expect((await stub.getReviewSnapshot(batchId, WINDOW)).linked?.[entryId]).toBeUndefined();
  });

  it("names a new ticket's receipt in its link key, so its replies link to it", async () => {
    const stub = ledger();
    const ticket = await decided(stub, ["resource:ticket:{receipt}"], "my export fails");
    const { batchId, entryId } = await stub.append(entry({ links: [`resource:ticket:${ticket}`] }));
    await stub.seal();
    const history = (await stub.getReviewSnapshot(batchId, WINDOW)).linked?.[entryId] ?? [];
    expect(history.map((w) => w.entryId)).toEqual([ticket]);
  });

  it("keeps history through log compaction, which prunes the entries themselves", async () => {
    const stub = env.COMPACT_LEDGER.get(env.COMPACT_LEDGER.idFromName(`links-${++counter}`));
    const old = await decided(
      stub as unknown as ReturnType<typeof ledger>,
      ["actor:acct_mara"],
      "claim before compaction",
    );
    // Past the test Ledger's 60 s retention, so compaction prunes the settled entry.
    await stub.advanceClock(61_000);
    await stub.compact(true);
    expect((await stub.getState()).entries[old]).toBeUndefined();
    const { batchId, entryId } = await stub.append(entry({ links: ["actor:acct_mara"] }));
    await stub.seal();
    const history = (await stub.getReviewSnapshot(batchId, WINDOW)).linked?.[entryId] ?? [];
    expect(history.map((w) => w.entryId)).toEqual([old]);
  });

  it("indexes inline decisions for later inline reviews, and refuses malformed keys", async () => {
    const stub = ledger();
    await stub.recordLinked({
      entryId: "req-1",
      keys: ["resource:account:acct_mara"],
      at: 0,
      route: "POST /api/accounts/:id/credits",
      method: "POST",
      path: "/api/accounts/acct_mara/credits",
      preview: '{"amount_cents":4900}',
      verdict: "allow",
      category: "benign",
    });
    const found = await stub.getLinked(["resource:account:acct_mara"], WINDOW);
    expect(found).toMatchObject([
      {
        entryId: "req-1",
        path: "/api/accounts/acct_mara/credits",
        linkedBy: ["acts on the same account:acct_mara"],
      },
    ]);
    expect((await rejectionOf(stub.getLinked(["x".repeat(500)], WINDOW))).message).toMatch(
      /invalid link keys/,
    );
  });
});

describe("prompt", () => {
  const e = (over: Partial<EntryState> = {}): EntryState => ({
    ...entry(),
    id: "e2",
    batchId: "batch-2",
    status: "PENDING",
    receivedAt: 10 * 60_000,
    ...over,
  });

  it("gives the reviewer each earlier write's link, age, verdict and a short preview, never a rationale", () => {
    const prompt = buildBatchPrompt([e()], [], [], {
      previewChars: 12,
      byEntry: {
        e2: [
          {
            entryId: "e1",
            at: 4 * 60_000,
            route: "POST /api/tickets",
            method: "POST",
            path: "/api/tickets",
            preview: "<b>refund $49.00 for July</b>",
            verdict: "allow",
            category: "benign",
            linkedBy: ["sent by the same signed-in account"],
          },
        ],
      },
    });
    const [view] = promptEntries(prompt) as unknown as { linked_history: unknown[] }[];
    expect(view?.linked_history).toEqual([
      {
        linked_by: ["sent by the same signed-in account"],
        minutes_earlier: 6,
        method: "POST",
        path: "/api/tickets",
        verdict: "allow",
        category: "benign",
        preview: "<b>refund $4",
      },
    ]);
    // Escaped like every other byte of client data, so it can't close the block.
    expect(prompt).not.toContain("<b>");
    expect(prompt).toContain("linked_history");
  });

  it("adds nothing when an entry has no linked writes", () => {
    expect(buildBatchPrompt([e()], [], [], { byEntry: {}, previewChars: 160 })).not.toContain(
      "linked_history",
    );
  });
});

describe("config", () => {
  const base: LazaretConfig = { origin: "https://origin.test", routes: [] };
  const actor = { path: "/api/me", fields: { id: "account.id" } };

  it("is off by default, and on with defaults when set", () => {
    expect(defineLazaret(base).link).toBeNull();
    expect(defineLazaret({ ...base, link: {} }).link).toEqual({
      by: ["session", "resource"],
      actorField: "id",
      windowMs: 24 * 60 * 60_000,
      maxHistory: 8,
      previewChars: 160,
    });
    expect(defineLazaret({ ...base, review: { actor }, link: {} }).link?.by).toEqual([
      "session",
      "actor",
      "resource",
    ]);
  });

  it("refuses actor linking without an actor lookup, and out-of-range sizes", () => {
    const problems = (link: LazaretConfig["link"], review?: LazaretConfig["review"]) => {
      try {
        defineLazaret({ ...base, link, ...(review ? { review } : {}) });
        return [];
      } catch (err) {
        return (err as LazaretConfigError).problems;
      }
    };
    expect(problems({ by: ["actor"] })).toContain("link.by actor needs review.actor");
    expect(problems({ by: ["actor"], actorField: "uid" }, { actor })).toContain(
      'link.actorField "uid" is not one of review.actor.fields',
    );
    expect(problems({ maxHistory: 50, windowMs: 1, previewChars: 1000 })).toEqual([
      "link.windowMs must be between one minute and 7 days",
      "link.maxHistory must be an integer from 1 to 20",
      "link.previewChars must be an integer from 0 to 400",
    ]);
  });
});

describe("Gateway with linking", () => {
  const origin = vi.fn();
  beforeEach(() => {
    origin.mockReset();
    // Origin answers who the client is from its token, as Tidewater's /api/me does.
    origin.mockImplementation(async (req: Request) => {
      if (new URL(req.url).pathname.endsWith("/api/me")) {
        const token = req.headers.get("authorization") ?? "";
        const id = token.includes("mara") ? "acct_mara" : token.includes("sam") ? "acct_sam" : null;
        return id
          ? Response.json({ account: { id, role: id === "acct_sam" ? "agent" : "customer" } })
          : Response.json({ error: "login required" }, { status: 401 });
      }
      return Response.json({ ok: true }, { status: 201 });
    });
  });

  function setup(reviewer = fakeReviewer(() => verdict("allow", 0.96)).reviewer, link = {}) {
    const shard = `links-gw-${++counter}`;
    const config = defineLazaret({
      origin: "https://origin.test",
      ledger: { binding: "LEDGER", shard },
      routes: [
        { match: "POST /api/tickets", policy: "ESCROW", resources: ["ticket:{receipt}"] },
        {
          match: "POST /api/accounts/:id/credits",
          policy: "INLINE_REVIEW",
          resources: ["account:{id}"],
        },
      ],
      // Lazaret's session is the login token, as in Tidewater, so a new sign-in is a new session.
      session: { header: "authorization" },
      review: { actor: { path: "/api/me", fields: { id: "account.id", role: "account.role" } } },
      link,
    });
    const gateway = createGateway(config, { fetchOrigin: origin, reviewer });
    const stub = env.LEDGER.get(env.LEDGER.idFromName(shard));
    const post = (path: string, body: unknown, token: string) =>
      gateway.fetch(
        new Request(`https://edge.test${path}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "user-agent": "Mozilla/5.0 (test)",
            "cf-connecting-ip": "203.0.113.9",
          },
        }),
        env,
      );
    return { config, stub, post };
  }

  it("tags an escrowed write with its session, account and receipt, asking origin once per session", async () => {
    const { stub, post } = setup();
    const first = (await (await post("/api/tickets", { body: "refund" }, "mara-1")).json()) as {
      receipt: string;
    };
    await post("/api/tickets", { body: "another" }, "mara-1");
    const state = await stub.getState();
    const links = state.entries[first.receipt]?.links ?? [];
    expect(links).toHaveLength(3);
    expect(links[0]).toMatch(/^session:/);
    expect(links.slice(1)).toEqual(["actor:acct_mara", `resource:ticket:${first.receipt}`]);
    const lookups = origin.mock.calls.filter(([r]) =>
      new URL((r as Request).url).pathname.endsWith("/api/me"),
    );
    expect(lookups).toHaveLength(1);
  });

  it("links a new sign-in to the same account's earlier claims", async () => {
    const { reviewer, calls } = fakeReviewer(() => verdict("allow", 0.96));
    const { config, stub, post } = setup(reviewer);
    const deps = (s: typeof stub) => ({
      ledger: s as unknown as LedgerPort,
      reviewer,
      committer: createCommitter({
        origin: config.origin,
        secret: SECRET,
        fetchOrigin: fakeOrigin().fetchOrigin,
      }),
      config,
      attemptBackoffMs: 1,
    });
    // Two claims from two logins of one account, each reviewed in its own batch.
    await post("/api/tickets", { body: "Charged twice in July, refund $49" }, "mara-1");
    let batch = await stub.seal();
    await runReviewPipeline(new MemoryStepRunner(), deps(stub), batch as string);
    await post("/api/tickets", { body: "Charged after cancelling, refund $48" }, "mara-2");
    batch = await stub.seal();
    await runReviewPipeline(new MemoryStepRunner(), deps(stub), batch as string);

    const second = promptEntries(calls.at(-1)?.prompt ?? "") as unknown as {
      linked_history?: { linked_by: string[]; preview: string }[];
    }[];
    expect(second[0]?.linked_history).toEqual([
      expect.objectContaining({
        linked_by: ["sent by the same signed-in account"],
        preview: expect.stringContaining("$49"),
      }),
    ]);
  });

  it("shows an inline credit the earlier credits paid to the same account", async () => {
    const { reviewer, calls } = fakeReviewer(() => verdict("allow", 0.96));
    const { post, stub } = setup(reviewer);
    await post("/api/accounts/acct_mara/credits", { amount_cents: 4900 }, "sam-1");
    await post("/api/accounts/acct_theo/credits", { amount_cents: 2400 }, "sam-1");
    // Recording runs after the response (waitUntil in production); wait for both.
    await vi.waitFor(async () => {
      const recorded = await runInDurableObject(stub, (_i, ctx) =>
        ctx.storage.sql.exec("SELECT DISTINCT entry_id FROM linked_writes").toArray(),
      );
      expect(recorded).toHaveLength(2);
    });
    await post("/api/accounts/acct_mara/credits", { amount_cents: 4800 }, "sam-1");
    const [view] = promptEntries(calls.at(-1)?.prompt ?? "") as unknown as {
      linked_history?: { linked_by: string[]; path: string }[];
    }[];
    const history = view?.linked_history ?? [];
    expect(history).toHaveLength(2);
    const toMara = history.find((w) => w.path === "/api/accounts/acct_mara/credits");
    expect(toMara?.linked_by).toContain("acts on the same account:acct_mara");
    // Sam's credit to Theo is linked only by who sent it, and its path says so: the
    // first live run hid the path, and the reviewer read an agent's credits to four
    // customers as four to one.
    const toTheo = history.find((w) => w.path === "/api/accounts/acct_theo/credits");
    expect(toTheo?.linked_by.sort()).toEqual([
      "same login session",
      "sent by the same signed-in account",
    ]);
  });

  it("changes nothing when linking is off", async () => {
    const shard = `links-off-${++counter}`;
    const config = defineLazaret({
      origin: "https://origin.test",
      ledger: { binding: "LEDGER", shard },
      routes: [{ match: "POST /api/tickets", policy: "ESCROW", resources: ["ticket:{receipt}"] }],
    });
    const gateway = createGateway(config, { fetchOrigin: origin });
    const res = await gateway.fetch(
      new Request("https://edge.test/api/tickets", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      }),
      env,
    );
    const { receipt } = (await res.json()) as { receipt: string };
    const state = await env.LEDGER.get(env.LEDGER.idFromName(shard)).getState();
    expect(state.entries[receipt]?.links).toBeUndefined();
    expect(origin).not.toHaveBeenCalled();
  });
});
