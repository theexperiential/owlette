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


def _stop_if_running(service: Any, process: dict, timeout_seconds: int) -> Optional[int]:
    """Gracefully terminate the tracked PID if it's alive.

    Returns the terminated pid, or None if nothing was running.
    """
    process_list_id = process["id"]
    process_name = process.get("name", process_list_id)

    last_info = service.last_started.get(process_list_id, {}) or {}
    last_pid = last_info.get("pid")

    # Local import: avoids a circular import, and lets unit tests mock psutil
    # without pywin32 on the runner.
    from owlette_service import Util

    if not last_pid or not Util.is_pid_running(last_pid):
        # The monitor loop never adopts off-mode processes, so last_started has
        # no live PID for them. Fall back to strict exe/file_path discovery or a
        # restart launches a duplicate on top of the live instance. Strict
        # matching never kills on a bare image name.
        exe_path = process.get("exe_path", "")
        file_path = process.get("file_path", "")
        last_pid = (
            service._find_running_process_by_exe(exe_path, file_path, strict=True)
            if exe_path else None
        )
        if not last_pid or not Util.is_pid_running(last_pid):
            return None

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
