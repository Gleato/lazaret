# Changelog

## 0.3.0 (2026-11-05)

Learns split fraud: claims that each look honest, spread across requests.

### Added

- Count signals. With `link` on, the gateway adds zero-weight
  `linked.sender_route_1h` and `linked.resource_route_1h` signals. They never move risk
  on their own. Rules and the reviewer read them. `GateSignal.value` carries the count.
- A `hold` rule action. A matching write goes to a person with no model call. On an
  ESCROW route it waits in the queue. On an INLINE_REVIEW route, which can't queue, it is
  refused with `403 held_for_review`. Limited to 5 holds per sender per hour, after which
  writes go to the reviewer.
- Counting rules in the Memory. A rule that reads `signal:linked.*` must have a `path`
  condition, and it climbs shadow, flag, hold. It never reaches block.
- The distiller is told about count signals, so it can propose counting rules.

### Fixed

- An inline route with `onReviewUnavailable: "gate"` no longer treats a count signal as
  evidence, so repeat logins don't fail closed during a reviewer outage.
- A batch made up only of held writes is now opened for review, so its verdicts record.

### Measured

Pattern eval, live, four waves of 8 attack plays and 8 honest look-alikes
(`evals/results/pattern-latest.json`, $0.45). 8 of 8 attacks stopped in every wave. A rule
was learned in wave 1 and reached hold in wave 2. It held 6 claims per wave after that,
which took model reads from 56 to 42, and held no honest write.

### Known limit

The reviewer stopped 3 of 8 honest look-alikes per wave: an agent crediting several
customers (refused inline, 7 of the 12) and a customer with two genuine claims (held for a
person, 5 of the 12). These plays are built to look like fraud, so this isn't a rate for
ordinary traffic. It comes from the reviewer's linked history, not from the new rules.

### Upgrading from 0.2.0

No configuration change is needed, and nothing was removed.

- Count signals and counting rules need `link`. Without it, nothing changes.
- With `link`, each write adds one Ledger round trip, shown as `Server-Timing: links`.
- Clients of inline routes can now get `403 held_for_review`.
- `hold` is a new member of the rule action and status types, so an exhaustive `switch`
  over them needs a new case.

## 0.2.0 (2026-11-05)

### Added

- Linked history (`link`). The reviewer sees a write's recent writes from the same
  session, account or resource, across batches, so fraud split across requests shows up
  as a pattern. Other senders' writes on a shared resource are shown only if allowed.

## 0.1.0 (2026-11-01)

First release: the gate, route policies, the Ledger, the Claude reviewer, the Committer,
the author-only read overlay, the human review queue and the Memory.
