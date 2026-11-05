import { expect, test } from "@playwright/test";
import { id, query, reachedOrigin } from "../lib/d1";
import { Demo, exhibit, type Final } from "../lib/demo";
import { assertClearOfReset } from "../lib/env";

// Each canned exhibit, fired at the deployed demo with live models, then checked in
// Tidewater's own D1: attacks never reach it, honest writes do. `lazaret_requests` is
// origin's log of every signed write it accepted, keyed by the Lazaret id (the escrow
// receipt, or the request id for inline routes), so "never reached origin" is a
// direct query, not an inference from Lazaret's own state.
//
// Tagged @smoke: the two-exhibit run used right after a deploy (about $0.01).

test.describe.configure({ mode: "serial" });

let demo: Demo;
test.beforeAll(async ({ playwright }) => {
  assertClearOfReset();
  const api = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  demo = new Demo(api);
  await demo.start();
  // Personas first: the credential-stuffing exhibit (last) locks this IP's logins.
  await demo.login("theo");
  await demo.login("sam");
});

/** Fire an escrowed exhibit and wait for every receipt it got to settle. */
async function escrowed(caseId: string): Promise<{ receipts: string[]; finals: Final[] }> {
  const x = exhibit(caseId);
  const sent = await demo.fire(x);
  for (const s of sent) {
    // Escrowed (202) or refused at the gate (403) are the only honest answers.
    expect([202, 403], `${caseId}: HTTP ${s.status} ${s.error ?? ""}`).toContain(s.status);
    if (s.status === 403 && s.requestId) expect(reachedOrigin(s.requestId)).toBe(false);
  }
  const receipts = sent.flatMap((s) => (s.receipt ? [s.receipt] : []));
  const finals = await Promise.all(receipts.map((r) => demo.settle(r, x.persona)));
  return { receipts, finals };
}

// M10 and M11 passed every local test but had never run on production writes. This
// proves the Ledger lookup behind linked history runs there, not what a reviewer made
// of it: that's the pattern eval's job. It costs two batch reviews.
test("linked history is looked up on production writes @smoke", async () => {
  const token = await demo.login("theo");
  const ticket = (subject: string) =>
    demo.send("POST", "/api/tickets", {
      token,
      body: JSON.stringify({ subject, body: "Smoke test: checking the link lookup." }),
    });
  const sent = [await ticket("Smoke check one"), await ticket("Smoke check two")];
  for (const s of sent) {
    expect(s.status).toBe(202);
    expect(s.timing ?? "").toContain("links;dur=");
  }
});

for (const caseId of ["ok-ticket-01", "ok-hard-01"]) {
  test(`${caseId}: an honest ticket is delivered to Tidewater${caseId === "ok-ticket-01" ? " @smoke" : ""}`, async () => {
    const { receipts, finals } = await escrowed(caseId);
    expect(receipts).toHaveLength(1);
    expect(finals).toEqual(["COMMITTED"]);
    const receipt = receipts[0] as string;
    expect(reachedOrigin(receipt)).toBe(true);
    // Receipt id convention: the ticket's id is the entry that created it.
    expect(query(`SELECT id FROM tickets WHERE id = ${id(receipt)}`)).toHaveLength(1);
  });
}

for (const caseId of ["xss-01", "sqli-01", "rpi-07", "dpi-01"]) {
  test(`${caseId}: the attack never reaches Tidewater${caseId === "xss-01" ? " @smoke" : ""}`, async () => {
    const { receipts, finals } = await escrowed(caseId);
    for (const f of finals) expect(["DROPPED", "QUARANTINED"]).toContain(f);
    for (const r of receipts) {
      expect(reachedOrigin(r)).toBe(false);
      expect(query(`SELECT id FROM tickets WHERE id = ${id(r)}`)).toHaveLength(0);
    }
  });
}

test("taint-01: the reply falls with the malicious ticket it depends on", async () => {
  const { receipts, finals } = await escrowed("taint-01");
  for (const f of finals) expect(["DROPPED", "QUARANTINED"]).toContain(f);
  for (const r of receipts) expect(reachedOrigin(r)).toBe(false);
  expect(
    query(`SELECT id FROM replies WHERE ticket_id IN (${receipts.map(id).join(",") || "''"})`),
  ).toHaveLength(0);
});

test("mass-01: the role escalation never lands", async () => {
  const { receipts, finals } = await escrowed("mass-01");
  for (const f of finals) expect(["DROPPED", "QUARANTINED"]).toContain(f);
  for (const r of receipts) expect(reachedOrigin(r)).toBe(false);
  expect(query<{ role: string }>("SELECT role FROM accounts WHERE id = 'acct_theo'")).toEqual([
    { role: "customer" },
  ]);
});

test("fraud-01: the oversized credit is refused inline and no money moves", async () => {
  const [sent] = await demo.fire(exhibit("fraud-01"));
  if (!sent) throw new Error("no response");
  // Refused by the reviewer (403), or failing closed when it can't answer (503).
  expect([403, 503]).toContain(sent.status);
  if (sent.requestId) expect(reachedOrigin(sent.requestId)).toBe(false);
  expect(query("SELECT id FROM credits WHERE amount_cents = 4999900")).toHaveLength(0);
});

test("cred-01: no stuffed login succeeds, and the burst is refused at the edge", async () => {
  const sent = await demo.fire(exhibit("cred-01"));
  expect(sent.every((s) => s.status !== 200)).toBe(true);
  // The accounts don't exist, so origin answers 401; the gate takes over once the
  // failures add up, and the reviewer is never asked about the rest.
  expect(sent.some((s) => s.status === 403)).toBe(true);
});
