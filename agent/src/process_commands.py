"""Public-API process-control handlers, registered on the CommandRouter.

Hosts `restart_process`: resolve the target by `process_name`/`process_id`,
gracefully terminate (WM_CLOSE → SIGTERM → kill) within `timeout_seconds`,
re-launch via `service.handle_process_launch()`, then emit one composite
`process_restarted` audit event.

Runs on `_slow_command_worker` — termination can take `timeout + 3` seconds, so
it MUST NOT block the main monitoring loop.

Design notes:
- `OwletteService._execute_command`'s legacy if/elif still has a
  `restart_process` case. CommandRouter is checked first, so that branch only
  fires if this module fails to load (logged as a warning).
- One composite event rather than separate stopped+started: restart is a single
  logical operation and dashboards render it atomically.
- handle_process_launch paces relaunches off `self.last_started`; an operator
  restart pops the entry and uses `_skip_launch_delay` so it's immediate.
- Termination is identity-gated (D1 managed-or-inherited): a pid must be
  proven against its durable app_states.json record -- or, for record-less
  off-mode processes, an unambiguous strict discovery match with a readable
  live identity -- before graceful_terminate. Refusals return 'Error:'
  strings; the command route treats that prefix as failed.
"""

from __future__ import annotations

import datetime
import logging
from typing import Any, Optional

import shared_utils
from command_router import CommandRouter

logger = logging.getLogger(__name__)


# Matches shared_utils.graceful_terminate(timeout=5), so an omitted
# `timeout_seconds` behaves like stop_process followed by start_process.
DEFAULT_RESTART_TIMEOUT_SECONDS = 5


class _IdentityRefusedError(Exception):
    """A terminate was refused because the identity gate failed.

    The message is the operator-facing reason (entry, pid, why);
    _handle_restart_process prefixes it with 'Error:' -- the contract that
    marks the command failed instead of completed.
    """


def register_handlers(router: CommandRouter) -> None:
    """Register process-control handlers. Called once at OwletteService init."""
    router.register("restart_process")(_handle_restart_process)
    logger.info("process_commands: registered handlers — restart_process")


def _find_process(cmd_data: dict) -> tuple[Optional[dict], Optional[str]]:
    """Locate the target process by process_id (preferred) or process_name.

    Returns (process_dict, identifier_for_error_msg). Resolution order matches
    the legacy `_execute_command` chain.
    """
    process_name = cmd_data.get("process_name")
    process_id = cmd_data.get("process_id") or cmd_data.get("processId")

    processes = shared_utils.read_config(["processes"]) or []
    for process in processes:
        if (
            (process_id and process.get("id") == process_id)
            or (process_name and process.get("name") == process_name)
        ):
            return process, None

    target = process_id or process_name or "<unspecified>"
    return None, target


def _drop_state_row(pid: int) -> None:
    """Remove a pid row from app_states.json.

    Called only when the gate has proven the row stale (pid recycled): left in
    place, the record could later resolve into a kill of the stranger now
    wearing the pid. Fresh read-modify-write -- the same pattern as
    update_process_status_in_json -- keeps the window against the service's
    concurrent writers narrow.
    """
    states = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)
    if isinstance(states, dict) and states.pop(str(pid), None) is not None:
        shared_utils.write_json_to_file(states, shared_utils.RESULT_FILE_PATH)


def _verify_recorded_identity(
    service: Any,
    process_list_id: str,
    process_name: str,
    pid: int,
    require_record: bool,
) -> None:
    """The identity gate (D1) for one candidate pid; raises on refusal.

    Loads the pid's app_states.json row and returns only when the pid is
    proven safe to terminate. require_record=True is the tracked-pid rule (no
    durable proof, no kill). require_record=False is the strict-discovery
    exception: off-mode processes are never adopted so they cannot carry a
    record, and an unambiguous strict match plus a readable live identity is
    the sanctioned inherit-grade evidence -- but a record that DOES exist
    still binds (another entry's row, or a recycled pid, refuses).
    """
    states = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH) or {}
    row = states.get(str(pid))
    if not isinstance(row, dict):
        row = None

    recorded_entry = row.get("id") if row else None
    if recorded_entry and recorded_entry != process_list_id:
        # The record binds this pid to a DIFFERENT entry: killing it through
        # this entry's restart would terminate another entry's managed
        # process on stale tracking data.
        raise _IdentityRefusedError(
            f"PID {pid} is recorded for entry '{recorded_entry}', not for "
            f"'{process_name}' - refusing to terminate"
        )

    if row is not None and "create_time" in row:
        # The row carries the (create_time, exe) half of the record; its key
        # supplies the pid half (same assembly as recover_running_processes).
        record = {
            "pid": pid,
            "create_time": row.get("create_time"),
            "exe": row.get("exe"),
        }
        if not shared_utils.identity_matches(record, pid):
            # pid recycled: drop the stale row so the record can never feed a
            # later kill, and drop the tracking entry so retries converge on
            # discovery or a fresh launch instead of refusing on the same
            # stale pid forever.
            _drop_state_row(pid)
            service.last_started.pop(process_list_id, None)
            raise _IdentityRefusedError(
                f"PID {pid} for '{process_name}' is not the process owlette "
                f"recorded (pid recycled) - refusing to terminate, stale "
                f"record removed"
            )
        return

    if require_record:
        raise _IdentityRefusedError(
            f"PID {pid} for '{process_name}' has no identity record - not "
            f"managed by owlette, refusing to terminate"
        )

    if shared_utils.read_process_identity(pid) is None:
        # Unreadable now means unverifiable forever -- a process the gate can
        # never re-prove must not be touched.
        raise _IdentityRefusedError(
            f"PID {pid} for '{process_name}' matched strict discovery but "
            f"its identity is unreadable - refusing to terminate"
        )


