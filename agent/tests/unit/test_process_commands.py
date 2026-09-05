"""
tests for process_commands -- restart_process command handler.

covers:
- registration on the CommandRouter
- successful restart of a running process (identity-gated)
- the identity gate: recorded-row match kills; mismatch / no-record /
  other-entry rows refuse with 'Error:'; a refused mismatch cleans the stale
  state row and the stale tracking entry
- the strict-discovery fallback, honestly exercised (the service double
  returns explicit pids, never truthy Mocks): unambiguous match with a
  readable identity kills; unreadable or other-entry refuses; no match falls
  through to a plain launch
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


# what read_process_identity stored at launch time (normalised lowercase
# backslash form -- see shared_utils.read_process_identity).
RECORDED_EXE = "c:\\td\\touchdesigner.exe"


def _make_service(
    *,
    last_started=None,
    launch_pid=4242,
    fb_connected=True,
    find_pid=None,
):
    """build a mock service object exposing the attributes the handler reads.

    the double is HONEST about discovery: _find_running_process_by_exe returns
    `find_pid` explicitly (default None -- nothing found). the old bare
    MagicMock default returned a truthy Mock from every call, so the
    strict-discovery fallback was never actually exercised: tests reached it,
    "found" a Mock pid, and only bailed because is_pid_running happened to be
    False (sweep finding).
    """
    svc = MagicMock()
    svc.last_started = dict(last_started) if last_started else {}
    svc.relaunch_attempts = {}
    svc._skip_launch_delay = set()
    svc.manual_overrides = {}
    # machine-local schedule evaluation — the shape for a site that has not
    # opted into site-time schedules, which is every site until one does. it is
    # no longer the ONLY reachable value: since 3.3.0 the main loop refreshes
    # this from the cloud client each tick, so an opted-in site puts a real IANA
    # zone here and the window below is judged on the site's clock instead.
    svc._cached_site_timezone = None
    svc.firebase_client = MagicMock()
    svc.firebase_client.is_connected.return_value = fb_connected
    svc.handle_process_launch = MagicMock(return_value=launch_pid)
    svc._find_running_process_by_exe = MagicMock(return_value=find_pid)
    return svc


def _states_with_record(pid=1111, process_id="proc-abc", create_time=1234.5):
    """an app_states.json doc whose pid row carries a wave-2 identity record."""
    return {
        str(pid): {
            "id": process_id,
            "status": "RUNNING",
            "create_time": create_time,
            "exe": RECORDED_EXE,
            "managed": True,
            "origin": "launched",
        }
    }


def _arm_gate(shared, *, states=None, matches=True):
    """point the mocked shared_utils at an app_states doc + identity verdict.

    every test whose flow reaches a terminate MUST arm this: with a bare
    MagicMock the gate would read a truthy Mock instead of a row dict and
    refuse as no-record.
    """
    if states is None:
        states = _states_with_record()
    shared.read_json_from_file.return_value = states
    shared.identity_matches.return_value = matches
    return states


SAMPLE_PROCESS = {
    "id": "proc-abc",
    "name": "TouchDesigner",
    "exe_path": "C:\\TD\\TouchDesigner.exe",
    "launch_mode": "always",
    "autolaunch": True,
}


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


def test_restart_running_process_terminates_then_relaunches():
    """when a tracked PID is alive AND its recorded identity matches:
    graceful_terminate + handle_process_launch."""
    svc = _make_service(
        last_started={"proc-abc": {"pid": 1111, "time": "x"}},
        launch_pid=2222,
    )

    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        _arm_gate(shared)
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert "restarted" in result.lower()
    assert "1111" in result and "2222" in result
    # the gate: terminate happens only after the recorded identity is proven
    # against the live process; the record is assembled from the pid row
    # (create_time/exe) plus the row key (pid).
    shared.identity_matches.assert_called_once_with(
        {"pid": 1111, "create_time": 1234.5, "exe": RECORDED_EXE}, 1111
    )
    # exe_path is threaded through so a .bat/.cmd target's payload is reaped
    # with its cmd.exe wrapper (shared_utils.graceful_terminate).
    shared.graceful_terminate.assert_called_once_with(
        1111,
        timeout=DEFAULT_RESTART_TIMEOUT_SECONDS,
        exe_path=SAMPLE_PROCESS["exe_path"],
    )
    # KILLED must be stamped before terminate.
    shared.update_process_status_in_json.assert_any_call(
        1111, "KILLED", svc.firebase_client, process_id="proc-abc"
    )
    svc.handle_process_launch.assert_called_once_with(SAMPLE_PROCESS)
    # Immediate launch — skips backoff.
    assert "proc-abc" in svc._skip_launch_delay
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
        _arm_gate(shared)
        util.is_pid_running.return_value = True

        _handle_restart_process(
            {"process_name": "TouchDesigner", "timeout_seconds": 12},
            "cmd-1", svc,
        )

    shared.graceful_terminate.assert_called_once_with(
        1111, timeout=12, exe_path=SAMPLE_PROCESS["exe_path"]
    )


def test_restart_clamps_timeout_at_30_seconds():
    """defensive cap so a malformed payload can't park the worker forever."""
    svc = _make_service(last_started={"proc-abc": {"pid": 1111}})
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        _arm_gate(shared)
        util.is_pid_running.return_value = True

        _handle_restart_process(
            {"process_name": "TouchDesigner", "timeout_seconds": 9999},
            "cmd-1", svc,
        )

    shared.graceful_terminate.assert_called_once_with(
        1111, timeout=30, exe_path=SAMPLE_PROCESS["exe_path"]
    )


