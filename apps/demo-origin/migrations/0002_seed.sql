-- Demo data. All three accounts use the public demo password "tidewater-demo"
-- (PBKDF2-SHA256, 100k iterations). These are test credentials for a demo app,
-- not secrets.
INSERT INTO accounts (id, email, display_name, role, password_hash, balance_cents, created_at) VALUES
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
