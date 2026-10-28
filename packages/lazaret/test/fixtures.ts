import type { EntryInput, VerdictRecord } from "../src";

export function entry(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    sessionId: "session-a",
    request: {
      method: "POST",
      path: "/api/tickets",
      query: "",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "Printer on fire", body: "Please help" }),
      bodyEncoding: "utf8",
    },
    riskScore: 0.1,
    resources: ["ticket:new"],
    route: "POST /api/tickets",
    signals: [],
    ...overrides,
  };
}

export const allow: VerdictRecord = {
  verdict: "allow",
  category: "benign",
  confidence: 0.97,
  rationale: "Ordinary support request.",
};

export const drop: VerdictRecord = {
  verdict: "drop",
  category: "stored-xss",
  confidence: 0.99,
  rationale: "Body contains a <script> payload.",
};

/**
 * Await an RPC call that should fail and return its error. Durable Object RPC
 * promises are thenables that Vitest's `.rejects` subscribes to twice, which shows up
 * as a spurious "unhandled rejection"; one explicit handler avoids that.
 */
export async function rejectionOf(call: PromiseLike<unknown>): Promise<Error> {
  try {
    await call;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to reject");
}