# --- identity gate: tracked pid ---------------------------------------------


def test_tracked_pid_identity_mismatch_refuses_and_cleans_stale_row():
    """pid recycled: the tracked pid is alive but identity_matches says it is
    no longer the recorded process. refuse (never kill the stranger), drop the
    stale state row so it can't feed a later kill, and drop the tracking entry
    so a retry converges on discovery or a fresh launch instead of refusing on
    the same stale pid forever."""
    states = {
        **_states_with_record(pid=1111),
        # an unrelated row that must survive the cleanup untouched
        "2222": {"id": "proc-other", "status": "RUNNING"},
    }
    svc = _make_service(last_started={"proc-abc": {"pid": 1111}})
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.is_within_schedule.return_value = True
        _arm_gate(shared, states=states, matches=False)
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert result.startswith("Error:")
    assert "1111" in result and "TouchDesigner" in result
    assert "recycled" in result
    shared.graceful_terminate.assert_not_called()
    # KILLED must never be stamped onto a stranger's row
    shared.update_process_status_in_json.assert_not_called()
    # a refusal fails the whole command -- no relaunch on top of a refusal
    svc.handle_process_launch.assert_not_called()
    # stale row dropped, unrelated rows kept
    written, dest = shared.write_json_to_file.call_args[0]
    assert "1111" not in written
    assert "2222" in written
    assert dest is shared.RESULT_FILE_PATH
    # tracking entry dropped so the next attempt converges
    assert "proc-abc" not in svc.last_started


@pytest.mark.parametrize(
    "states",
    [
        {},  # no row at all
        {"1111": {"id": "proc-abc", "status": "RUNNING"}},  # pre-3.3.0 row: no create_time
    ],
    ids=["no-row", "row-without-record"],
)
def test_tracked_pid_without_identity_record_refuses(states):
    """no durable record, no kill: an alive tracked pid that cannot be proven
    is refused as not managed by owlette. nothing is cleaned (the row, if any,
    may be a legitimate pre-3.3.0 row) and the tracking entry stays, so the
    refusal cannot trigger a duplicate launch on top of a possibly-real
    process."""
    svc = _make_service(last_started={"proc-abc": {"pid": 1111}})
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.is_within_schedule.return_value = True
        _arm_gate(shared, states=states)
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert result.startswith("Error:")
    assert "not managed by owlette" in result
    assert "1111" in result and "TouchDesigner" in result
    shared.graceful_terminate.assert_not_called()
    shared.update_process_status_in_json.assert_not_called()
    shared.write_json_to_file.assert_not_called()
    svc.handle_process_launch.assert_not_called()
    assert svc.last_started.get("proc-abc") == {"pid": 1111}


