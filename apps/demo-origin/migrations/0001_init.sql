-- Tidewater Support schema.
--
-- Ids of anything a client creates (tickets, replies, attachments, credits) are the
-- Lazaret entry id (`x-lazaret-id`) of the write that created it. That is the
-- "receipt id convention" (tasks/todo.md §9, M6 step B): a client can address a
-- ticket by its receipt before it commits, and the reference resolves once it does.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer', 'agent', 'admin')),
  password_hash TEXT NOT NULL,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  email_notifications INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Session tokens are stored hashed, so a database leak doesn't leak sessions.
CREATE TABLE auth_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'resolved')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX tickets_by_account ON tickets (account_id, created_at);

CREATE TABLE replies (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id),
  author_id TEXT NOT NULL REFERENCES accounts (id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX replies_by_ticket ON replies (ticket_id, created_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id),
  author_id TEXT NOT NULL REFERENCES accounts (id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_base64 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE credits (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  issued_by TEXT NOT NULL REFERENCES accounts (id),
  created_at INTEGER NOT NULL
);

-- Write dedupe. Lazaret's Committer may re-send a write after a crash, with the
-- same `x-lazaret-id`. The first response is stored here, in the same D1 batch as
-- the write itself, and replayed verbatim on any re-send.
CREATE TABLE lazaret_requests (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
