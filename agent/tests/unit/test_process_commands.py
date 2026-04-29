"""
tests for process_commands — restart_process command handler.

covers:
- registration on the CommandRouter
- successful restart of a running process
- restart-when-not-running (still launches)
- restart-with-stuck-process (timeout escalation in graceful_terminate)
- audit event emission with process_restarted action
- payload validation (timeout_seconds bounds, missing process)
- manual_override propagation for scheduled processes outside window
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from command_router import CommandRouter
from process_commands import (
    DEFAULT_RESTART_TIMEOUT_SECONDS,
    _handle_restart_process,
    register_handlers,
)


# ─── fixtures ────────────────────────────────────────────────────────


def _make_service(
    *,
    last_started=None,
    is_pid_running=True,
    launch_pid=4242,
    fb_connected=True,
):
    """build a mock service object exposing the attributes the handler reads."""
    svc = MagicMock()
    svc.last_started = dict(last_started) if last_started else {}
    svc.relaunch_attempts = {}
    svc._skip_launch_delay = set()
    svc.manual_overrides = {}
    svc._cached_site_timezone = None
    svc.firebase_client = MagicMock()
    svc.firebase_client.is_connected.return_value = fb_connected
    svc.handle_process_launch = MagicMock(return_value=launch_pid)
    return svc


def _make_config(processes):
    return {"processes": processes}


SAMPLE_PROCESS = {
    "id": "proc-abc",
    "name": "TouchDesigner",
    "exe_path": "C:\\TD\\TouchDesigner.exe",
    "launch_mode": "always",
    "autolaunch": True,
}


# ─── registration ────────────────────────────────────────────────────


def test_register_handlers_registers_restart_process():
    router = CommandRouter()
    register_handlers(router)
    assert router.has_handler("restart_process")
    assert "restart_process" in router.registered_types()


def test_register_handlers_raises_on_double_register():
    router = CommandRouter()
    register_handlers(router)
    with pytest.raises(ValueError, match="already registered"):
        register_handlers(router)


# ─── happy path: running process ─────────────────────────────────────


def test_restart_running_process_terminates_then_relaunches():
    """when a tracked PID is alive: graceful_terminate + handle_process_launch."""
    svc = _make_service(
        last_started={"proc-abc": {"pid": 1111, "time": "x"}},
        launch_pid=2222,
    )

    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert "restarted" in result.lower()
    assert "1111" in result and "2222" in result
    # graceful terminate was called with the default timeout
    shared.graceful_terminate.assert_called_once_with(
        1111, timeout=DEFAULT_RESTART_TIMEOUT_SECONDS
    )
    # status was updated to KILLED before terminate
    shared.update_process_status_in_json.assert_any_call(
        1111, "KILLED", svc.firebase_client, process_id="proc-abc"
    )
    svc.handle_process_launch.assert_called_once_with(SAMPLE_PROCESS)
    # immediate launch requested (skip backoff)
    assert "proc-abc" in svc._skip_launch_delay
    # audit event emitted with composite action
    actions = [c.kwargs.get("action") for c in svc.firebase_client.log_event.call_args_list]
    assert "process_restarted" in actions


def test_restart_uses_custom_timeout_seconds():
    svc = _make_service(
        last_started={"proc-abc": {"pid": 1111}},
    )
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        util.is_pid_running.return_value = True

        _handle_restart_process(
            {"process_name": "TouchDesigner", "timeout_seconds": 12},
            "cmd-1", svc,
        )

    shared.graceful_terminate.assert_called_once_with(1111, timeout=12)


def test_restart_clamps_timeout_at_30_seconds():
    """defensive cap so a malformed payload can't park the worker forever."""
    svc = _make_service(last_started={"proc-abc": {"pid": 1111}})
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        util.is_pid_running.return_value = True

        _handle_restart_process(
            {"process_name": "TouchDesigner", "timeout_seconds": 9999},
            "cmd-1", svc,
        )

    shared.graceful_terminate.assert_called_once_with(1111, timeout=30)


# ─── restart when not running ────────────────────────────────────────


def test_restart_when_no_tracked_pid_just_launches():
    """no last_started entry → no terminate call, just launch."""
    svc = _make_service(last_started={}, launch_pid=3333)
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.is_within_schedule.return_value = True
        util.is_pid_running.return_value = False

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    shared.graceful_terminate.assert_not_called()
    svc.handle_process_launch.assert_called_once_with(SAMPLE_PROCESS)
    assert "not running" in result.lower()
    assert "3333" in result
    actions = [c.kwargs.get("action") for c in svc.firebase_client.log_event.call_args_list]
    assert "process_restarted" in actions


def test_restart_when_tracked_pid_is_dead_just_launches():
    """last_started has a pid but it's no longer alive → don't try to kill."""
    svc = _make_service(
        last_started={"proc-abc": {"pid": 1111}},
        launch_pid=4444,
    )
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.is_within_schedule.return_value = True
        util.is_pid_running.return_value = False  # dead

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    shared.graceful_terminate.assert_not_called()
    assert "not running" in result.lower()
    svc.handle_process_launch.assert_called_once_with(SAMPLE_PROCESS)


# ─── stuck process: graceful_terminate handles escalation ────────────


