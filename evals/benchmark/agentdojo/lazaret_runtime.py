"""Puts the real Lazaret gateway in front of AgentDojo's state-changing tools.

Tools run here, in Python. Lazaret only answers "may this write happen?", through the
bench Worker (evals/benchmark/bench.ts), so a refused write can't touch the environment.
Overriding FunctionsRuntime.run_function covers both live agents and ground-truth replay.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
from agentdojo.agent_pipeline.tool_execution import tool_result_to_str
from agentdojo.functions_runtime import FunctionsRuntime, TaskEnvironment

# Listed both ways on purpose: an unlisted tool stops the run, so a new or renamed tool
# can't quietly skip review. Writes match CaMeL's banking side-effect split.
BANKING_WRITES = frozenset(
    {
        "send_money",
        "schedule_transaction",
        "update_scheduled_transaction",
        "update_password",
        "update_user_info",
    }
)
BANKING_READS = frozenset(
    {
        "get_iban",
        "get_balance",
        "get_most_recent_transactions",
        "get_scheduled_transactions",
        "read_file",
        "get_user_info",
    }
)


class BudgetStop(Exception):
    """The spend cap was reached, so the run is invalid and must not be scored."""


@dataclass(frozen=True)
class Decision:
    """What the gateway did with one write. Everything but `allow` means it didn't happen."""

    decision: str  # allow | drop | hold | gate_block | unavailable
    status: int = 200
    latency_ms: float = 0.0
    verdict: dict[str, Any] | None = None

    @property
    def allowed(self) -> bool:
        return self.decision == "allow"


class Gate(Protocol):
    def start_pair(self, session: str, task: str) -> None: ...

    def record_read(self, tool: str, result: str) -> None: ...

    def check(self, tool: str, args: Mapping[str, Any]) -> Decision: ...


class NoGate:
    """Arm A: no defense. The baseline every other arm is compared with."""

    def start_pair(self, session: str, task: str) -> None:
        pass

    def record_read(self, tool: str, result: str) -> None:
        pass

    def check(self, tool: str, args: Mapping[str, Any]) -> Decision:
        return Decision("allow")


class HttpGate:
    """Talks to the bench Worker. Serial: verdicts are matched to writes by arrival order.

    `/__bench/context` plays the agent platform, the trusted runtime that started the run
    and sees what the tools really returned. The agent itself never calls it.
    """

    def __init__(
        self, url: str, *, send_task: bool = False, send_tools: bool = False, timeout_s: float = 60.0
    ) -> None:
        self.client = httpx.Client(base_url=url, timeout=timeout_s)
        self.send_task = send_task
        self.send_tools = send_tools
        self.session = "none"

    def reset(self, reviewer: str, max_usd: float) -> None:
        res = self.client.post(
            "/__bench/reset",
            json={"reviewer": reviewer, "maxUsd": max_usd},
        )
        res.raise_for_status()

    def start_pair(self, session: str, task: str) -> None:
        self.session = session
        if self.send_task:
            body = {"session": session, "task": task}
            self.client.post("/__bench/context", json=body).raise_for_status()

    def record_read(self, tool: str, result: str) -> None:
        if self.send_tools:
            body = {"session": self.session, "toolResult": {"tool": tool, "result": result}}
            self.client.post("/__bench/context", json=body).raise_for_status()

    def check(self, tool: str, args: Mapping[str, Any]) -> Decision:
        res = self.client.post(
            f"/__bench/tool/{tool}",
            headers={"x-bench-session": self.session, "content-type": "application/json"},
            content=json.dumps(args, default=str),
        )
        if res.status_code == 402:
            raise BudgetStop(res.json().get("error", "budget reached"))
        res.raise_for_status()
        body = res.json()
        return Decision(body["decision"], body["status"], body["latencyMs"], body["verdict"])

    def usage(self) -> dict[str, Any]:
        res = self.client.get("/__bench/calls")
        res.raise_for_status()
        return res.json()


@dataclass
class WriteRecord:
    """One gated write. `phase` is `user` or `attacker`, set by the replay."""

    tool: str
    phase: str
    decision: str
    latency_ms: float
    verdict: dict[str, Any] | None = None
    args: dict[str, Any] | None = None


class LazaretRuntime(FunctionsRuntime):
    """A FunctionsRuntime whose write tools must pass the gate first."""

    def __init__(
        self,
        functions: list,
        gate: Gate,
        writes: frozenset[str] = BANKING_WRITES,
        reads: frozenset[str] = BANKING_READS,
    ) -> None:
        super().__init__(functions)
        unlisted = set(self.functions) - writes - reads
        if unlisted:
            raise ValueError(f"tools not classified as read or write: {sorted(unlisted)}")
        self.gate = gate
        self.writes = writes
        self.phase = "user"
        self.records: list[WriteRecord] = []

    def run_function(
        self,
        env: TaskEnvironment | None,
        function: str,
        kwargs: Mapping[str, Any],
        raise_on_error: bool = False,
    ) -> tuple[Any, str | None]:
        if function in self.writes:
            decision = self.gate.check(function, kwargs)
            self.records.append(
                WriteRecord(
                    function,
                    self.phase,
                    decision.decision,
                    decision.latency_ms,
                    decision.verdict,
                    dict(kwargs),
                )
            )
            if not decision.allowed:
                # A refusal is a tool error the agent can read and react to. It never
                # raises, even for ground-truth replay: a blocked write isn't a harness bug.
                return "", f"WriteRefused: {function} was refused by review ({decision.decision})"
        result, error = super().run_function(env, function, kwargs, raise_on_error=raise_on_error)
        if function not in self.writes and error is None:
            self.gate.record_read(function, tool_result_to_str(result))
        return result, error


__all__ = [
    "BANKING_READS",
    "BANKING_WRITES",
    "BudgetStop",
    "Decision",
    "Gate",
    "HttpGate",
    "LazaretRuntime",
    "NoGate",
    "WriteRecord",
]
