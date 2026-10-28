# Lazaret

**An AI quarantine for your writes.**

In 15th-century Venice, ships arriving at port were held at a *lazaretto*, an island
quarantine station, until inspectors cleared their cargo. Contaminated goods were
burned, and clean goods entered the city.

Lazaret applies the same idea to your API. It is an edge harness on Cloudflare
Workers that holds every write bound for your origin in a stateful ledger. An
independent Claude reviewer vets each batch, and only writes that pass reach your
server. Writes that fail are dropped, along with anything that depends on them.

> **Status: early development.** The Ledger core (M1) is built and tested. The gate,
> reviewer and committer come next. A live demo will run at
> [gleator.com](https://gleator.com).

## How it works

```
client ─▶ Gateway Worker
            ├─ Inline gate (deterministic, <5ms) → risk score
            ├─ Route policy: PASS │ INLINE_REVIEW │ ESCROW │ BLOCK
            └─ Reads: origin + author-only view of their own pending writes
                         │
                Ledger (Durable Object): append-only event log + state machine
                  seals a batch on timer │ size │ risk spike
                         │
                Reviewer (Claude): no tools, no network, JSON verdicts only
                         │
                Committer: replays approved writes to origin, HMAC-signed, idempotent
                         │
                Memory: verdicts → candidate rules → backtest → promoted into the gate
```

**Design principles**

1. **The harness owns the loop.** The Ledger runs the state machine. The reviewer is
   sandboxed and can only return verdicts.
2. **The brain is separate from the hands.** The reviewer judges, and a separate
   committer acts. A prompt-injected reviewer has nothing to act with.
3. **The log is the source of truth.** State is rebuilt by replaying the event log, so
   a crash or eviction loses nothing that was acknowledged.
4. **Retry instead of restarting.** Reviews retry from checkpoints, and commits are
   idempotent and safe to replay.
5. **Learn from the logs.** Patterns the reviewer confirms become cheap deterministic
   rules, so the system gets smarter and cheaper over time.

## Ledger lifecycle

```
Batch:  OPEN → SEALED → REVIEWING → COMMITTING → SETTLED
                 └──────→ REVIEW_FAILED ─┘ (retry)
        SEALED | REVIEWING | REVIEW_FAILED → QUARANTINED (fail closed)

Entry:  PENDING → APPROVED → COMMITTED
        PENDING → DROPPED | QUARANTINED
```

The state machine is a pure reducer
([`machine.ts`](packages/lazaret/src/ledger/machine.ts)) with no I/O, clock or
randomness. The Durable Object
([`durable-object.ts`](packages/lazaret/src/ledger/durable-object.ts)) is a thin
shell that persists events atomically in SQLite and replays them on startup.

## Development

Requires Node 22+.

```bash
npm install
npm test          # Vitest inside workerd: real SQLite, alarms and eviction
npm run typecheck
npm run lint
```

The test suite covers illegal transitions, atomic rollback, and crash recovery: it
evicts a live Durable Object mid-review and checks that the rebuilt state is
identical and that no write is committed twice.

## Roadmap

- [x] M1: Ledger core (event log, state machine, seal triggers, crash recovery)
- [ ] M2: Gate and route policies
- [ ] M3: Claude reviewer, review workflow, committer, taint propagation
- [ ] M4: Author-only read overlay
- [ ] M5: Memory distillation and rule promotion
- [ ] M6: Demo origin (Tidewater Support helpdesk) and evals
- [ ] M7–M8: gleator.com live demo and launch

The full spec is in [`tasks/todo.md`](tasks/todo.md).

## License

[MIT](LICENSE)
