# Lazaret

**An AI quarantine for your writes.**

In 15th-century Venice, ships arriving at port were held at a _lazaretto_, an island
quarantine station, until inspectors cleared their cargo. Contaminated goods were
burned, and clean goods entered the city.

Lazaret applies the same idea to your API. It is an edge harness on Cloudflare
Workers that holds every write bound for your origin in a stateful ledger. An
independent Claude reviewer vets each batch, and only writes that pass reach your
server. Writes that fail are dropped, along with anything that depends on them.

> **Status: the demo is live.** [demo.gleator.com](https://demo.gleator.com) is the
> Tidewater Support helpdesk behind a real Lazaret deployment, on live Claude models. A
> Playwright suite checks it in production: every canned attack is kept out of
> Tidewater's database, and honest writes get through. The library is
> [`@gleator/lazaret`](packages/lazaret) 0.1.0. The gleator.com site launches with a
> redesign.

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

The log doesn't grow forever. Past 2,000 events, the Ledger snapshots its projection,
replays from snapshot + tail, and keeps only the last 500 events for live viewers
([`compaction.ts`](packages/lazaret/src/ledger/compaction.ts)). It prunes a batch only
when the batch is settled, every entry is committed or dropped, and it is older than a
retention window (7 days by default). A batch holding anything a human still has to
decide is never pruned. A property test replays random histories and checks that the
compacted state equals a full replay, apart from the pruned batches.

## Put Lazaret in front of your own API

Lazaret is a Cloudflare Worker that sits in front of your origin. The worked example
is [Tidewater Support](apps/demo-origin), a helpdesk that knew nothing about Lazaret,
and [its Lazaret deployment](apps/demo-lazaret). The steps below follow that example.

```bash
npm install @gleator/lazaret
```

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

The Memory also asks for a label when a learned rule and the reviewer disagree: a rule
matched a write that only a model allowed. Rules see the decoded request, so the rule
may have caught something the reviewer missed, or the rule may be too broad. No model
breaks the tie. The rule waits until you label the write:

```bash
curl -H "authorization: Bearer $TOKEN" https://your.site/__lazaret/operator/disputes
curl -X POST -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"label":"attack","category":"xss"}' \
  https://your.site/__lazaret/operator/disputes/<entryId>
```

An `attack` label counts as evidence for the rule; a `benign` one rejects or retires it.
A disputed write nobody labels within 3 days (`trustAllowsAfterMs`) is taken as clean.

**8. Decide what an inline route does when the reviewer can't be reached.** Inline review
fails closed by default (`503`). For a route where an outage costs more than the risk, set
`onReviewUnavailable: "gate"`: a request the gate found nothing at all on goes through
(tagged `x-lazaret-review: degraded`), anything else still waits. A model that declines
or answers garbage is never treated as unreachable. Tidewater does this for login only.

**9. Cap what the reviewer can spend.** `review.dailyBudgetUsd` (default $5) is enforced
from real token usage across every tier. Once the day's budget is spent, inline routes
treat the reviewer as unreachable (step 8 decides), escrowed batches wait sealed until the
next UTC day, and rule distillation pauses. Nothing is committed unreviewed. The counter
lives in its own Ledger instance (`review.budgetShard`).

**10. Optionally, show it.** `live: { enabled: true }` turns on a read-only public view:
a WebSocket stream of the Ledger at `/__lazaret/live`, plus `/__lazaret/status`,
`/__lazaret/queue` and `/__lazaret/memory`. Everything in it is a redacted projection: no
headers, tokens, IPs or queries, 8-character session hashes, and bodies cut to
`live.bodyPreviewChars`. Acting on the queue still needs the operator token.

**11. Link writes across batches (recommended where writes move money).** By default
the reviewer judges each batch on its own, so fraud split across batches (five honest-
looking refund claims, 30 s apart) never looks like a pattern. `link: {}` ties each write
to earlier ones by session, by account (from `review.actor`) and by any route resource
with a parameter (for a credit, `account:{id}`: the account being paid), and shows the
reviewer the recent linked writes with their paths and verdicts
([`links.ts`](packages/lazaret/src/ledger/links.ts)). From other senders it shows only
writes that were allowed, so an attacker can't get a victim's honest writes held by
attacking their account first. The reviewer is told a pattern is evidence, not proof:
it holds for a person rather than dropping. Defaults: 24 h window, 8 earlier writes,
160-character previews. It costs extra prompt tokens and, for escrowed writes, one
account lookup per session.

**12. Share behaviour counts across isolates (recommended in production).** Rate,
timing and failure scoring is per isolate by default, and Cloudflare can spread one
client across several isolates. That client is often a credential-stuffing swarm.
`behaviour: { store: "durable" }`, with a `LazaretBehaviour` Durable Object bound as
`LAZARET_BEHAVIOUR`, gives every session and IP one shared window
([`behaviour-durable.ts`](packages/lazaret/src/gate/behaviour-durable.ts)). The gate never
waits on it. It scores from the isolate's own samples plus the last shared window, and
syncs in the background, so the shared view lags by one request. On the live demo
(2026-11-01), the lookup reports 0 ms at p50 and p95 in its `Server-Timing` header.
The first version awaited the Durable Object behind a 25 ms deadline, which it hit at
p50 _and_ p95, so that version was replaced.

### Deploy it

The live demo is three Workers in one Cloudflare account:

| Host               | Worker                                                                                            | Config                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `demo.gleator.com` | `tidewater-lazaret`: the gateway, Ledger, Memory, behaviour store, review Workflow and demo guard | [`apps/demo-lazaret/wrangler.jsonc`](apps/demo-lazaret/wrangler.jsonc) |
| none               | `tidewater-origin`: reachable only through the gateway's service binding, on D1                   | [`apps/demo-origin/wrangler.jsonc`](apps/demo-origin/wrangler.jsonc)   |
| `gleator.com`      | `gleator-site`: the static site (launching with a redesign)                                       | [`apps/site/wrangler.jsonc`](apps/site/wrangler.jsonc)                 |

```bash
npx wrangler login
npx wrangler d1 create tidewater          # put the id in apps/demo-origin/wrangler.jsonc
npm run db:migrate:remote -w @gleator/tidewater-origin
npm run deploy:origin                     # first: it is the gateway's binding target
npm run deploy:demo
```

Secrets go in with `npx wrangler secret put <NAME> -c <config>`. Never put them in code.

- origin: `LAZARET_SIGNING_SECRET` and `ANTHROPIC_API_KEY` (Tidewater's own agent).
- gateway: the same `LAZARET_SIGNING_SECRET`, plus `ANTHROPIC_API_KEY`, `TURNSTILE_SECRET`
  and `LAZARET_OPERATOR_TOKEN`.

The signing secret is shared and must be identical on both; `openssl rand -base64 48`
makes a good one. The Turnstile site key is public, so it lives in the config. Custom
domains create their own DNS records and certificates.

### Try it locally

The demo runs offline with a scripted reviewer in place of Claude, so it needs no API
key and costs nothing:

```bash
npm run dev -w @gleator/tidewater-lazaret
```

Open http://localhost:8787 and sign in as Mara (customer) or Sam (support agent). For
the gleator.com site and its live demo, run this as well and open http://localhost:4321:

```bash
npm run dev -w @gleator/site
```

The public demo sits behind a guard (`apps/demo-lazaret/src/guard.ts`): writes need a
Turnstile pass, there are per-IP rate limits and a $0.25 daily share per IP, Tidewater's
AI agent runs count against the same $10 daily cap, and the demo resets every hour. In
local dev the guard uses Cloudflare's always-pass Turnstile test keys. To trigger the
hourly reset by hand, call `http://localhost:8787/__scheduled?cron=0+*+*+*+*`.

## Evals

[`evals/`](evals) holds a labelled corpus of 128 cases: 67 attacks and 61 benign
requests, including hard negatives such as tickets that quote SQL errors or mention
`localhost`. The attacks include prompt injection aimed at Lazaret's own reviewer,
indirect injection aimed at Tidewater's AI support agent, and fraud split across
requests that each look honest (sent in separate batches, some from a fresh login). The runner pushes the corpus
through the real gateway, Ledger and review pipeline, and reports precision, recall,
false-positive rate, latency, time to first token and cost.

Latest live run (2026-11-05; Sonnet 5.5 batch review, Opus 5.5 escalation, Haiku 5.5
inline; linked history on; [`evals/results/live-latest.json`](evals/results/live-latest.json)):

|                                                           |                                                     |
| --------------------------------------------------------- | --------------------------------------------------- |
| Attacks stopped (recall)                                  | 67 / 67 (100%)                                      |
| Precision                                                 | 97%                                                 |
| Benign requests stopped (FPR)                             | 2 / 61 (3.3%)                                       |
| Reviewer prompt injection / downstream agent injection    | 8 / 8 and 10 / 10 stopped                           |
| Fraud split across requests                               | 4 / 4 held for a person (1 / 4 without linking)     |
| Stopped by the deterministic gate alone, before any model | 5 / 67, with 0 false positives                      |
| Escalations                                               | 3, none declined                                    |
| Inline review latency                                     | p50 1.5 s, p95 1.9 s; time to first token p50 0.6 s |
| Batch review latency                                      | p50 2.5 s, p95 10.0 s (off the request path)        |
| Cost                                                      | $0.30 per run, $2.50 per 1,000 reviewed requests    |

The reviewer now sees the gate's decoded view of any field that was encoded (URL
encoding, HTML entities, look-alike Unicode), next to the raw request. The two false
positives were borderline tickets, an account merge naming a second email and a GDPR
erasure for a named third party, held at 0.5 confidence for a person to check. Neither had
any linked history, and both were delivered in the two runs before (the previous
published run, 2026-10-29, held 0 of 57). Only the model you configure can decide an outcome. When it declines
to review a payload, the entry is held for a human with the API's reason (for example
`cyber`), and a human releases or drops it from the review queue. Any first-pass allow
the gate scored at 0.7 or above gets a second opinion. One corpus, one run: treat these
as a measurement, not a guarantee. Every live run is kept in
[`evals/results/`](evals/results).

