-- Refund proposals from Tidewater's AI support agent. Proposals only: the agent
-- can't move money. A human agent approves one by issuing a credit, which goes
-- through Lazaret's inline review like any other credit.
CREATE TABLE refund_proposals (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets (id),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  decision TEXT NOT NULL CHECK (decision IN ('propose_refund', 'no_refund', 'escalate')),
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
