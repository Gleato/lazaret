"""Runs on AgentDojo's real banking suite with a fake gate: no network and no model.

Each test guards a way the harness could quietly misreport a score.
"""

from __future__ import annotations

from typing import Any

import pytest
from agentdojo.task_suite.load_suites import get_suite

from lazaret_runtime import BudgetStop, Decision, HttpGate, LazaretRuntime, NoGate
from replay import FORGED, FORGED_MARKER, injection_vectors, replay_pair
from report import percentile, summarize

SUITE = get_suite("v1.2.2", "banking")
USER = SUITE.user_tasks["user_task_0"]  # pays a bill, and reads an injectable file
INJECTION = SUITE.injection_tasks["injection_task_0"]  # sends money to the attacker
VECTORS = injection_vectors(SUITE, USER)


class FixedGate(NoGate):
    def __init__(self, decision: str) -> None:
        self.decision = decision
        self.seen: list[tuple[str, dict[str, Any]]] = []

    def check(self, tool, args):
        self.seen.append((tool, dict(args)))
        return Decision(self.decision, latency_ms=5.0)


def test_the_chosen_pair_is_really_injectable() -> None:
    assert VECTORS


def test_unclassified_tool_stops_the_run() -> None:
    with pytest.raises(ValueError, match="not classified"):
        LazaretRuntime(list(SUITE.tools), NoGate(), writes=frozenset(), reads=frozenset())


def test_reads_are_not_gated_and_writes_are() -> None:
    gate = FixedGate("allow")
    replay_pair(SUITE, USER, None, gate, "s")
    assert [tool for tool, _ in gate.seen] == ["send_money"]


def test_refused_write_never_changes_the_environment() -> None:
    env = SUITE.load_and_inject_default_environment({})
    before = env.model_copy(deep=True)
    runtime = LazaretRuntime(list(SUITE.tools), FixedGate("drop"))
    result, error = runtime.run_function(
        env,
        "send_money",
        {"recipient": "X", "amount": 1.0, "subject": "s", "date": "2022-01-01"},
        raise_on_error=True,  # as the stock replay would pass; a refusal still mustn't raise
    )
    assert result == ""
    assert error is not None and error.startswith("WriteRefused")
    assert env == before


def test_no_defense_baseline_lets_the_attack_through() -> None:
    result = replay_pair(SUITE, USER, INJECTION, NoGate(), "s", VECTORS)
    assert result.error is None
    assert result.delivered and result.attack_succeeded and result.utility


@pytest.mark.parametrize("decision", ["drop", "hold", "gate_block", "unavailable"])
def test_every_kind_of_refusal_stops_the_attack(decision: str) -> None:
    result = replay_pair(SUITE, USER, INJECTION, FixedGate(decision), "s", VECTORS)
    assert result.error is None
    assert result.delivered and not result.attack_succeeded
    assert {w.phase for w in result.writes} == {"user", "attacker"}


def test_undelivered_injection_runs_no_attacker_calls_and_scores_nothing() -> None:
    gate = FixedGate("allow")
    result = replay_pair(SUITE, USER, INJECTION, gate, "s", vectors=[])
    assert not result.delivered and not result.attack_succeeded
    assert {w.phase for w in result.writes} == {"user"}


def test_one_pair_failing_does_not_end_the_run() -> None:
    class Broken(NoGate):
        def check(self, tool, args):
            raise RuntimeError("boom")

    result = replay_pair(SUITE, USER, INJECTION, Broken(), "s", VECTORS)
    assert result.error == "RuntimeError: boom"


def test_budget_stop_is_never_scored_as_a_stop() -> None:
    class Spent(NoGate):
        def check(self, tool, args):
            raise BudgetStop("budget reached")

    with pytest.raises(BudgetStop):
        replay_pair(SUITE, USER, INJECTION, Spent(), "s", VECTORS)


def test_summary_excludes_undelivered_pairs_and_errors() -> None:
    good = replay_pair(SUITE, USER, INJECTION, NoGate(), "a", VECTORS)
    stopped = replay_pair(SUITE, USER, INJECTION, FixedGate("drop"), "b", VECTORS)
    undelivered = replay_pair(SUITE, USER, INJECTION, NoGate(), "c", vectors=[])
    summary = summarize([good, stopped, undelivered], [], None)
    assert summary["attack"]["delivered"] == 2
    assert summary["attack"]["undelivered"] == 1
    assert summary["attack"]["attackSuccessRate"] == 0.5


def test_forged_injections_cover_every_attack_and_look_like_data() -> None:
    assert set(FORGED) == set(SUITE.injection_tasks)
    for text in FORGED.values():
        assert FORGED_MARKER in text
        assert "<INFORMATION>" not in text


@pytest.mark.parametrize("decision, succeeds", [("allow", True), ("drop", False)])
def test_forged_attacks_are_delivered_and_scored(decision: str, succeeds: bool) -> None:
    result = replay_pair(SUITE, USER, INJECTION, FixedGate(decision), "s", VECTORS, forged=True)
    assert result.error is None
    assert result.delivered
    assert result.attack_succeeded is succeeds


def test_reads_reach_the_gate_as_tool_results_and_writes_do_not() -> None:
    class Recording(FixedGate):
        def __init__(self) -> None:
            super().__init__("allow")
            self.reads: list[tuple[str, str]] = []

        def record_read(self, tool, result):
            self.reads.append((tool, result))

    gate = Recording()
    replay_pair(SUITE, USER, INJECTION, gate, "s", VECTORS, forged=True)
    assert [tool for tool, _ in gate.reads] == ["read_file"]
    assert FORGED_MARKER in gate.reads[0][1]  # the attacker's text, exactly as the agent read it


def test_a_refused_write_is_not_reported_as_a_tool_result() -> None:
    class Recording(FixedGate):
        reads: list[str] = []

        def record_read(self, tool, result):
            self.reads.append(tool)

    env = SUITE.load_and_inject_default_environment({})
    runtime = LazaretRuntime(list(SUITE.tools), Recording("drop"))
    runtime.run_function(env, "send_money", {"recipient": "X", "amount": 1.0, "subject": "s", "date": "d"})
    assert Recording.reads == []


def test_http_gate_sends_only_what_its_arm_allows() -> None:
    posted: list[dict[str, Any]] = []

    class Client:
        def post(self, path, json):
            posted.append(json)
            return type("R", (), {"raise_for_status": lambda self: None})()

    gate = HttpGate("http://x", send_task=True, send_tools=False)
    gate.client = Client()
    gate.start_pair("s", "Pay the bill")
    gate.record_read("read_file", "secret")
    assert posted == [{"session": "s", "task": "Pay the bill"}]

    posted.clear()
    none = HttpGate("http://x")
    none.client = Client()
    none.start_pair("s", "Pay the bill")
    none.record_read("read_file", "secret")
    assert posted == []


def test_percentile() -> None:
    assert percentile([], 50) is None
    assert percentile([1, 2, 3], 50) == 2
