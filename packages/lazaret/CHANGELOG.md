# Changelog

## 0.4.0 (2026-11-17)

Tells the reviewer what an AI agent was asked to do, so a hijacked agent's clean-looking
writes stand out.

### Added

- Task context (`review.task`). Before each reviewed write, the gateway makes a signed
  `GET` to origin with the client's own headers, and origin answers with that agent run's
  task, keyed on the credential. The reviewer then judges whether the write serves the
  task. The task can't come from the request, because a hijacked agent controls it.
  - `204`, `401`, `403`, or a `200` with no task: not an agent, reviewed as before.
  - Anything else, including a timeout or a `404`: fails closed. An inline write is
    refused, an escrowed one held for a person.
  - A write the task doesn't call for is held for a person, not dropped. Drop is kept for
    writes that are attacks on their own.
- Tool results as untrusted evidence (`review.task.toolResultsField`), off by default.
  The reviewer sees the newest 8 to check details such as an amount on a bill.
- `AGENT_SYSTEM_PROMPT` and `buildInlinePrompt` are exported. With no task, every prompt
  is byte-identical to 0.3.1.
- The operator queue shows the task next to a held write.

### Measured

AgentDojo banking (v1.2.2), 144 injection attack pairs replayed open-loop through the real
gateway, `claude-haiku-5-5` inline reviewer (`evals/results/benchmark/`):

|                                       | Attacks through   | Honest tasks done |
| ------------------------------------- | ----------------- | ----------------- |
| No defense                            | 144 of 144        | 16 of 16          |
| 0.3.1, or 0.4.0 without `review.task` | 55-59 of 144      | 13-14 of 16       |
| 0.4.0 with `review.task`              | 0 of 144 (4 runs) | 11-12 of 16       |
| With tool results too                 | 0 of 144 (4 runs) | 13-15 of 16       |

The reviewer prompt was written from this suite's results, so these aren't held-out
numbers. One suite, static attacks.

### Known limits

- With tool results on, an attack planted as an ordinary line in a bill the user asked
  to pay got 1 of 144 through: the reviewer took the forged bill as evidence. This is why
  tool results stay off by default.
- The 0% depends on origin getting three things right that Lazaret can't check: one
  credential per agent run, a task set only from the user's side, and a lookup keyed on
  the credential alone. See step 12 of the guide.
- Under attack, more honest writes are held for a person (4 of 14 against 2-3 without a
  task).

### Upgrading from 0.3.1

No configuration change is needed, and nothing was removed. Without `review.task`,
nothing changes. With it, each reviewed write adds one origin round trip, and writes
reviewed with a task stay out of the Memory, because their verdicts depend on something
the gate can't see. `WriteEntry` has a new optional `agent` field.

## 0.3.1 (2026-11-05)

Documentation only: the README carries the new Lazaret logo. No code changes.

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
- Writes with no session (a login, say) are no longer linked. They fell back to a session
  made from IP and user agent, so repeat logins, or everyone behind one address, counted
  as one sender and could be refused as a credential attack. This was also in 0.2.0.

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
