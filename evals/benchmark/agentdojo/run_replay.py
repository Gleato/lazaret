"""Runs one arm of the replay and writes its result file.

  uv run python run_replay.py --arm A
  uv run python run_replay.py --arm B --reviewer scripted:allow --out /tmp/dry

Arms: A no defense, B Lazaret with no task, D with the task from origin, E with the task
and the agent's tool results. `--injection forged` plants the attacks as ordinary-looking
data (see replay.py). A paid run needs `--reviewer live` here and BENCH_CONFIRM_SPEND=yes on the bench Worker.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import uuid
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

from agentdojo.task_suite.load_suites import get_suite

from lazaret_runtime import BudgetStop, HttpGate, NoGate
from replay import PairResult, injection_vectors, replay_pair
from report import summarize

BENCHMARK_VERSION = "v1.2.2"
AGENTDOJO_COMMIT = "089ed468"
RESULTS = Path(__file__).resolve().parents[2] / "results" / "benchmark"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arm", choices=["A", "B", "D", "E"], required=True)
    parser.add_argument("--injection", choices=["static", "forged"], default="static")
    parser.add_argument("--reviewer", default="scripted:allow")
    parser.add_argument("--max-usd", type=float, default=3.0)
    parser.add_argument("--url", default="http://127.0.0.1:8799")
    parser.add_argument("--suite", default="banking")
    parser.add_argument("--limit", type=int, help="only the first N user tasks, for a smoke test")
    parser.add_argument("--out", type=Path, default=RESULTS)
    args = parser.parse_args()

    suite = get_suite(BENCHMARK_VERSION, args.suite)
    forged = args.injection == "forged"
    if args.arm == "A":
        gate = NoGate()
    else:
        gate = HttpGate(args.url, send_task=args.arm in "DE", send_tools=args.arm == "E")
        gate.reset(args.reviewer, args.max_usd)

    user_tasks = list(suite.user_tasks.values())[: args.limit]
    run_id = uuid.uuid4().hex[:8]
    pairs: list[PairResult] = []
    benign: list[PairResult] = []
    invalid: str | None = None
    started = datetime.now(UTC)
    try:
        for user in user_tasks:
            benign.append(replay_pair(suite, user, None, gate, f"{run_id}-{user.ID}-benign"))
            vectors = injection_vectors(suite, user)
            for injection in suite.injection_tasks.values():
                session = f"{run_id}-{user.ID}-{injection.ID}"
                pairs.append(replay_pair(suite, user, injection, gate, session, vectors, forged))
            done = len(benign)
            print(f"{done}/{len(user_tasks)} user tasks, {len(pairs)} pairs", flush=True)
    except BudgetStop as stop:
        # Writes what it has, marked invalid, so the money spent still teaches something.
        invalid = str(stop)
        print(f"INVALID RUN: {invalid}", flush=True)

    usage = gate.usage() if isinstance(gate, HttpGate) else None
    reviewer = "none" if args.arm == "A" else args.reviewer
    result = {
        "benchmark": "agentdojo",
        "agentdojoCommit": AGENTDOJO_COMMIT,
        "benchmarkVersion": BENCHMARK_VERSION,
        "suite": args.suite,
        "method": "ground-truth replay (open-loop, no agent model)",
        "arm": args.arm,
        "armLabel": {
            "A": "no defense",
            "B": "lazaret, no task",
            "D": "lazaret with task",
            "E": "lazaret with task and tool results",
        }[args.arm],
        "injection": args.injection,
        "reviewer": reviewer,
        "lazaretCommit": subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=False
        ).stdout.strip(),
        "startedAt": started.isoformat(),
        "finishedAt": datetime.now(UTC).isoformat(),
        "limit": args.limit,
        "invalid": invalid,
        "summary": summarize(pairs, benign, usage),
        "calls": (usage or {}).get("calls", []),
        "pairs": [asdict(r) for r in pairs],
        "benign": [asdict(r) for r in benign],
    }
    args.out.mkdir(parents=True, exist_ok=True)
    stamp = started.strftime("%Y-%m-%dT%H-%M-%SZ")
    style = "-forged" if forged else ""
    name = f"{args.suite}-arm{args.arm}{style}-{reviewer.replace(':', '-')}-{stamp}.json"
    path = args.out / name
    path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result["summary"] | {"errors": len(result["summary"]["errors"])}, indent=2))
    print(f"wrote {path}")
    return 1 if invalid else 0


if __name__ == "__main__":
    raise SystemExit(main())
