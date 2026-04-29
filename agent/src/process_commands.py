"""
process_commands — public-API process control handlers that register on
the CommandRouter.

This module hosts the `restart_process` handler (R.2 of the landing-redesign
restart-end-to-end wave). Restart semantics:

    1. resolve the target process by `process_name` or `process_id`
    2. if currently running, gracefully terminate (WM_CLOSE → SIGTERM →
       hard kill), bounded by `timeout_seconds` (default 5s, matching
       shared_utils.graceful_terminate's default)
    3. re-launch using the same stored launch params via
       `service.handle_process_launch()`
    4. emit a single composite `process_restarted` audit event

handlers run on the `_slow_command_worker` thread per CommandRouter
contract — graceful termination can take up to `timeout + 3` seconds, so
this MUST NOT block the main 10-second monitoring loop.

design notes:
- the legacy if/elif chain in `OwletteService._execute_command` still
  contains a `restart_process` case for back-compat with older command
  shapes. CommandRouter is checked first in handle_firebase_command, so
  this handler takes precedence — the legacy branch only fires if this
  module fails to load (and a warning is logged in that case).
- audit pattern: existing handlers emit `process_started` / `process_killed`
  separately. for restart we prefer one composite `process_restarted`
  event so dashboards can render the action atomically. (see CHANGELOG /
  R.2 task notes — single composite was the explicit preference.)
- relaunch backoff: handle_process_launch consults `self.last_started` to
  enforce time_to_init pacing. for an explicit operator-driven restart we
  pop the entry and add the process_id to `_skip_launch_delay` so the
  relaunch is immediate, matching the existing legacy behavior.

CLAUDE.md compliance:
- no firebase_admin import (handler talks to firestore via
  service.firebase_client)
- no token logging
- handler returns string result; firebase_client persists it under
  completed.{cmd_id}.result
"""

from __future__ import annotations

import datetime
import logging
from typing import Any, Optional

import shared_utils
from command_router import CommandRouter

logger = logging.getLogger(__name__)


# default graceful-exit window when payload omits `timeout_seconds`.
# matches shared_utils.graceful_terminate(timeout=5) so behavior is the
# same as a `stop_process` followed by a `start_process`.
DEFAULT_RESTART_TIMEOUT_SECONDS = 5


def register_handlers(router: CommandRouter) -> None:
    """
    register process-control public handlers on the given CommandRouter.
    called once at OwletteService init time after the router is created.
    """
    router.register("restart_process")(_handle_restart_process)
    logger.info("process_commands: registered handlers — restart_process")


def _find_process(cmd_data: dict) -> tuple[Optional[dict], Optional[str]]:
    """
    locate the target process in config by process_id (preferred) or
    process_name. returns (process_dict, identifier_used_for_error_msg).

    matches the resolution order in the legacy `_execute_command` chain:
    process_id wins over process_name when both are supplied.
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
    """
    if the process has a tracked PID and that PID is alive, gracefully
    terminate it (WM_CLOSE → terminate → kill, bounded by `timeout_seconds`).

    returns the pid that was terminated, or None if nothing was running.
    """
    process_list_id = process["id"]
    process_name = process.get("name", process_list_id)

    last_info = service.last_started.get(process_list_id, {}) or {}
    last_pid = last_info.get("pid")

    # import here so unit tests can mock psutil at module-load time without
    # needing pywin32 on the test runner.
    from owlette_service import Util  # local import — avoid circular

    if not last_pid or not Util.is_pid_running(last_pid):
        return None

    # mark as KILLED so the crash-detection path in handle_process()
    # doesn't fire an alert when it sees the PID gone next loop tick.
    shared_utils.update_process_status_in_json(
        last_pid,
        "KILLED",
        service.firebase_client,
        process_id=process_list_id,
    )

    terminated = shared_utils.graceful_terminate(last_pid, timeout=timeout_seconds)
    if terminated:
        logger.info(
            f"restart_process: terminated PID {last_pid} for '{process_name}' "
            f"(graceful timeout={timeout_seconds}s)"
        )
    else:
        # graceful_terminate returns False only when the process was
        # already gone before the WM_CLOSE — treat as "wasn't running".
        logger.info(
            f"restart_process: PID {last_pid} for '{process_name}' was "
            f"already gone before terminate"
        )
        return None

    # mark as killed (not removed!) so the main loop doesn't treat an
    # absent last_started entry as "untracked → needs launch" and double-
    # launch on top of our re-launch below. this mirrors stop_process.
    service.last_started[process_list_id] = {
        "killed": True,
        "time": datetime.datetime.now(),
    }
    return last_pid


def _relaunch(service: Any, process: dict) -> Optional[int]:
    """
    pop the killed/last_started entry, request immediate launch (skip
    the time_to_init backoff that handle_process_launch otherwise enforces
    on rapid relaunches), and call back into the service to launch.

    returns the new PID, or None on failure.
    """
    process_list_id = process["id"]

    # explicit operator-driven restart — bypass the backoff that exists
    # for crash-recovery spacing. matches the legacy restart_process
    # behavior in _execute_command.
    service.last_started.pop(process_list_id, None)
    service.relaunch_attempts.pop(process.get("name", ""), None)
    service._skip_launch_delay.add(process_list_id)

    return service.handle_process_launch(process)


def _handle_restart_process(cmd_data: dict, cmd_id: str, service: Any) -> str:
    """
    `restart_process` command handler.

    cmd_data:
      process_name:    str — process display name (matches config.processes[].name)
      process_id:      str — config process id (preferred over name when both given)
      timeout_seconds: int — optional, default 5. graceful-exit window before
                             escalating to hard kill. capped at 30s defensively.

    returns:
      human-readable status string. begins with 'Error:' on failure so
      firebase_client._mark_command_failed is invoked.
    """
    target, missing_target = _find_process(cmd_data)
    if target is None:
        return f"Process {missing_target} not found in configuration"

    process_name = target.get("name") or target.get("id", "<unknown>")
    process_list_id = target["id"]

    # validate + clamp timeout — accept ints/floats from payload, reject
    # negatives, and cap at 30s so a malformed command can't park the
    # slow-command worker indefinitely.
    raw_timeout = cmd_data.get("timeout_seconds", DEFAULT_RESTART_TIMEOUT_SECONDS)
    try:
        timeout_seconds = int(raw_timeout)
    except (TypeError, ValueError):
        return f"Error: invalid timeout_seconds value: {raw_timeout!r}"
    if timeout_seconds < 0:
        return f"Error: timeout_seconds must be >= 0 (got {timeout_seconds})"
    if timeout_seconds > 30:
        timeout_seconds = 30

    # respect manual-override semantics for scheduled processes: if the
    # operator restarts a scheduled process outside its window, mark it
    # as a manual override so the main loop doesn't immediately stop it
    # again. matches the legacy restart_process behavior.
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
        # emit a failure audit event so dashboards see the restart attempt
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

    # single composite audit event — restart is one logical operation,
    # easier for dashboards to render atomically than separate
    # stopped+started events. see module docstring + R.2 task notes.
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
    """
    fire-and-forget audit event emit. swallows errors so a transient
    firestore failure can't fail the whole restart command — the operator
    already got a result string back, and the audit log is best-effort.
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
