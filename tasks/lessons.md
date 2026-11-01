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
