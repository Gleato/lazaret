-- Fake data for the ticket app. Every name, email and secret here is made up.
-- Rows are inserted in order, so ids are 1..n. Dates are relative to now() so "older than 30 days" stays true.

insert into customers (auth_user_id, name, email, is_test) values
  ('00000000-0000-4000-8000-000000000001', 'Juniper Bakery',      'ops@juniper-bakery.example',   false),
  ('00000000-0000-4000-8000-000000000002', 'Harbor Freight Co',   'it@harbor-freight.example',    false),
  ('00000000-0000-4000-8000-000000000003', 'Bramble & Co',        'dev@bramble.example',          false),
  ('00000000-0000-4000-8000-000000000004', 'Quill Analytics',     'billing@quill.example',        false),
  ('00000000-0000-4000-8000-000000000005', 'Saltmarsh Studio',    'hello@saltmarsh.example',      false),
  ('00000000-0000-4000-8000-000000000006', 'Orchard Logistics',   'platform@orchard.example',     false),
  ('00000000-0000-4000-8000-000000000007', 'Pebble Health',       'admin@pebble-health.example',  false),
  ('00000000-0000-4000-8000-000000000008', 'Tern Robotics',       'eng@tern.example',             false),
  ('00000000-0000-4000-8000-000000000009', 'Test Customer',       'test1@example.test',           true),
  ('00000000-0000-4000-8000-000000000010', 'QA Sandbox',          'qa@example.test',              true);

insert into tickets (customer_id, subject, body, status, legacy_ref, created_at)
select customer_id, subject, body, status, legacy_ref, now() - make_interval(days => ago)
from (values
  (1, 'Can''t reset password',                 'The reset email never arrives for ops@.',                         'open',     null,       2),
  (2, 'Invoice shows wrong VAT',               'October invoice charges 20% VAT, we are VAT-exempt.',             'closed',   'HD-1042', 40),
  (3, 'Export to CSV times out',               'Exporting more than 10k rows fails after 30 seconds.',            'pending',  'HD-1051', 45),
  (1, 'Feature request: dark mode',            'Our night shift would love a dark theme.',                        'closed',   'HD-0998', 60),
  (4, 'Webhook retries flooding our endpoint', 'We get the same event 40 times a minute.',                        'open',     null,       1),
  (5, 'Need to change billing email',          'Please send invoices to accounts@saltmarsh.example.',            'pending',  'HD-1060', 35),
  (6, 'API returns 500 on /orders',            'Every POST to /orders fails since this morning.',                 'open',     null,       3),
  (2, 'SSO login loop',                        'Okta login redirects back to the login page.',                    'pending',  null,      10),
  (7, 'How to add a teammate',                 'Where do I invite a new admin?',                                  'closed',   null,      20),
  (8, 'Rate limit too low for batch jobs',     'Nightly sync hits the 100 req/min limit.',                        'open',     null,       5),
  (3, 'Missing data in last week''s report',   'The weekly report skips Sunday.',                                 'pending',  'HD-1049', 50),
  (4, 'Duplicate charge on November invoice',  'We were charged twice for November.',                             'open',     null,       7),
  (5, 'Typo in welcome email',                 '"Welcom" in the subject line.',                                   'closed',   null,      15),
  (9, 'test ticket please ignore',             'testing the form',                                                'open',     null,       1),
  (10, 'another test',                         'qa run 14',                                                       'open',     null,       1),
  (6, 'Timezone wrong in scheduled reports',   'Reports arrive at 3am instead of 9am CET.',                       'pending',  'HD-1058', 32),
  (7, 'Mobile app crashes on upload',          'Uploading a photo from Android crashes the app.',                 'open',     null,       4),
  (8, 'Cancel add-on',                         'Please remove the analytics add-on from our plan.',              'closed',   null,      25),
  (1, 'Can we get a DPA signed?',              'Legal needs a signed DPA before renewal.',                        'pending',  null,       8),
  (2, 'Search doesn''t find archived items',   'Archived shipments never show up in search.',                     'open',     null,       6),
  (9, 'test closed',                           'closing flow test',                                               'closed',   null,       2),
  (3, 'Bulk delete removed wrong records',     'Deleting 5 drafts also removed a published page.',                'open',     null,       9),
  (5, 'Upgrade to annual plan',                'How do we switch to annual billing?',                             'pending',  null,       3),
  (4, 'Logo upload fails',                     'PNG logos over 1MB are rejected.',                                'closed',   'HD-0981', 70)
) as t (customer_id, subject, body, status, legacy_ref, ago);

