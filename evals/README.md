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
`results/memory-latest.json`. The fake run checks the
learning loop's wiring, not distillation quality; its proposer mirrors the scripted
reviewer's keyword list. The eval Memory uses smaller promotion thresholds than production
(`EVAL_MEMORY_THRESHOLDS` in `src/worker.ts`), because the corpus is small.

## Campaign replay (M7.1)

Real attackers send many variants of one payload, not one. The campaign replay asks
whether Lazaret gets cheaper as the Memory learns from such a campaign, while recall and
FPR hold (`src/campaign.ts`, `src/mutate.ts`).

- **Traffic.** A deterministic mutator (seeded PRNG, no model) re-sends each attack
  family (one corpus case) as URL-, HTML-entity- and full-width-encoded, re-cased,
  whitespace-padded, SQL-comment-split and field-moved variants. Benign cases get the
  same treatment, minus comment-splitting. Attacks are 30% of writes. Every window has the
  same mix of classes, so windows are comparable. Credential bursts, taint chains and
  reads are left out: they test other mechanisms.
- **Replay.** 6 windows of about 50 writes go through the real stack against one Memory
  that keeps learning, with one distillation pass per window. Each window gets its own
  Ledger shard.
- **Simulated operator.** A scripted operator works the human queue and the disputes
  view one window late. It labels from the corpus through the real operator API. It is
  labelled as simulated in the results and on the site.
- **Hold-out.** About a third of the families in each class with 3 or more families
  never appear in the stream. After every window, a free gate-only probe (rules frozen,
  no model calls) sends fresh variants of held-out families, training families and
  benign cases.
- **Reported per window:** recall, FPR, model calls and reviewed writes per 1,000
  writes, USD per 1,000 (live), the gate's share of stops, rule promotions, the
  operator's work, and the probe.
- **Offline extras:** a counterfactual arm (same stream, a Memory that never learns), and
  a decoded-view ablation (the scripted reviewer reading only the raw body, as before
  M7.1).

| Mode   | Reviewer / distiller                     | Cost     | Run                                                 |
| ------ | ---------------------------------------- | -------- | --------------------------------------------------- |
| `fake` | scripted reviewer + scripted proposer    | free     | every `npm test`; `npm run eval:campaign` writes it |
| `live` | Claude (as above) + Sonnet 5.5 distiller | ~$1-1.50 | `EVAL_CONFIRM_SPEND=yes npm run eval:campaign:live` |

Results: `results/campaign-fake.json`, and for live `results/campaign-live-<time>.json`
plus `results/campaign-latest.json`, which the site's memory panel reads. The
thresholds are `EVAL_MEMORY_THRESHOLDS`, the same as the Memory eval.
