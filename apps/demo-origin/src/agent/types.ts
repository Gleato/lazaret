// Tidewater's AI support agent (tasks/todo.md §6, "downstream-AI scenario").
//
// The agent reads support tickets and proposes refunds. It is the *downstream*
// consumer an attacker targets with indirect prompt injection: they never talk to
// the agent; they plant instructions in a ticket and wait for the agent to read it.
// Lazaret's job is to make sure such a ticket never reaches the table the agent
// reads. The agent is deliberately limited anyway (it proposes; a human approves),
// but the demo shows what happens to an agent that is less careful.

export interface AgentTicket {
  id: string;
  account_id: string;
  customer: string;
  subject: string;
  body: string;
}

export interface Proposal {
  decision: "propose_refund" | "no_refund" | "escalate";
  /** Who the refund would go to. The ticket's owner, unless the agent was hijacked. */
  account_id: string;
  amount_cents: number;
  reason: string;
}

/** One step of the agent's visible reasoning, for the demo transcript. */
export interface TraceStep {
  ticket_id: string;
  note: string;
}

export interface SupportAgent {
  readonly model: string;
  propose(ticket: AgentTicket, trace: TraceStep[]): Promise<Proposal>;
}
