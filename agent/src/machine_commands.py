"""
machine_commands — public-API command handlers that register on the
CommandRouter (api-sprint wave 2 — track 2A).

This module wires the `capture_screenshot` command type into the
CommandRouter so the public command-dispatch surface
(`POST /api/sites/{siteId}/machines/{machineId}/commands` with
`type=capture_screenshot`) lands on a real handler.

History: the original api-sprint implementation called the new
`screenshot_capture.capture_and_upload()` flow, which runs mss directly
in the service process and uploads via the `/screenshots/upload-url`
signed-URL endpoint. Two problems with that on a real install:

  1. The Windows service runs as LocalSystem in Session 0. mss inside
     Session 0 captures the LocalSystem display (blank, ~2 KB), not the
     interactive user's desktop. Pre-refactor screenshots ran inside the
     active user's session via CreateProcessAsUser.
  2. The signed-URL upload writes a `screenshot_path` into the command
     result but never updates the `machine.lastScreenshot` Firestore
     field the dashboard's ScreenshotDialog listens on. So even a
     successful upload doesn't surface in the UI.

OwletteService still has `_handle_capture_screenshot` (uses
`execute_in_user_session` → user-session mss → `/api/agent/screenshot`
which writes `lastScreenshot` correctly) — the working flow that has
shipped to prod since 2.11. We delegate to it here and translate the
return shape so the command-router contract is unchanged.

Follow-up: when prod field agents have all upgraded past 2.12.x, port
the user-session capture into `screenshot_capture.py` and switch back
to the signed-URL upload (which is the long-term plan because it avoids
proxying multi-MB image bodies through Next.js).
"""

from __future__ import annotations

import logging
from typing import Any

from command_router import CommandRouter

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
    capture_screenshot handler. Delegates to OwletteService's working
    user-session capture + base64 upload path (see file docstring for
    why we don't use the new signed-URL flow yet).

    returns:
      dict { size_kb, monitor, url } on success (url empty if upload
        succeeded but the response had no url).
      'Error: ...' string on failure, which routes through
        _mark_command_failed.
    """
    handler = getattr(service, "_handle_capture_screenshot", None)
    if handler is None:
        return "Error: service._handle_capture_screenshot unavailable"

    try:
        result = handler(cmd_data)
    except Exception as e:
        logger.exception("capture_screenshot: unexpected error")
        return f"Error: capture_screenshot raised {type(e).__name__}: {e}"

    if not isinstance(result, dict):
        return f"Error: unexpected handler return type {type(result).__name__}"

    err = result.get("error")
    if err:
        return f"Error: {err}"

    # Translate to a compact result envelope (omit the base64 blob — the
    # GET command-status route doesn't need it and it bloats Firestore).
    return {
        "size_kb": result.get("size_kb", 0),
        "monitor": result.get("monitor", 0),
        "url": result.get("url", ""),
        "message": result.get("message", ""),
    }
