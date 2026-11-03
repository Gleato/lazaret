# Lessons

## Scripted edits can silently miss after formatting (2026-10-27, M5)
- **What happened:** a Python `str.replace` edit targeted a line Biome had already rewrapped,
  so it matched nothing. Memory hints were never passed to the reviewer prompt, and all
  tests stayed green. Biome's unused-parameter warning caught it.
- **Rule:** for scripted multi-site edits, assert that each replacement happened (count the
  matches, or `grep` for the new text afterwards), or use the Edit tool, which fails loudly.
  Never ignore an "unused" lint warning on new code; it often means the wiring is missing.

## Fix defects when they surface, don't park them (2026-10-29, M7)
- **What happened:** the Memory eval subagent reported two library bugs that stop learning
  (a rule rejected for low support can never be proposed again; backtests treat the
  reviewer's allows as ground truth, so a rule that catches a reviewer miss is rejected).
  I logged them as "follow-ups" and shipped M7, then published a flat live result that the
  bugs partly explain. The user's rule: issues get handled as they appear, not later.
- **Rule:** when work (mine or a subagent's) uncovers a defect in what we're building, it
  becomes part of the current task: fix it, test it, re-measure. Only park it if the user
  says so. A milestone isn't done while a known defect undermines the thing it claims to show.

## Measure a latency budget in production before calling the design done (2026-11-01, M8)
- **What happened:** the shared behaviour store awaited a Durable Object behind a 25 ms
  deadline. Every test passed, and local workerd was fast. On the live demo, the
  lookup was 25 ms at p50 *and* p95: every request paid the deadline and still fell
  back to local counts. The SQLite write in the Durable Object, which the reply waits
  to commit, was the cost.
- **Rule:** anything on the request path that adds I/O gets a `Server-Timing` (or
  equivalent) and a production measurement before it is called done. Prefer designs
  that keep remote state off the critical path (sync in `waitUntil`, use the last-known
  view).

## Never read a terminal tab while it may hold a secret (2026-11-01, M8)
- **What happened:** I read the user's secrets tab to see why it was waiting, and the
  `openssl rand` signing secret it had just printed came into my context.
- **Rule:** once a tab is for secrets, don't read it. Ask the user what it shows, or
  check the outcome by other means (`wrangler secret list`, `npm whoami`). When one
  comes into view anyway, say so at once and offer to rotate it.

## Deploy only through the deploy script (2026-11-02, M9 launch)
- **What happened:** after a config fix I ran `npx astro build && npx wrangler deploy` by
  hand. The plain build has no `PUBLIC_DEMO_ORIGIN`, so for about 20 s the live gleator.com
  pointed its demo at localhost:8787. Caught it by grepping the live HTML, then redeployed.
- **Rule:** deploy with `npm run deploy` (it runs `build:prod`), never a bare build plus
  `wrangler deploy`. After every deploy, grep the live HTML for `localhost` and for the
  production demo origin before calling it done.

