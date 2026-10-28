# Lazaret

**An AI quarantine for your writes.**

In 15th-century Venice, ships arriving at port were held at a _lazaretto_, an island
quarantine station, until inspectors cleared their cargo. Contaminated goods were
burned, and clean goods entered the city.

Lazaret applies the same idea to your API. It is an edge harness on Cloudflare
Workers that holds every write bound for your origin in a stateful ledger. An
independent Claude reviewer vets each batch, and only writes that pass reach your
server. Writes that fail are dropped, along with anything that depends on them.

> **Status: early development.** The library (Ledger, gateway and gate, Claude reviewer,
> review workflow, signed committer, read overlay, self-improving memory), the Tidewater
> Support demo app and the eval suite are built and tested. The public site and live demo
> come next, at [gleator.com](https://gleator.com).

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
        QUARANTINED → APPROVED → COMMITTED   (a human releases it)
        QUARANTINED → DROPPED                 (a human drops it)
```

The state machine is a pure reducer
([`machine.ts`](packages/lazaret/src/ledger/machine.ts)) with no I/O, clock or
randomness. The Durable Object
([`durable-object.ts`](packages/lazaret/src/ledger/durable-object.ts)) is a thin
shell that persists events atomically in SQLite and replays them on startup.

## Put Lazaret in front of your own API

Lazaret is a Cloudflare Worker that sits in front of your origin. The worked example
is [Tidewater Support](apps/demo-origin), a helpdesk that knew nothing about Lazaret,
and [its Lazaret deployment](apps/demo-lazaret). The steps below follow that example.

**1. Describe your routes.** One config holds the whole policy. Each route is passed
through, reviewed inline, escrowed, or blocked. Escrowed writes declare the resources
they touch, so dropping one drops what depends on it.

```ts
// lazaret.config.ts (from apps/demo-lazaret/src/config.ts)
import { defineLazaret } from "@gleator/lazaret";

export const config = defineLazaret({
  origin: "https://api.example.com",
  session: { header: "authorization" }, // your login is Lazaret's session (hashed)
  routes: [
    { match: "POST /api/login", policy: "INLINE_REVIEW" },
    { match: "POST /api/accounts/:id/credits", policy: "INLINE_REVIEW" },
    {
      match: "POST /api/tickets",
      policy: "ESCROW",
      resources: ["ticket:{receipt}"],
      overlay: { on: "GET /api/tickets", merge: "append-json-array", path: "tickets" },
    },
    { match: "POST /api/tickets/:id/replies", policy: "ESCROW", resources: ["ticket:{id}"] },
    { match: "* /admin/*", policy: "BLOCK" },
    { match: "GET /*", policy: "PASS" },
  ],
});
```

Unmatched writes are escrowed, not passed, so a route you forgot is still quarantined.
`overlay` shows authors their own pending writes (and nobody else), so the app doesn't
feel broken while a write waits for review.

**2. Deploy the gateway.** Subclass the three runtime classes to hand them your config,
and export the gateway. See [`apps/demo-lazaret/src/index.ts`](apps/demo-lazaret/src/index.ts)
and its [`wrangler.jsonc`](apps/demo-lazaret/wrangler.jsonc) for the bindings
(a Ledger and a Memory Durable Object, a review Workflow, and a cron for the recovery sweep).

```ts
export class Ledger extends LazaretLedger {}
export class Memory extends LazaretMemory {}
export class ReviewWorkflow extends LazaretReviewWorkflow<Env> {
  protected override lazaretConfig() {
    return config;
  }
}
const gateway = createGateway(config);
export default { fetch: gateway.fetch, scheduled: gateway.scheduled };
```

**3. Make origin refuse anything that didn't come through Lazaret.** Otherwise an
attacker just skips the edge. Every request Lazaret sends is HMAC-signed, and the
signature covers the method, path, query, body and a timestamp.

```ts
import { verifyLazaretRequest } from "@gleator/lazaret/origin";

const check = await verifyLazaretRequest(request, env.LAZARET_SIGNING_SECRET);
if (!check.ok) return new Response("Forbidden", { status: 403 });
// check.id is the Ledger entry id: an idempotency key for writes.
```

**4. Dedupe writes by `x-lazaret-id`.** The Committer retries after crashes and
network errors, so the same write can arrive twice. Store each write's response in
the same transaction as the write and replay it on a repeat. Tidewater does this in
one small module: [`apps/demo-origin/src/dedupe.ts`](apps/demo-origin/src/dedupe.ts).

**5. Use the receipt as the id of what a write creates (optional, recommended).** An
escrowed write answers `202` with a receipt. If origin uses that receipt as the new
resource's id, clients can refer to it before it commits (a reply to a pending
ticket), and `ticket:{receipt}` lets taint link the two. Commits replay in order
within a batch, so the reference resolves.

**6. Set the secrets** (`wrangler secret put`, never in code): `LAZARET_SIGNING_SECRET`
(at least 16 characters, the same value on gateway and origin) and `ANTHROPIC_API_KEY`.
Add `LAZARET_OPERATOR_TOKEN` (at least 16 characters) to turn on the review queue below.

**7. Work the review queue.** Writes the reviewer can't settle, or won't review, are held
for a human. With the operator token as a bearer token:

```bash
curl -H "authorization: Bearer $TOKEN" https://your.site/__lazaret/operator/queue
curl -X POST -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"action":"release","note":"real customer"}' \
  https://your.site/__lazaret/operator/entries/<id>
