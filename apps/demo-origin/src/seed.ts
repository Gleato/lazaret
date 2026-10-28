// The hourly demo reset (M7). The public demo wipes everything visitors wrote and
// restores the seed data, so each hour starts clean. Called only by the demo guard in
// apps/demo-lazaret over the service binding, signed, at `POST /admin/reset`, a path
// Lazaret BLOCKs at the edge: no visitor request can reach it, escrowed or not.
//
// The seed below is migrations/0002_seed.sql verbatim (the migration stays the source
// for fresh databases). test/origin.test.ts checks a reset database matches a freshly
// migrated one, so the two can't drift.

export const SEED_SQL = `INSERT INTO accounts (id, email, display_name, role, password_hash, balance_cents, created_at) VALUES
  ('acct_mara', 'mara@tidewater.test', 'Mara Quinn', 'customer',
   'pbkdf2$100000$mara-salt-0001$7d025f747001851796184e58c087bd8adb8817904b83721e0be3962f43ba81cc', 0, 1793059200000),
  ('acct_theo', 'theo@tidewater.test', 'Theo Park', 'customer',
   'pbkdf2$100000$theo-salt-0002$1d5e3c74aeba9f355f9277a7bea0052c73ee210c3953bac3ad2a847254b59ea0', 1500, 1793059200000),
  ('acct_sam', 'sam@tidewater.test', 'Sam Rivera', 'agent',
   'pbkdf2$100000$sam-salt-00003$214eb98f2ed2eae1e2793c01bd6b347c83ea3a060c50b64a84a4582107e9edbd', 0, 1793059200000);

INSERT INTO tickets (id, account_id, subject, body, status, created_at, updated_at) VALUES
  ('tkt_seed_1', 'acct_theo', 'Charged twice for March',
   'Hi, my card shows two charges of $24.00 on March 3rd for the same plan. Could you refund the duplicate? Order TW-88412.',
   'open', 1793062800000, 1793062800000),
  ('tkt_seed_2', 'acct_mara', 'Export to CSV times out',
   'When I export more than about 5,000 rows the download spins and then fails with "Gateway Timeout". Smaller exports work.',
   'answered', 1793066400000, 1793070000000);

INSERT INTO replies (id, ticket_id, author_id, body, created_at) VALUES
  ('rpl_seed_1', 'tkt_seed_2', 'acct_sam',
   'Thanks Mara, we can reproduce this and a fix is rolling out this week. As a workaround, filter by month and export in parts.',
   1793070000000);
`;

/** Tables in delete order (children first, so foreign keys hold). */
const TABLES = [
  "refund_proposals",
  "attachments",
  "replies",
  "credits",
  "api_keys",
  "auth_tokens",
  "tickets",
  "lazaret_requests",
  "accounts",
];

export async function resetDemo(db: D1Database): Promise<void> {
  const statements = SEED_SQL.split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  // One batch is one transaction: the demo is never seen half-reset.
  await db.batch([
    ...TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)),
    ...statements.map((s) => db.prepare(s)),
  ]);
}