def _stop_if_running(service: Any, process: dict, timeout_seconds: int) -> Optional[int]:
    """Gracefully terminate the entry's process -- identity-proven only.

    Returns the terminated pid, or None if nothing was running. Raises
    _IdentityRefusedError rather than touch a pid that cannot be proven to be
    the process owlette recorded (D1 managed-or-inherited): last_started and
    strict discovery both merely NAME a pid; only the durable identity record
    -- or, for record-less off-mode processes, an unambiguous strict match
    with a readable live identity -- proves the pid was not recycled.
    """
    process_list_id = process["id"]
    process_name = process.get("name", process_list_id)

    last_info = service.last_started.get(process_list_id, {}) or {}
    last_pid = last_info.get("pid")

    # Local import: avoids a circular import, and lets unit tests mock psutil
    # without pywin32 on the runner.
    from owlette_service import Util

    if last_pid and Util.is_pid_running(last_pid):
        # In-memory tracking is bookkeeping, not proof: the pid may have been
        # recycled since it was recorded. Gate on the durable record before
        # any terminate.
        _verify_recorded_identity(
            service, process_list_id, process_name, last_pid,
            require_record=True,
        )
    else:
        # The monitor loop never adopts off-mode processes, so last_started has
        # no live PID for them. Fall back to strict exe/file_path discovery or a
        # restart launches a duplicate on top of the live instance. Strict
        # matching never kills on a bare image name and returns None on any
        # ambiguity, so a hit is unambiguous -- but it is still gated
        # (require_record=False): a row naming another entry, a recycled
        # record, or an unreadable identity all refuse.
        exe_path = process.get("exe_path", "")
        file_path = process.get("file_path", "")
        found_pid = (
            service._find_running_process_by_exe(exe_path, file_path, strict=True)
            if exe_path else None
        )
        if not found_pid or not Util.is_pid_running(found_pid):
            return None
        _verify_recorded_identity(
            service, process_list_id, process_name, found_pid,
            require_record=False,
        )
        last_pid = found_pid

    # KILLED, so handle_process()'s crash detection doesn't alert on the
    # missing PID next tick.
    shared_utils.update_process_status_in_json(
        last_pid,
        "KILLED",
        service.firebase_client,
        process_id=process_list_id,
    )

    # exe_path lets graceful_terminate reap the payload behind a cmd.exe wrapper
    # for .bat/.cmd; without it the tracked pid is the wrapper and the real
    # process survives the "restart".
    terminated = shared_utils.graceful_terminate(
        last_pid, timeout=timeout_seconds, exe_path=process.get("exe_path")
    )
    if terminated:
        logger.info(
            f"restart_process: terminated PID {last_pid} for '{process_name}' "
            f"(graceful timeout={timeout_seconds}s)"
        )
    else:
        # False only means it was already gone before the WM_CLOSE.
        logger.info(
            f"restart_process: PID {last_pid} for '{process_name}' was "
            f"already gone before terminate"
        )
        return None

    # Killed, NOT removed: an absent last_started entry reads as "untracked →
    # needs launch" and double-launches on top of the relaunch below. Mirrors
    # stop_process.
    service.last_started[process_list_id] = {
        "killed": True,
        "time": datetime.datetime.now(),
    }
    return last_pid