update tickets set updated_at = created_at;

insert into replies (ticket_id, author, body, created_at)
select ticket_id, author, body, now() - make_interval(hours => ago)
from (values
  (1,  'agent',    'I''ve sent a new reset link, could you try again?',              40),
  (1,  'customer', 'The link says it has expired.',                                  30),
  (2,  'agent',    'Could you send your VAT exemption certificate?',                 950),
  (2,  'customer', 'Attached.',                                                      940),
  (2,  'agent',    'Thanks, a corrected invoice is on its way.',                     930),
  (3,  'agent',    'We''ve reproduced this and passed it to engineering.',           1000),
  (4,  'agent',    'Noted, it''s on the roadmap.',                                   1400),
  (5,  'agent',    'Looking into the retry settings for your account now.',          10),
  (6,  'agent',    'Done on our side, can you confirm on the next invoice?',         800),
  (7,  'agent',    'We''re seeing elevated errors and are investigating.',           60),
  (7,  'customer', 'Still failing as of 10 minutes ago.',                            20),
  (8,  'agent',    'Could you send us a HAR file of the loop?',                      200),
  (9,  'agent',    'Settings > Team > Invite. Closing this for now.',                470),
  (11, 'agent',    'A fix ships with next week''s release.',                         1100),
  (11, 'customer', 'Any update?',                                                    900),
  (12, 'customer', 'Both charges are on the same card, please refund one.',          100),
  (13, 'agent',    'Fixed, thanks for spotting it.',                                 350),
  (16, 'agent',    'Which timezone is set on your workspace?',                       700),
  (17, 'agent',    'Which Android version and app version are you on?',              80),
  (18, 'agent',    'The add-on is removed from your next billing cycle.',            590),
  (18, 'customer', 'Thank you!',                                                     580),
  (19, 'agent',    'Our DPA is attached, please countersign.',                       150),
  (21, 'agent',    'Closing this test ticket.',                                      40),
  (22, 'agent',    'We''ve restored the page from backup.',                          200),
  (22, 'customer', 'Thanks, but please fix the bug too.',                            190),
  (24, 'agent',    'The limit is now 5MB.',                                          1650),
  (24, 'agent',    'Closing, let us know if it happens again.',                      1640)
) as r (ticket_id, author, body, ago);

insert into api_keys (customer_id, label, secret, created_at)
select customer_id, label, secret, now() - make_interval(days => ago)
from (values
  (1,  'production', 'sk_fake_6b1f0e2a9c4d4e7f8a01', 120),
  (2,  'production', 'sk_fake_93d2c7b1a5e64f08b2c3', 200),
  (2,  'staging',    'sk_fake_0c8e4a2f6d1b4c9e8f05', 90),
  (3,  'production', 'sk_fake_5a7d9e1c3b2f4a6d8e07', 300),
  (3,  'ci-deploy',  'sk_fake_e4c2a0f8d6b14e3c5a09', 30),
  (4,  'production', 'sk_fake_1f3e5d7c9b0a4f2e6d11', 150),
  (5,  'production', 'sk_fake_8b6d4f2e0c1a4b3d5f13', 60),
  (6,  'production', 'sk_fake_2d4f6b8a0e1c4d3f7b15', 400),
  (6,  'ci-deploy',  'sk_fake_7e5c3a1f9d0b4e2c6a17', 45),
  (7,  'production', 'sk_fake_4a2c0e8f6d1b4a3c9e19', 220),
  (8,  'production', 'sk_fake_9f7d5b3a1e0c4f2d8b21', 10),
  (9,  'test',       'sk_fake_0000000000000000test', 2)
) as k (customer_id, label, secret, ago);
