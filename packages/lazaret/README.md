# @gleator/lazaret

**An AI quarantine for your writes.** A Cloudflare Workers gateway that holds every
write bound for your origin in a Durable Object ledger. An independent Claude
reviewer vets each batch, and only the writes that pass reach your server. A write
that fails is dropped, together with the writes that depend on it.

- **Gate:** deterministic, a few milliseconds, at the edge. Routes are passed, reviewed
  inline (logins, payments), escrowed, or blocked. Behaviour scoring catches swarms
  whose individual requests look benign.
- **Ledger:** an append-only event log in Durable Object SQLite with an explicit state
  machine. State is a replay of the log, which is compacted as it grows. A crash loses
  nothing that was acknowledged.
- **Reviewer:** Claude, with no tools and no network, returning JSON verdicts. It fails
  closed. A disagreement with the gate escalates to a stronger model. With `link`, it
  also sees each write's recent linked writes (same login, account or resource), so
  fraud split across requests that each look honest shows up as a pattern.
- **Committer:** replays approved writes to origin, HMAC-signed and idempotent.
- **Memory:** learns from the reviewer's verdicts and from human labels. It proposes rules
  in a safe DSL, backtests them against clean traffic, and promotes them into the gate,
  so attacks it has seen before get cheaper to stop.

Live demo: [demo.gleator.com](https://demo.gleator.com). Full guide, design notes and
evals: [github.com/Gleato/lazaret](https://github.com/Gleato/lazaret).

## Install

```bash
npm install @gleator/lazaret
```

Runs on Cloudflare Workers with Durable Objects (SQLite) and Workflows. It needs an
Anthropic API key for the reviewer.

## Use

```ts
import {
  createGateway,
  defineLazaret,
  LazaretLedger,
  LazaretMemory,
  LazaretReviewWorkflow,
} from "@gleator/lazaret";

const config = defineLazaret({
  origin: "https://api.example.com",
  session: { header: "authorization" },
  routes: [
    { match: "POST /api/login", policy: "INLINE_REVIEW" },
    { match: "POST /api/posts", policy: "ESCROW", resources: ["post:{receipt}"] },
    { match: "* /admin/*", policy: "BLOCK" },
    { match: "GET /*", policy: "PASS" },
  ],
  review: { dailyBudgetUsd: 5 },
});

export class Ledger extends LazaretLedger {}
export class Memory extends LazaretMemory {}
export class ReviewWorkflow extends LazaretReviewWorkflow {
  protected override lazaretConfig() {
    return config;
  }
}

const gateway = createGateway(config);
export default { fetch: gateway.fetch, scheduled: gateway.scheduled };
```

On the origin, refuse anything that didn't come through Lazaret:

```ts
import { verifyLazaretRequest } from "@gleator/lazaret/origin";

const check = await verifyLazaretRequest(request, env.LAZARET_SIGNING_SECRET);
if (!check.ok) return new Response("Forbidden", { status: 403 });
```

Bindings: `LAZARET_LEDGER` and `LAZARET_MEMORY` (Durable Objects), `LAZARET_REVIEW`
(Workflow) and a cron trigger for the recovery sweep. Secrets: `ANTHROPIC_API_KEY` and
`LAZARET_SIGNING_SECRET`, plus `LAZARET_OPERATOR_TOKEN` if you want the human review
queue. To share behaviour counts across isolates, add `behaviour: { store: "durable" }`
and a `LazaretBehaviour` binding. The repo's
[Tidewater deployment](https://github.com/Gleato/lazaret/tree/main/apps/demo-lazaret)
is a complete, working example.

`@gleator/lazaret/public` exports the public stream's types with no Workers imports, for
browser clients.

## License

MIT
