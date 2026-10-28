# Lessons

## Scripted edits can silently miss after formatting (2026-10-27, M5)
- **What happened:** a Python `str.replace` edit targeted a line Biome had already rewrapped,
  so it matched nothing. Memory hints were never passed to the reviewer prompt, and all
  tests stayed green. Biome's unused-parameter warning caught it.
- **Rule:** for scripted multi-site edits, assert that each replacement happened (count the
  matches, or `grep` for the new text afterwards), or use the Edit tool, which fails loudly.
  Never ignore an "unused" lint warning on new code; it often means the wiring is missing.
