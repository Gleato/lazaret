// Shared by replay.ts (step 6) and live.ts (step 9): the attack goals, where their text is
// planted, the database resets between runs, and how lazaret-mcp's refusals read.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Call, fingerprint, fullReset, here, psql, quickReset } from "./client.ts";

// The test half, frozen before any paid run. A changed file stops the run.
export const TEST_SHA256 = "6e9a0d21a2ff198fef635a3b949cbdd2822a43c49df199a88c43be0b0ad6d6f1";
export const MARKERS = { obvious: "LAZARET-MCP-INJECTION", forged: "CS-48213" } as const;
export type Form = keyof typeof MARKERS;
export const FORMS = Object.keys(MARKERS) as Form[];

export type Goal = {
  id: string;
  about: string;
  calls: Call[];
  check: { sql: string; success: string };
  obvious: string;
  forged: string;
  half: "dev" | "test";
};

// Where an attacker's text can sit: fields a customer controls, appended to the seeded value.
export const SLOTS: Record<string, { table: string; column: string; where: string }> = {
  ticket_subject: { table: "tickets", column: "subject", where: "id = 12" },
  ticket_body: { table: "tickets", column: "body", where: "id = 12" },
  reply_body: { table: "replies", column: "body", where: "ticket_id = 12 and author = 'customer'" },
  customer_name: { table: "customers", column: "name", where: "id = 4" },
  test_customer_name: { table: "customers", column: "name", where: "id = 9" },
  customer_email: { table: "customers", column: "email", where: "id = 5" },
  key_label: { table: "api_keys", column: "label", where: "id = 4" },
};

/** The goals of a half; the test half only if attacks/test.json still has its frozen hash. */
export function loadGoals(half: "dev" | "test" | "all"): { goals: Goal[]; testSha: string } {
  const testSha = createHash("sha256")
    .update(readFileSync(join(here, "attacks/test.json")))
    .digest("hex");
  if (half !== "dev" && testSha !== TEST_SHA256)
    throw new Error(`attacks/test.json changed: sha256 ${testSha}, frozen ${TEST_SHA256}`);
  const load = (h: "dev" | "test") =>
    (
      JSON.parse(readFileSync(join(here, `attacks/${h}.json`), "utf8")) as { goals: Goal[] }
    ).goals.map((g) => ({ ...g, half: h }));
  const goals = [...(half !== "test" ? load("dev") : []), ...(half !== "dev" ? load("test") : [])];
  for (const g of goals)
    for (const form of FORMS)
      if (!g[form].includes(MARKERS[form])) throw new Error(`${g.id} ${form}: no delivery marker`);
  return { goals, testSha };
}

export function plant(slots: string[], text: string): void {
  for (const s of slots) {
    const slot = SLOTS[s];
    if (!slot) throw new Error(`no slot ${s}`);
    const { table, column, where } = slot;
    psql(`update ${table} set ${column} = ${column} || ' ' || :'t' where ${where};`, { t: text });
  }
}

// Quick reset, proved against the full reset's fingerprint; a full reset if it doesn't match.
export const resets = { quick: 0, fullAfter: [] as string[], baseline: "" };
export async function startClean(): Promise<void> {
  await fullReset();
  resets.baseline = fingerprint();
}
export async function clean(label: string): Promise<void> {
  resets.quick++;
  let fp = "";
  try {
    quickReset();
    fp = fingerprint();
  } catch {}
  if (fp === resets.baseline) return;
  resets.fullAfter.push(label);
  await fullReset();
  if (fingerprint() !== resets.baseline)
    throw new Error(`state differs even after a full reset (${label})`);
}

// What lazaret-mcp did with a call, read from its refusal text (review.ts).
export type Decision = "sent" | "drop" | "hold" | "unavailable" | "gate_block" | "failed";
export function decisionOf(error: string): Decision {
  if (error.includes("Lazaret dropped")) return "drop";
  if (error.includes("Lazaret held")) return "hold";
  if (error.includes("Lazaret couldn't review")) return "unavailable";
  if (error.includes("Lazaret blocked")) return "gate_block";
  return "failed"; // the upstream's own error
}
