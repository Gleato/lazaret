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

## Test the production paths that local fallbacks hide (2026-11-02, M9 launch)
- **What happened:** the long page's bot check had been broken in production since M8. A
  `<div id="turnstile">` shadowed `window.turnstile`, so the loader never fetched
  Cloudflare's script. Locally the always-pass test key falls back to an offline token,
  so every local run "passed". Cloudflare's analytics beacon is the same kind of thing: it
  is injected only in production, so only the live CSP check caught it.
- **Rule:** when a code path has a local fallback (test keys, offline tokens, mocks), the
  launch check must exercise the production path on the live site: render the real widget,
  and record CSP/console errors in a real browser. Never name an element id after a global
  that the code checks for.


## Keep the profile in the user's own voice (2026-11-05)
- **What happened:** the Profile sheet wrapped the user's intro in a made-up reporter's
  profile (masthead, byline, stamp, polaroid, margin notes). The user disliked the whole
  framing once it was live and cut it for a plain intro.
- **Rule:** on the portfolio, present the user's own words plainly. Don't add invented
  personas, jokes or dressing around them unless the user asks for that specific thing.

## Don't give identical actions separate controls (2026-11-05)
- **What happened:** to make the decorative routing slip useful I proposed keeping its role
  rows and having each one share the link. The user pointed out that three choices doing the
  same thing is confusing, and one share button is all it needs.
- **Rule:** when making a decorative element work, count the distinct outcomes. One outcome
  gets one control. Don't keep a metaphor's parts if they stop meaning anything.

## Keep the user's supplied assets unless they ask to drop them (2026-11-05)
- **What happened:** while repointing the header links I also swapped the user's real npm and
  GitHub logos for plain text, to keep the frame neutral. The user asked for the logos back.
- **Rule:** when a change is about where something links or what it says, leave the assets the
  user supplied. Swapping them is a separate decision: ask, or at least call it out.

## `perspective` and `transform` scope z-index (2026-11-05)
- **What happened:** the folder's top edge never showed in front of the back tabs. `.shell` has
  `perspective`, which makes a stacking context, so `.body`'s `z-index: 5` never competed with
  the tabs. I blamed the edge's shade first, and my added shadow was hidden the same way.
- **Rule:** when a line or shadow "isn't showing", check what's on top with `elementFromPoint`
  before tuning colour. Read what the user circles literally, too.
