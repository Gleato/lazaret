# AgentDojo pilot

Runs AgentDojo's banking suite (upstream commit `089ed468`, benchmark v1.2.2) through the
real Lazaret gateway and inline reviewer. It's a pilot, not a published score.

Python runs the tools and asks Lazaret before each write, through a local Worker
(`bench.ts`) with a stub origin. The replay skips the agent and sends the benchmark's own
correct calls and attacker calls straight to Lazaret, so only review costs money.

| Arm | Meaning                                                                        |
| --- | ------------------------------------------------------------------------------ |
| A   | No defense                                                                     |
| B   | Lazaret with no task: the reviewer sees only the write                         |
| D   | Lazaret with `review.task`: the reviewer knows the agent's task                |
| E   | As D, plus the agent's tool results as untrusted evidence (`toolResultsField`) |

Arm C was the pilot's unshipped experiment. Its result file stays as the pilot's record.
Arms B, D and E all run the real lookup: Python plays the agent platform and tells the
stub origin each run's context, and the gateway finds it from the client's credential.

`--injection forged` plants the same attacks as ordinary-looking data, such as a bill
showing the attacker's account, with no `<INFORMATION>` wrapper. It tests whether tool
results make the reviewer easier to fool, so it only means anything on arm E: arm D never
sees the planted text. The lines are hand-written, not an adaptive attacker.

## Free dry run

```bash
npm run bench:serve -w @gleator/lazaret-evals
```

```bash
cd evals/benchmark/agentdojo
uv run python run_replay.py --arm A
uv run python run_replay.py --arm B --reviewer scripted:allow
uv run python run_replay.py --arm B --reviewer scripted:drop
```

The expected results are 100% attack success for A and allow-all, and 0% for drop-all.
Anything else is a harness bug.

## Paid run

Live review needs the server started with spending turned on, and the key in
`evals/.dev.vars`. The cap stops the run and marks it invalid, because a budget stop must
not look like a stopped attack.

```bash
npm run bench:serve:live -w @gleator/lazaret-evals
```

```bash
cd evals/benchmark/agentdojo
uv run python run_replay.py --arm B --reviewer live --max-usd 1.5
```

## Limits

- The replay is open-loop: its calls don't adapt to a refusal.
- Inline review only, on one suite, with no adaptive attacker yet. The forged variant is
  nine hand-written lines.
- Banking has an open upstream scoring bug (#240) that favours the attacker. It's left as is.
- The harness's differences from the stock replay are listed in `agentdojo/replay.py`.

## Tests

```bash
npm test -w @gleator/lazaret-evals
```

```bash
cd evals/benchmark/agentdojo && uv run --group dev pytest
```