```

`release` commits the held write to origin, `drop` discards it and the held writes that
depend on it, and `report` marks a write that was already committed as an attack the
reviewer missed. Every decision is labelled into the Memory as ground truth, so the gate
also learns from the reviewer's mistakes. Resolve held writes while the author's session
token is still valid: the Committer replays their original headers.

**8. Decide what an inline route does when the reviewer can't be reached.** Inline review
fails closed by default (`503`). For a route where an outage costs more than the risk, set
`onReviewUnavailable: "gate"`: a request the gate found nothing at all on goes through
(tagged `x-lazaret-review: degraded`), anything else still waits. A model that declines
or answers garbage is never treated as unreachable. Tidewater does this for login only.

### Try it locally

The demo runs offline with a scripted reviewer in place of Claude, so it needs no API
key and costs nothing:

```bash
npm run dev -w @gleator/tidewater-lazaret
```

Open http://localhost:8787 and sign in as Mara (customer) or Sam (support agent).

## Evals

[`evals/`](evals) holds a labelled corpus of 120 cases: 63 attacks and 57 benign
requests, including hard negatives such as tickets that quote SQL errors or mention
`localhost`. The attacks include prompt injection aimed at Lazaret's own reviewer and
indirect injection aimed at Tidewater's AI support agent. The runner pushes the corpus
through the real gateway, Ledger and review pipeline, and reports precision, recall,
false-positive rate, latency, time to first token and cost.

Latest live run (2026-10-28; Sonnet 5.5 batch review, Opus 5.5 escalation, Haiku 5.5
inline; [`evals/results/live-latest.json`](evals/results/live-latest.json)):

|                                                           |                                                     |
| --------------------------------------------------------- | --------------------------------------------------- |
| Attacks stopped (recall)                                  | 63 / 63 (100%)                                      |
| Precision                                                 | 98.4%                                               |
| Benign requests stopped (FPR)                             | 1 / 57 (1.8%): a credit whose review hit the 3 s deadline |
| Reviewer prompt injection / downstream agent injection    | 8 / 8 and 10 / 10 stopped                           |
| Stopped by the deterministic gate alone, before any model | 5 / 63, with 0 false positives                      |
| Escalations declined by Opus 5.5                          | 3 / 7, all `cyber`, all attacks, all held for a human |
| Inline review latency                                     | p50 1.7 s, p95 2.5 s; time to first token p50 1.2 s |
| Batch review latency                                      | p50 4.3 s, p95 10.4 s (off the request path)        |
| Cost                                                      | $0.25 per run, $2.28 per 1,000 reviewed requests    |

The false positive is a legitimate credit that failed closed: its inline review took
longer than the 3 s deadline (2 of 11 credit reviews did), and credits deny rather than
pass on the gate alone. Only the model you configure can decide an outcome. When it
declines to review a payload, the entry is held for a human with the API's reason (here
`cyber`), and a human releases or drops it from the review queue. A declined batch is
split until the declined entry is isolated, so the rest still get real verdicts. Any
first-pass allow the gate scored at 0.7 or above gets a second opinion. One corpus, one
run: treat these as a measurement, not a guarantee. Every live run is kept in
[`evals/results/`](evals/results).

```bash
npm run eval:gate        # deterministic modes, free: evals/results/{gate-only,fake}.json
EVAL_CONFIRM_SPEND=yes npm run eval:live   # real Claude, about $0.25, capped by EVAL_MAX_USD
```

## Development

Requires Node 22+.

```bash
npm install
npm test          # Vitest inside workerd: real SQLite, D1, alarms and eviction
npm run typecheck
npm run lint
```

The test suite covers illegal transitions, atomic rollback, and crash recovery: it
evicts a live Durable Object mid-review and checks that the rebuilt state is
identical and that no write is committed twice.

## Roadmap

- [x] M1: Ledger core (event log, state machine, seal triggers, crash recovery)
- [x] M2: Gate and route policies
- [x] M3: Claude reviewer, review workflow, committer, taint propagation
- [x] M4: Author-only read overlay
- [x] M5: Memory distillation and rule promotion
- [x] M6: Demo origin (Tidewater Support helpdesk) and evals, plus the human review queue
- [ ] M7–M8: gleator.com live demo and launch

The full spec is in [`tasks/todo.md`](tasks/todo.md).

## License

[MIT](LICENSE)
