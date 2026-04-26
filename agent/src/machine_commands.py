"""
machine_commands — public-API command handlers that register on the
CommandRouter (api-sprint wave 2 — track 2A).

This module wires the `capture_screenshot` command type to the new
signed-URL upload flow in `screenshot_capture.py`. The handler runs on
the `_slow_command_worker` thread (per CommandRouter contract): a
multi-monitor PNG capture takes ~200 ms but the upload is bounded only
by the network, so blocking the main 10-second loop would stall presence
+ heartbeat.

return shape:
- the handler returns a dict — `firebase_client._mark_command_completed`
  stores it verbatim under `result: {...}`. the public GET status route
  re-mints a signed read url for `result.screenshot_path` per request.
- on failure, the handler returns a string starting with `'Error:'` so
  `_execute_command` routes it through `_mark_command_failed` (matches
  the existing convention for other handlers).
"""

from __future__ import annotations

import logging
from typing import Any

import shared_utils
from command_router import CommandRouter
from screenshot_capture import (
    ScreenshotCaptureError,
    capture_and_upload,
)

logger = logging.getLogger(__name__)


def register_handlers(router: CommandRouter) -> None:
    """
    register all machine-api public handlers on the given CommandRouter.
    called once at OwletteService init time after the router is created.
    """
    router.register("capture_screenshot")(_handle_capture_screenshot)
    logger.info(
        "machine_commands: registered handlers — capture_screenshot"
    )


def _handle_capture_screenshot(cmd_data: dict, cmd_id: str, service: Any):
    """
    capture_screenshot handler. takes the agent's bearer id-token from the
    auth manager, requests a signed upload url from the web tier, captures
    via mss, and uploads directly to Firebase Storage.

    returns:
      dict { screenshot_path, size_kb, monitor, monitor_count } on success.
      'Error: ...' string on failure, which routes through _mark_command_failed.
    """
    monitor = cmd_data.get("monitor", 0)

    fb = getattr(service, "firebase_client", None)
    if fb is None:
        return "Error: firebase_client unavailable; cannot dispatch capture_screenshot"

    auth_manager = getattr(fb, "auth_manager", None)
    if auth_manager is None:
        return "Error: auth_manager unavailable on firebase_client"

    try:
        token = auth_manager.get_valid_token()
    except Exception as e:
        return f"Error: failed to obtain valid auth token: {e}"

    site_id = getattr(fb, "site_id", None)
    machine_id = getattr(fb, "machine_id", None)
    if not site_id or not machine_id:
        return "Error: site_id or machine_id missing on firebase_client"

    api_base = shared_utils.get_api_base_url()

    try:
        result = capture_and_upload(
            api_base=api_base,
            site_id=site_id,
            machine_id=machine_id,
            bearer_token=token,
            monitor=monitor,
        )
    except ScreenshotCaptureError as e:
        return f"Error: capture_screenshot failed: {e}"
    except Exception as e:
        # surface unexpected failures with the same Error: prefix so they
        # land in completed.{cmd_id}.error rather than completed.result.
        logger.exception("capture_screenshot: unexpected error")
        return f"Error: capture_screenshot raised {type(e).__name__}: {e}"

    try:
        fb.log_event(
            action="command_executed",
            level="info",
            details=(
                f"Screenshot captured "
                f"({result.get('size_kb', 0)}KB, monitor={result.get('monitor')})"
            ),
        )
    except Exception as e:
        # Best-effort audit logging — do not surface to the command result.
        logger.debug(f"capture_screenshot: log_event failed: {e}")

    return result
