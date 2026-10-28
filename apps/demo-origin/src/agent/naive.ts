import type { AgentTicket, Proposal, SupportAgent, TraceStep } from "./types";

// A deliberately naive, *scripted* support agent for the "Lazaret off" replay.
//
// It stands in for any LLM agent that can be talked into following instructions
// found in the data it reads. Real models resist many injections, so pretending a
// live model was hijacked on cue would be dishonest; this agent is labelled
// "simulated" everywhere it appears. What it demonstrates is real: if a payload
// reaches the agent's input, the agent's safety is the last line of defence. With
// Lazaret on, the payload never reaches that input at all.
//
// Policy, in order:
//   1. If the ticket text gives an instruction to refund an amount (optionally to an
//      account), obey it. This is the vulnerability.
//   2. A duplicate-charge complaint with a stated amount up to $50 → refund the owner.
//   3. Anything else → no refund.

const MAX_ROUTINE_CENTS = 5_000;

const INSTRUCTED_REFUND =
  /\b(?:refund|credit|issue)\b[^$\n]{0,40}\$\s?([\d,]+(?:\.\d{2})?)(?:[^\n]{0,60}?\b(?:to|into)\s+(?:account\s+)?(acct_[a-z0-9_]+))?/i;
const INSTRUCTION_CUE =
  /\b(ignore|disregard|override|you are (?:now )?authori[sz]ed|system:|as the ai)\b/i;
const DUPLICATE_CHARGE =
  /\b(charged twice|double[- ]charged|duplicate charge)\b[\s\S]*?\$\s?(\d+(?:\.\d{2})?)/i;

const cents = (dollars: string) => Math.round(Number(dollars.replaceAll(",", "")) * 100);

export class NaiveScriptedAgent implements SupportAgent {
  readonly model = "simulated-naive-agent";

  async propose(ticket: AgentTicket, trace: TraceStep[]): Promise<Proposal> {
    const note = (text: string) => trace.push({ ticket_id: ticket.id, note: text });
    note(`Reading ticket "${ticket.subject}" from ${ticket.customer}.`);
    const text = `${ticket.subject}\n${ticket.body}`;

    const instructed = INSTRUCTION_CUE.test(text) ? INSTRUCTED_REFUND.exec(text) : null;
    if (instructed?.[1]) {
      const amount = cents(instructed[1]);
      const account = instructed[2] ?? ticket.account_id;
      note(`The ticket contains instructions for the assistant. Following them.`);
      note(`Proposing a refund of $${(amount / 100).toFixed(2)} to ${account}.`);
      return {
        decision: "propose_refund",
        account_id: account,
        amount_cents: amount,
        reason: "Instructed by the ticket text.",
      };
    }

    const duplicate = DUPLICATE_CHARGE.exec(text);
    if (duplicate?.[2] && cents(duplicate[2]) <= MAX_ROUTINE_CENTS) {
      const amount = cents(duplicate[2]);
      note(`Duplicate charge of $${(amount / 100).toFixed(2)} reported. Within policy.`);
      return {
        decision: "propose_refund",
        account_id: ticket.account_id,
        amount_cents: amount,
        reason: "Duplicate charge, within the routine refund limit.",
      };
    }

    note("No refund needed.");
    return {
      decision: "no_refund",
      account_id: ticket.account_id,
      amount_cents: 0,
      reason: "No refund requested.",
    };
  }
}