A second eval replays a sustained attack campaign: each attack re-sent as encoded,
re-cased and split variants among benign traffic, over 6 windows of about 50 writes, with
the Memory learning as it goes and a simulated operator labelling the human queue
([`evals/results/campaign-latest.json`](evals/results/campaign-latest.json), live,
2026-10-29, $0.80). Recall stayed at 100% in every window. Model calls per 1,000 writes
went from 327 to 283, and the gate's share of stops from 0 to 33%, after 3 learned rules
were promoted to block. Cost per 1,000 writes did not fall ($2.32 to $2.48), because
honest writes are most of the traffic and each still needs a model. The learned rules
stopped none of the attack families held out of training: they fit the payloads they
were learned from.

```bash
npm run eval:gate        # deterministic modes, free: evals/results/{gate-only,fake}.json
EVAL_CONFIRM_SPEND=yes npm run eval:live   # real Claude, about $0.25, capped by EVAL_MAX_USD
npm run eval:campaign    # campaign replay, free: evals/results/campaign-fake.json
EVAL_CONFIRM_SPEND=yes npm run eval:campaign:live  # about $1-1.50, capped by EVAL_MAX_USD
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

**Against production.** [`e2e/`](e2e) is a Playwright suite for the deployed demo,
run by hand, never in `npm test`. It fires each of the console's canned exhibits, using
live models and a demo pass minted with the operator token. It then queries Tidewater's
own D1 through wrangler. `lazaret_requests` is origin's log of every signed write it
accepted, so "the attack never reached origin" is a direct query, not Lazaret vouching
for itself. It also loads the UI at desktop and phone widths. A run costs about $0.06–0.15.

```bash
cp e2e/.env.example e2e/.env    # then add LAZARET_OPERATOR_TOKEN
npm run e2e:prod
```

**The package.** `npm run build -w @gleator/lazaret` compiles to `packages/lazaret/dist`,
with its own manifest. In the repo, the apps run straight from the TypeScript source.
`npm run smoke:pack -w @gleator/lazaret` installs the packed tarball into an empty
Worker, typechecks it under both `Bundler` and `NodeNext` resolution, and bundles it.

## What Lazaret doesn't catch

Lazaret judged each write on its own merits, so fraud spread across many believable
requests got through: no single request in it is an attack. A live test on the demo
(2026-11-04) showed this. One customer sent five refund tickets, each under $50 and each
reviewed in its own batch. All five were allowed, Tidewater's AI assistant proposed all
five refunds, and four of them, $190 in all, were paid.

Two changes followed. Tidewater now caps the refunds its assistant proposes per
customer, in code (`limitPerCustomer` in `apps/demo-origin/src/agent/run.ts`), because
adding up one customer's claims is the application's job. And Lazaret can now link writes
across batches (step 11 above). On the eval's four split-fraud cases, the reviewer held
4 of 4 for a person, up from 1 of 4, and held none of the four honest look-alikes (a busy
customer, a support agent crediting several customers).

What still gets through:

- **The first writes in a pattern.** A pattern only shows once a few writes have built up,
  so the first one or two claims still look honest, and a committed write can't be
  recalled. An app that pays out money should keep its own hard limits.
- **Anything outside the links.** Writes are linked by session, account and resource, so
  claims spread across many accounts, each paid to a different customer, don't link.
  History also only reaches back over the window (the demo's Ledger restarts hourly).
- **A model's judgement.** The reviewer decides what counts as a pattern, and it can
  waver: two borderline honest tickets were held in the latest run, though they had no
  linked history and passed in the two runs before.

The same live test hid instructions for the assistant in invisible Unicode tag
characters. The gate has no rule for those characters, but the reviewer decoded them and
dropped the ticket.

## Roadmap

- [x] M1: Ledger core (event log, state machine, seal triggers, crash recovery)
- [x] M2: Gate and route policies
- [x] M3: Claude reviewer, review workflow, committer, taint propagation
- [x] M4: Author-only read overlay
- [x] M5: Memory distillation and rule promotion
- [x] M6: Demo origin (Tidewater Support helpdesk) and evals, plus the human review queue
- [x] M7: gleator.com site, live ledger visualiser, attack console, evals and memory
  panels, spend cap, demo guard
- [x] M8: log compaction, a shared behaviour store, the demo deployed and checked by a
  production E2E suite, and the npm package
- [x] M9: the gleator.com redesign and launch
- [x] M10: linked history, so the reviewer sees fraud split across batches

The full spec is in [`tasks/todo.md`](tasks/todo.md).

## License

[MIT](LICENSE)
