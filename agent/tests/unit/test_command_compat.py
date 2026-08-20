"""Regression coverage: command dispatch must tolerate unknown extra fields.

Guards the failure mode where adding `createdAt` / `auditCorrelationId` to a
command doc makes a strict handler raise TypeError. Two checks: dispatch
tolerates extra fields at runtime, and no source file unpacks `**cmd_data` /
`**command_data`.

`owlette_service.handle_firebase_command` is deliberately not instantiated —
constructing OwletteService/FirebaseClient pulls in cryptography/PyO3, which
fights pytest's interpreter reuse (see firebase_client.py:67-69). The static
check stands in for it; the manual audit is in
dev/active/security-boundary-migration/reference/agent-compat.md.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from command_router import CommandRouter


EXTRA_FIELDS = {
    "createdAt": "2026-04-25T12:00:00Z",
    "auditCorrelationId": "audit-uuid-abc-1234",
    "_future_field": "anything-the-server-might-add-later",
}


# runtime: dispatch tolerates unknown fields


def test_command_router_dispatch_tolerates_extra_fields():
    """dispatch passes cmd_data verbatim; extra fields must not raise."""
    router = CommandRouter()
    received = {}

    @router.register("audit_probe")
    def handler(cmd_data, cmd_id, service):
        # the contract: read known fields, ignore the rest
        received["cmd_data"] = cmd_data
        received["expected_field"] = cmd_data.get("expected_field")
        return "ok"

    cmd_data = {
        "type": "audit_probe",
        "expected_field": "value",
        **EXTRA_FIELDS,
    }

    result = router.dispatch("audit_probe", cmd_data, "cmd-1", object())

    assert result == "ok"
    for key, value in EXTRA_FIELDS.items():
        assert received["cmd_data"][key] == value
    assert received["expected_field"] == "value"


def test_command_router_dispatch_handler_with_fixed_signature_does_not_break():
    """A fixed-signature handler must not get cmd_data unpacked as kwargs.

    If dispatch ever called `handler(**cmd_data)`, EXTRA_FIELDS would become
    unexpected kwargs against (cmd_data, cmd_id, service) and raise TypeError.
    """
    router = CommandRouter()

    def handler(cmd_data, cmd_id, service):
        return cmd_data.get("type", "missing")

    router.register_fn("strict_probe", handler)

    cmd_data = {"type": "strict_probe", **EXTRA_FIELDS}

    result = router.dispatch("strict_probe", cmd_data, "cmd-2", None)
    assert result == "strict_probe"


def test_command_router_extra_fields_pass_through_to_synthetic_dispatch_chain():
    """Mirror the full dispatch chain with plain callables.

    Chains listener -> _process_command -> _execute_command -> command_callback
    -> handle_firebase_command -> dispatch, asserting the dict reaches the
    handler with EXTRA_FIELDS intact and nothing rewritten in transit.
    """
    router = CommandRouter()
    handler_received = {}

    @router.register("chain_probe")
    def handler(cmd_data, cmd_id, service):
        handler_received["cmd_data"] = dict(cmd_data)
        handler_received["cmd_id"] = cmd_id
        return "chain ok"

    # mirrors handle_firebase_command's router check + dispatch
    def fake_handle_firebase_command(cmd_id, cmd_data):
        cmd_type = cmd_data.get("type")
        if router.has_handler(cmd_type):
            return router.dispatch(cmd_type, cmd_data, cmd_id, None)
        return f"Unknown command type: {cmd_type}"

    def fake_execute_command(cmd_id, cmd_data):
        return fake_handle_firebase_command(cmd_id, cmd_data)

    def fake_process_command(cmd_id, cmd_data):
        return fake_execute_command(cmd_id, cmd_data)

    def fake_on_commands_changed(commands_data):
        results = {}
        for cmd_id, cmd_data in commands_data.items():
            results[cmd_id] = fake_process_command(cmd_id, cmd_data)
        return results

    incoming = {
        "cmd-chain-1": {
            "type": "chain_probe",
            "known_field": "still here",
            **EXTRA_FIELDS,
        }
    }

    results = fake_on_commands_changed(incoming)

    assert results == {"cmd-chain-1": "chain ok"}
    assert handler_received["cmd_id"] == "cmd-chain-1"
    for key, value in EXTRA_FIELDS.items():
        assert handler_received["cmd_data"][key] == value
    assert handler_received["cmd_data"]["known_field"] == "still here"
    assert handler_received["cmd_data"]["type"] == "chain_probe"


# static: `**cmd_data` / `**command_data` unpacking would re-introduce the
# strict-signature failure mode


_AGENT_SRC = Path(__file__).resolve().parents[2] / "src"

# Files that touch a command dict, per the audit in agent-compat.md.
_DISPATCH_FILES = (
    "firebase_client.py",
    "owlette_service.py",
    "owlette_runner.py",
    "command_router.py",
    "sync_commands.py",
    "machine_commands.py",
    "process_commands.py",
)


@pytest.mark.parametrize("filename", _DISPATCH_FILES)
def test_no_kwarg_unpacking_in_dispatch_files(filename):
    """No dispatch-chain file may unpack a command dict as kwargs.

    `**cmd_data` yields `TypeError: unexpected keyword argument 'createdAt'` once
    the server attaches audit metadata. Forward the dict positionally instead.
    """
    path = _AGENT_SRC / filename
    if not path.exists():
        pytest.skip(f"{filename} not present in this checkout")

    text = path.read_text(encoding="utf-8")

    forbidden = re.compile(r"\*\*(cmd_data|command_data)\b")
    matches = [
        (lineno, line.rstrip())
        for lineno, line in enumerate(text.splitlines(), start=1)
        if forbidden.search(line)
    ]

    assert not matches, (
        f"{filename} contains forbidden `**cmd_data` / `**command_data` "
        f"unpacking on lines: {matches}"
    )


def test_public_process_command_types_are_agent_dispatchable():
    """Command types queued by the public process routes must all be recognized
    by the legacy dispatch chain, not fall through to ``Unknown command type``.
    """
    service_text = (_AGENT_SRC / "owlette_service.py").read_text(encoding="utf-8")

    assert "('restart_process', 'start_process')" in service_text
    assert "('kill_process', 'stop_process')" in service_text