def test_tracked_pid_recorded_for_other_entry_refuses():
    """tracking drift: the pid row belongs to a different config entry.
    killing it through this entry's restart would terminate another entry's
    managed process."""
    states = {
        "1111": {
            "id": "proc-OTHER",
            "status": "RUNNING",
            "create_time": 5.0,
            "exe": RECORDED_EXE,
        }
    }
    svc = _make_service(last_started={"proc-abc": {"pid": 1111}})
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.is_within_schedule.return_value = True
        _arm_gate(shared, states=states)
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert result.startswith("Error:")
    assert "proc-OTHER" in result
    assert "1111" in result
    shared.graceful_terminate.assert_not_called()
    shared.identity_matches.assert_not_called()
    svc.handle_process_launch.assert_not_called()


# --- identity gate: strict-discovery fallback --------------------------------


def test_fallback_strict_unique_readable_identity_kills():
    """off-mode path: no tracked pid, strict discovery finds exactly one
    instance, no record exists for it (off-mode processes are never adopted),
    and its live identity is readable -> that pid, and only that pid, is
    terminated. this is the sanctioned strict-unique-plus-readable-identity
    exception to the record requirement."""
    svc = _make_service(last_started={}, launch_pid=8888, find_pid=7777)
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        _arm_gate(shared, states={})  # no row for 7777 -- record-less
        shared.read_process_identity.return_value = {
            "pid": 7777, "create_time": 99.0, "exe": RECORDED_EXE,
        }
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    svc._find_running_process_by_exe.assert_called_once_with(
        SAMPLE_PROCESS["exe_path"], "", strict=True
    )
    shared.read_process_identity.assert_called_once_with(7777)
    shared.identity_matches.assert_not_called()  # no record to compare
    shared.graceful_terminate.assert_called_once_with(
        7777,
        timeout=DEFAULT_RESTART_TIMEOUT_SECONDS,
        exe_path=SAMPLE_PROCESS["exe_path"],
    )
    shared.update_process_status_in_json.assert_any_call(
        7777, "KILLED", svc.firebase_client, process_id="proc-abc"
    )
    assert "7777" in result and "8888" in result


def test_fallback_unreadable_identity_refuses():
    """strict discovery found a unique pid but its identity cannot be read:
    a process the gate can never re-prove must not be touched."""
    svc = _make_service(last_started={}, find_pid=7777)
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.is_within_schedule.return_value = True
        _arm_gate(shared, states={})
        shared.read_process_identity.return_value = None
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert result.startswith("Error:")
    assert "7777" in result and "TouchDesigner" in result
    shared.graceful_terminate.assert_not_called()
    shared.update_process_status_in_json.assert_not_called()
    svc.handle_process_launch.assert_not_called()


def test_fallback_pid_recorded_for_other_entry_refuses():
    """the discovered pid carries another entry's identity row: it is managed,
    but not by this entry -- refuse."""
    states = {
        "7777": {
            "id": "proc-OTHER",
            "status": "RUNNING",
            "create_time": 5.0,
            "exe": RECORDED_EXE,
        }
    }
    svc = _make_service(last_started={}, find_pid=7777)
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.is_within_schedule.return_value = True
        _arm_gate(shared, states=states)
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert result.startswith("Error:")
    assert "proc-OTHER" in result and "7777" in result
    shared.graceful_terminate.assert_not_called()
    svc.handle_process_launch.assert_not_called()


def test_fallback_recorded_row_mismatch_refuses_and_drops_row():
    """the discovered pid has this entry's record (e.g. kept by recovery for
    an off-mode entry) but the identity no longer matches -> refuse and drop
    the stale row, same as the tracked path."""
    states = _states_with_record(pid=7777)
    svc = _make_service(last_started={}, find_pid=7777)
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.is_within_schedule.return_value = True
        _arm_gate(shared, states=states, matches=False)
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert result.startswith("Error:")
    assert "7777" in result
    shared.graceful_terminate.assert_not_called()
    written, dest = shared.write_json_to_file.call_args[0]
    assert "7777" not in written
    assert dest is shared.RESULT_FILE_PATH