def test_restart_stuck_process_relies_on_graceful_terminate_escalation():
    """
    when a process doesn't respond to WM_CLOSE within timeout, the escalation
    path lives inside shared_utils.graceful_terminate (terminate → kill).
    here we simulate that by having graceful_terminate return True (it
    eventually killed the process) and verify the handler proceeds to
    relaunch normally.
    """
    svc = _make_service(
        last_started={"proc-abc": {"pid": 1111}},
        launch_pid=5555,
    )
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        # graceful_terminate's own contract: returns True after escalating
        # to terminate()/kill() if WM_CLOSE didn't take.
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner", "timeout_seconds": 2},
            "cmd-1", svc,
        )

    shared.graceful_terminate.assert_called_once_with(1111, timeout=2)
    svc.handle_process_launch.assert_called_once_with(SAMPLE_PROCESS)
    assert "1111" in result and "5555" in result


# ─── lookup ──────────────────────────────────────────────────────────


def test_restart_unknown_process_name_returns_not_found():
    svc = _make_service()
    with patch("process_commands.shared_utils") as shared:
        shared.read_config.return_value = [SAMPLE_PROCESS]

        result = _handle_restart_process(
            {"process_name": "DoesNotExist"}, "cmd-1", svc
        )

    assert "not found" in result.lower()
    svc.handle_process_launch.assert_not_called()
    svc.firebase_client.log_event.assert_not_called()


def test_restart_resolves_by_process_id():
    svc = _make_service(
        last_started={"proc-abc": {"pid": 1111}},
        launch_pid=2222,
    )
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_id": "proc-abc"}, "cmd-1", svc
        )

    assert "restarted" in result.lower()
    svc.handle_process_launch.assert_called_once_with(SAMPLE_PROCESS)


def test_restart_accepts_processid_camelcase():
    """back-compat: legacy callers send processId, not process_id."""
    svc = _make_service(
        last_started={"proc-abc": {"pid": 1111}},
        launch_pid=2222,
    )
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"processId": "proc-abc"}, "cmd-1", svc
        )

    assert "restarted" in result.lower()


# ─── payload validation ──────────────────────────────────────────────


def test_invalid_timeout_seconds_returns_error():
    svc = _make_service()
    with patch("process_commands.shared_utils") as shared:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.is_within_schedule.return_value = True
        result = _handle_restart_process(
            {"process_name": "TouchDesigner", "timeout_seconds": "not-a-number"},
            "cmd-1", svc,
        )
    assert result.startswith("Error:")
    svc.handle_process_launch.assert_not_called()


def test_negative_timeout_seconds_returns_error():
    svc = _make_service()
    with patch("process_commands.shared_utils") as shared:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.is_within_schedule.return_value = True
        result = _handle_restart_process(
            {"process_name": "TouchDesigner", "timeout_seconds": -1},
            "cmd-1", svc,
        )
    assert result.startswith("Error:")


# ─── failure paths ───────────────────────────────────────────────────


def test_relaunch_returning_none_emits_failure_audit():
    svc = _make_service(
        last_started={"proc-abc": {"pid": 1111}},
        launch_pid=None,
    )
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert result.startswith("Error:")
    actions = [c.kwargs.get("action") for c in svc.firebase_client.log_event.call_args_list]
    assert "process_start_failed" in actions
    assert "process_restarted" not in actions


def test_handle_process_launch_exception_emits_failure_audit():
    svc = _make_service(last_started={"proc-abc": {"pid": 1111}})
    svc.handle_process_launch.side_effect = RuntimeError("launch boom")

    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert result.startswith("Error:")
    assert "launch boom" in result
    actions = [c.kwargs.get("action") for c in svc.firebase_client.log_event.call_args_list]
    assert "process_start_failed" in actions


def test_audit_event_failure_does_not_propagate():
    """firestore log_event failure must not break the restart command result."""
    svc = _make_service(
        last_started={"proc-abc": {"pid": 1111}},
        launch_pid=2222,
    )
    svc.firebase_client.log_event.side_effect = RuntimeError("firestore down")

    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        util.is_pid_running.return_value = True

        # should not raise even though log_event blows up
        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert "restarted" in result.lower()


# ─── manual override semantics ───────────────────────────────────────


def test_scheduled_process_outside_window_sets_manual_override():
    scheduled_proc = {
        **SAMPLE_PROCESS,
        "launch_mode": "scheduled",
        "schedules": [{"day": "monday", "start": "09:00", "end": "17:00"}],
    }
    svc = _make_service(
        last_started={"proc-abc": {"pid": 1111}},
        launch_pid=2222,
    )
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [scheduled_proc]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = False  # outside window
        util.is_pid_running.return_value = True

        _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert svc.manual_overrides.get("proc-abc") is True


def test_scheduled_process_inside_window_does_not_set_manual_override():
    scheduled_proc = {
        **SAMPLE_PROCESS,
        "launch_mode": "scheduled",
        "schedules": [{"day": "monday", "start": "09:00", "end": "17:00"}],
    }
    svc = _make_service(
        last_started={"proc-abc": {"pid": 1111}},
        launch_pid=2222,
    )
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [scheduled_proc]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True  # inside window
        util.is_pid_running.return_value = True

        _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert "proc-abc" not in svc.manual_overrides


# ─── integration via CommandRouter dispatch ──────────────────────────


def test_handler_dispatches_through_router():
    """end-to-end: dispatch via CommandRouter reaches the handler."""
    router = CommandRouter()
    register_handlers(router)

    svc = _make_service(
        last_started={"proc-abc": {"pid": 1111}},
        launch_pid=2222,
    )
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        util.is_pid_running.return_value = True

        result = router.dispatch(
            "restart_process",
            {"process_name": "TouchDesigner"},
            "cmd-99",
            svc,
        )

    assert "restarted" in result.lower()
