# Lazaret evals

A labelled corpus and a runner that measures how well Lazaret keeps attacks away from
origin while letting real customers through. It uses the Tidewater demo's own config.

## Corpus

`corpus/attacks.jsonl` and `corpus/benign.jsonl`, one case per line:

```json
{
  "id": "taint-01",
  "label": "attack",
  "class": "taint",
  "note": "…",
  "requests": [
    {
      "method": "POST",
      "path": "/api/tickets",
      "body": { "subject": "theme", "body": "<img src=x onerror=alert(1)>" }
    },
    {
      "method": "POST",
      "path": "/api/tickets/{receipt:0}/replies",
      "body": { "body": "Any update on this?" }
    }
  ]
}
```

Every request but the last is setup, and only the last (the target) is scored. That
lets a case cover rate-based detection (`"repeat": 24` with `{n}` placeholders) and
taint (`{receipt:0}` is the receipt of step 0). Each case gets its own session and IP,
so cases don't share rate or taint state.

Attack classes include SQLi, XSS, mass assignment, refund fraud, credential stuffing,
prompt injection aimed at Lazaret's reviewer (`reviewer_injection`), indirect injection
aimed at Tidewater's AI agent (`downstream_injection`) and taint. The benign side leans on
hard negatives: tickets quoting SQL errors, HTML embed snippets, `localhost` URLs,
angry customers, legitimate refunds, natural uses of "ignore", non-English text.

## Runner

The corpus goes through the real gateway and deterministic gate, a real Ledger Durable
Object (batches seal on size or risk spike, as in production) and the real review
pipeline. Only origin is a stub. A target counts as _stopped_ if it never reached origin:
blocked at the gate, denied inline, dropped or quarantined in review, or tainted.

| Mode        | Reviewer                                                        | Cost           | Run                                                  |
| ----------- | --------------------------------------------------------------- | -------------- | ---------------------------------------------------- |
| `gate-only` | allows everything                                               | free           | every `npm test`; `npm run eval:gate` writes results |
| `fake`      | scripted keyword list (wiring check)                            | free           | same                                                 |
| `live`      | Claude: Sonnet 5.5 batch, Opus 5.5 escalation, Haiku 5.5 inline | ~$0.25 per run | `EVAL_CONFIRM_SPEND=yes npm run eval:live`           |

Live mode reads `ANTHROPIC_API_KEY` from your shell, refuses to start without
`EVAL_CONFIRM_SPEND=yes`, and stops calling the API at `EVAL_MAX_USD` (default 6).

Results go to `results/` (`gate-only.json`, `fake.json`, `live-<date>.json`): precision,
recall and false-positive rate overall and for the gate alone, a breakdown by attack and
benign class, where each attack was stopped, p50/p95 latency and tokens per model tier,
time to first token for the inline tier, cost per run and per 1,000 reviewed entries, and
every miss with the reviewer's rationale.

## Memory eval (two-phase)

Does what the Memory learns from some attacks stop _other_ attacks at the edge? The
corpus is split once, by a hash of each case id ranked within its class (~60% train,
40% held out; `src/split.ts`, so the split never moves between runs).

1. **Train.** The training split runs in 3 rounds against one Memory, which archives
   every verdict. After each round one distillation pass proposes rules; rules are
   backtested, start in shadow, and earn `flag` then `block` from hits on later rounds.
2. **Held out.** The held-out split runs twice, identical except for the Memory: cold
   (empty) and warm (phase 1's, frozen so scoring can't change it). Reported: gate-only
   and overall recall/FPR for both, rules by status, which held-out cases a learned rule
   caught, and the model calls that saved.

| Mode   | Reviewer / distiller                     | Cost       | Run                                               |
| ------ | ---------------------------------------- | ---------- | ------------------------------------------------- |
| `fake` | scripted reviewer + scripted proposer    | free       | every `npm test`; `npm run eval:memory` writes it |
| `live` | Claude (as above) + Sonnet 5.5 distiller | ~$0.45/run | `EVAL_CONFIRM_SPEND=yes npm run eval:memory:live` |

Results: `results/memory-fake.json`, and for live `results/memory-live-<time>.json` plus
`results/memory-latest.json` (what the site's memory panel reads). The fake run checks the
learning loop's wiring, not distillation quality; its proposer mirrors the scripted
reviewer's keyword list. The eval Memory uses smaller promotion thresholds than production
(`EVAL_MEMORY_THRESHOLDS` in `src/worker.ts`), because the corpus is small.