def test_fallback_recorded_row_match_kills():
    """the discovered pid has this entry's record and it still matches -> the
    full record gate passes and the pid is terminated (no readable-identity
    exception needed)."""
    states = _states_with_record(pid=7777)
    svc = _make_service(last_started={}, launch_pid=8888, find_pid=7777)
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        _arm_gate(shared, states=states)
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    shared.identity_matches.assert_called_once_with(
        {"pid": 7777, "create_time": 1234.5, "exe": RECORDED_EXE}, 7777
    )
    shared.read_process_identity.assert_not_called()
    shared.graceful_terminate.assert_called_once_with(
        7777,
        timeout=DEFAULT_RESTART_TIMEOUT_SECONDS,
        exe_path=SAMPLE_PROCESS["exe_path"],
    )
    assert "7777" in result and "8888" in result


# --- not-running paths --------------------------------------------------------


def test_restart_when_no_tracked_pid_just_launches():
    """no last_started entry and nothing discovered -> no terminate, just launch."""
    svc = _make_service(last_started={}, launch_pid=3333)
    with patch("process_commands.shared_utils") as shared, \
         patch("owlette_service.Util") as util:
        shared.read_config.return_value = [SAMPLE_PROCESS]
        shared.is_within_schedule.return_value = True
        util.is_pid_running.return_value = False

        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    # honesty check (sweep finding): discovery IS consulted and explicitly
    # finds nothing -- the launch happens because nothing was found, not
    # because a later liveness check bailed on a truthy Mock.
    svc._find_running_process_by_exe.assert_called_once_with(
        SAMPLE_PROCESS["exe_path"], "", strict=True
    )
    shared.read_process_identity.assert_not_called()
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

    # dead tracked pid falls through to discovery, which honestly finds
    # nothing (find_pid=None) -- so no terminate, just launch.
    svc._find_running_process_by_exe.assert_called_once_with(
        SAMPLE_PROCESS["exe_path"], "", strict=True
    )
    shared.graceful_terminate.assert_not_called()
    assert "not running" in result.lower()
    svc.handle_process_launch.assert_called_once_with(SAMPLE_PROCESS)


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
        # graceful_terminate returns True after escalating to terminate()/kill()
        # when WM_CLOSE didn't take.
        shared.graceful_terminate.return_value = True
        shared.is_within_schedule.return_value = True
        _arm_gate(shared)
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"process_name": "TouchDesigner", "timeout_seconds": 2},
            "cmd-1", svc,
        )

    shared.graceful_terminate.assert_called_once_with(
        1111, timeout=2, exe_path=SAMPLE_PROCESS["exe_path"]
    )
    svc.handle_process_launch.assert_called_once_with(SAMPLE_PROCESS)
    assert "1111" in result and "5555" in result


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
        _arm_gate(shared)
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
        _arm_gate(shared)
        util.is_pid_running.return_value = True

        result = _handle_restart_process(
            {"processId": "proc-abc"}, "cmd-1", svc
        )

    assert "restarted" in result.lower()


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
        _arm_gate(shared)
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
        _arm_gate(shared)
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
        _arm_gate(shared)
        util.is_pid_running.return_value = True

        # Must not raise even though log_event blows up.
        result = _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert "restarted" in result.lower()


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
        _arm_gate(shared)
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
        _arm_gate(shared)
        util.is_pid_running.return_value = True

        _handle_restart_process(
            {"process_name": "TouchDesigner"}, "cmd-1", svc
        )

    assert "proc-abc" not in svc.manual_overrides


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
        _arm_gate(shared)
        util.is_pid_running.return_value = True

        result = router.dispatch(
            "restart_process",
            {"process_name": "TouchDesigner"},
            "cmd-99",
            svc,
        )

    assert "restarted" in result.lower()