def _relaunch(service: Any, process: dict) -> Optional[int]:
    """Pop the last_started entry, skip the time_to_init backoff, and launch.

    Returns the new PID, or None on failure.
    """
    process_list_id = process["id"]

    # Operator-driven, so bypass the crash-recovery spacing backoff (as the
    # legacy _execute_command path did).
    service.last_started.pop(process_list_id, None)
    service.relaunch_attempts.pop(process.get("name", ""), None)
    service._skip_launch_delay.add(process_list_id)

    return service.handle_process_launch(process)


def _handle_restart_process(cmd_data: dict, cmd_id: str, service: Any) -> str:
    """`restart_process` command handler.

    cmd_data: `process_name` (config.processes[].name), `process_id` (preferred
    when both given), `timeout_seconds` (default 5, capped at 30).

    Returns a human-readable status; a leading 'Error:' is what triggers
    firebase_client._mark_command_failed.
    """
    target, missing_target = _find_process(cmd_data)
    if target is None:
        return f"Process {missing_target} not found in configuration"

    process_name = target.get("name") or target.get("id", "<unknown>")
    process_list_id = target["id"]

    # Cap at 30s so a malformed command can't park the slow-command worker.
    raw_timeout = cmd_data.get("timeout_seconds", DEFAULT_RESTART_TIMEOUT_SECONDS)
    try:
        timeout_seconds = int(raw_timeout)
    except (TypeError, ValueError):
        return f"Error: invalid timeout_seconds value: {raw_timeout!r}"
    if timeout_seconds < 0:
        return f"Error: timeout_seconds must be >= 0 (got {timeout_seconds})"
    if timeout_seconds > 30:
        timeout_seconds = 30

    # Restarting a scheduled process outside its window sets a manual override,
    # or the main loop stops it again immediately.
    mode = target.get(
        "launch_mode",
        "always" if target.get("autolaunch", False) else "off",
    )
    if mode == "scheduled":
        within_window = shared_utils.is_within_schedule(
            target.get("schedules"),
            getattr(service, "_cached_site_timezone", None),
        )
        if not within_window:
            service.manual_overrides[process_list_id] = True
            logger.info(
                f"restart_process: manual override set for '{process_name}' "
                f"(restarted outside schedule window)"
            )

    try:
        old_pid = _stop_if_running(service, target, timeout_seconds)
    except _IdentityRefusedError as e:
        # Policy refusal, not an unexpected failure -- warn without a
        # traceback. The 'Error:' prefix is what the command route parses as
        # failed; Wave 6 surfaces these in the UI.
        logger.warning(f"restart_process: refused for '{process_name}': {e}")
        return f"Error: {e}"
    except Exception as e:
        logger.exception(f"restart_process: stop phase failed for '{process_name}'")
        return f"Error: failed to stop {process_name}: {e}"

    try:
        new_pid = _relaunch(service, target)
    except Exception as e:
        logger.exception(f"restart_process: launch phase failed for '{process_name}'")
        _emit_audit(
            service,
            action="process_start_failed",
            level="error",
            process_name=process_name,
            details=(
                f"Restart failed during launch phase "
                f"(old_pid={old_pid}): {e}"
            ),
        )
        return f"Error: failed to relaunch {process_name}: {e}"

    if new_pid is None:
        _emit_audit(
            service,
            action="process_start_failed",
            level="error",
            process_name=process_name,
            details=(
                f"Restart failed during launch phase "
                f"(old_pid={old_pid}): handle_process_launch returned no PID"
            ),
        )
        return f"Error: relaunch of {process_name} returned no PID"

    if old_pid is not None:
        details = (
            f"Restarted {process_name}: terminated PID {old_pid} "
            f"(graceful timeout={timeout_seconds}s) → new PID {new_pid}"
        )
    else:
        details = (
            f"Restarted {process_name}: was not running → launched PID {new_pid}"
        )
    _emit_audit(
        service,
        action="process_restarted",
        level="info",
        process_name=process_name,
        details=details,
    )

    if old_pid is not None:
        return f"Process {process_name} restarted (PID {old_pid} → {new_pid})"
    return f"Process {process_name} was not running, started with PID {new_pid}"


def _emit_audit(
    service: Any,
    *,
    action: str,
    level: str,
    process_name: str,
    details: str,
) -> None:
    """Fire-and-forget audit emit; swallows errors.

    A transient firestore failure must not fail the restart — the operator
    already has their result string and the audit log is best-effort.
    """
    fb = getattr(service, "firebase_client", None)
    if fb is None:
        return
    try:
        if not fb.is_connected():
            return
        fb.log_event(
            action=action,
            level=level,
            process_name=process_name,
            details=details,
        )
    except Exception as e:
        logger.debug(f"restart_process: audit log_event failed ({action}): {e}")
