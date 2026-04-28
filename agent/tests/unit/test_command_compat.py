"""
test_command_compat — wave 1.0 regression coverage for the
security-boundary-migration project.

verifies the agent's command dispatch path is tolerant of unknown extra
fields on a command entry. specifically guards against the failure mode
where adding `createdAt` / `auditCorrelationId` (or future audit
metadata) to a command document would cause a strict handler to raise
`TypeError` on dispatch.

scope: two complementary checks:
  1. CommandRouter.dispatch tolerates extra fields end-to-end (runtime).
  2. The agent source code contains no `**cmd_data` / `**command_data`
     unpacking pattern in any command handler — a static guard against
     future regressions.

the legacy if/elif chain in `owlette_service.handle_firebase_command` is
intentionally NOT instantiated at runtime here. instantiating
`OwletteService` (or even `FirebaseClient`) in a unit test pulls in
cryptography/PyO3, which fights pytest's interpreter reuse — a known
constraint already documented in `firebase_client.py:67-69`. instead we
verify the structural invariant: every handler reads fields by `.get()`
and no kwarg unpacking is used. the findings doc at
`dev/active/security-boundary-migration/reference/agent-compat.md`
captures the manual audit those static checks are guarding.
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


# ---------------------------------------------------------------------------
# Runtime — CommandRouter.dispatch tolerates unknown fields.
# ---------------------------------------------------------------------------


def test_command_router_dispatch_tolerates_extra_fields():
    """
    CommandRouter.dispatch must pass the cmd_data dict to the handler
    verbatim. extra fields beyond what the handler reads must NOT cause
    dispatch to raise.
    """
    router = CommandRouter()
    received = {}

    @router.register("audit_probe")
    def handler(cmd_data, cmd_id, service):
        # Handler reads only the fields it knows about. Unknown fields
        # are ignored — this is the contract every handler must satisfy.
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
    # Handler saw the unchanged dict — every extra field is still present.
    for key, value in EXTRA_FIELDS.items():
        assert received["cmd_data"][key] == value
    # Handler's own field also flowed through.
    assert received["expected_field"] == "value"


def test_command_router_dispatch_handler_with_fixed_signature_does_not_break():
    """
    A handler with a fixed positional signature (the standard contract)
    must NOT receive cmd_data unpacked as kwargs. If dispatch were ever
    changed to invoke `handler(**cmd_data)`, this test would raise
    TypeError because `createdAt` / `auditCorrelationId` / `_future_field`
    would become unexpected kwargs against the (cmd_data, cmd_id, service)
    signature.
    """
    router = CommandRouter()

    def handler(cmd_data, cmd_id, service):
        return cmd_data.get("type", "missing")

    router.register_fn("strict_probe", handler)

    cmd_data = {"type": "strict_probe", **EXTRA_FIELDS}

    result = router.dispatch("strict_probe", cmd_data, "cmd-2", None)
    assert result == "strict_probe"


def test_command_router_extra_fields_pass_through_to_synthetic_dispatch_chain():
    """
    Simulate the full dispatch chain shape (firestore listener →
    `_process_command` → `_execute_command` → `command_callback` →
    `handle_firebase_command` → `CommandRouter.dispatch`) by chaining
    plain Python callables that mirror the same dict-passing contract.

    Each layer is a thin wrapper that forwards cmd_data unchanged.
    The test asserts the dict arrives at the bottom-most handler with
    EXTRA_FIELDS intact AND nothing was filtered/rewritten in transit.
    """
    router = CommandRouter()
    handler_received = {}

    @router.register("chain_probe")
    def handler(cmd_data, cmd_id, service):
        handler_received["cmd_data"] = dict(cmd_data)
        handler_received["cmd_id"] = cmd_id
        return "chain ok"

    # Mirror handle_firebase_command's router check + dispatch step.
    def fake_handle_firebase_command(cmd_id, cmd_data):
        cmd_type = cmd_data.get("type")
        if router.has_handler(cmd_type):
            return router.dispatch(cmd_type, cmd_data, cmd_id, None)
        return f"Unknown command type: {cmd_type}"

    # Mirror _execute_command's callback invocation.
    def fake_execute_command(cmd_id, cmd_data):
        return fake_handle_firebase_command(cmd_id, cmd_data)

    # Mirror _process_command's lane selection — pass through verbatim.
    def fake_process_command(cmd_id, cmd_data):
        return fake_execute_command(cmd_id, cmd_data)

    # Mirror on_commands_changed's iteration — also passes through verbatim.
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
    # Every extra field reached the handler intact.
    for key, value in EXTRA_FIELDS.items():
        assert handler_received["cmd_data"][key] == value
    # The known field is still present too.
    assert handler_received["cmd_data"]["known_field"] == "still here"
    assert handler_received["cmd_data"]["type"] == "chain_probe"


# ---------------------------------------------------------------------------
# Static — guard against any future contributor introducing `**cmd_data`
# or `**command_data` unpacking, which would re-introduce the strict-
# signature failure mode.
# ---------------------------------------------------------------------------


_AGENT_SRC = Path(__file__).resolve().parents[2] / "src"

# Files that participate in the command dispatch chain. We don't audit
# every src file — just the ones that touch a command dict. This list
# matches the audit recorded in agent-compat.md.
_DISPATCH_FILES = (
    "firebase_client.py",
    "owlette_service.py",
    "owlette_runner.py",
    "command_router.py",
    "sync_commands.py",
    "machine_commands.py",
)


@pytest.mark.parametrize("filename", _DISPATCH_FILES)
def test_no_kwarg_unpacking_in_dispatch_files(filename):
    """
    No source file in the dispatch chain may unpack a command dict via
    `**cmd_data` or `**command_data`. That pattern is what would cause
    a `TypeError: unexpected keyword argument 'createdAt'` when the
    server starts attaching audit metadata to commands.

    If a future change wants to forward the dict, it must do so as a
    positional arg (the CommandRouter contract) so unknown fields are
    naturally tolerated.
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
    """
    Public process routes queue these Firebase command types. The legacy
    dispatch chain must recognize every one before falling through to
    ``Unknown command type``.
    """
    service_text = (_AGENT_SRC / "owlette_service.py").read_text(encoding="utf-8")

    assert "('restart_process', 'start_process')" in service_text
    assert "('kill_process', 'stop_process')" in service_text
