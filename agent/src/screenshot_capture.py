"""
screenshot_capture — agent-side flow for the public `capture_screenshot`
command (api-sprint wave 2 — track 2A).

This module is a thin orchestration layer: it wraps `mss` (already
vendored in agent/requirements.txt) for fast multi-monitor capture, asks
the web tier for a 5-min signed PUT URL, uploads the bytes directly to
Firebase Storage, and returns the canonical storage path so the
command_router handler can persist it to the command's result envelope.

design notes:
- we use `mss` rather than PIL.ImageGrab because mss handles multi-
  monitor with stable indices on Windows (monitor 0 is the virtual
  bounding box of all monitors, 1..N are individual displays). PIL's
  ImageGrab works but doesn't expose per-monitor selection cleanly.
- the upload is a direct-to-storage PUT; we never proxy bytes through
  the web tier. retries are bounded (3 attempts with exponential
  backoff) so a transient network blip doesn't fail the command, but a
  durable outage surfaces quickly to the dashboard.
- runs on the `_slow_command_worker` thread per CommandRouter contract.
  `mss` itself is fast (<200ms per monitor) but the upload is unbounded;
  blocking the main 10-second loop would stall presence/heartbeat.
"""

from __future__ import annotations

import io
import logging
import time
from typing import Any, Optional, Tuple

import requests

logger = logging.getLogger(__name__)


SIGNED_URL_PATH_TMPL = "/sites/{site_id}/machines/{machine_id}/screenshots/upload-url"
DEFAULT_CONTENT_TYPE = "image/png"
UPLOAD_TIMEOUT_S = 30
MAX_UPLOAD_ATTEMPTS = 3
INITIAL_BACKOFF_S = 1.0


class ScreenshotCaptureError(RuntimeError):
    """raised when capture or upload fails after all retries."""


def capture_to_png_bytes(monitor: Any = 0) -> Tuple[bytes, int]:
    """
    grab a screenshot using `mss` and return (png_bytes, monitor_count).

    monitor selection:
      - 'all' or 0     → mss.monitors[0]   (virtual bounding box, all displays)
      - 'primary' or 1 → mss.monitors[1]   (primary monitor)
      - <int> n        → mss.monitors[n]   (1-indexed display)

    raises ScreenshotCaptureError on capture failure or out-of-range
    monitor index.
    """
    import mss
    from mss.tools import to_png

    with mss.mss() as sct:
        n_monitors = len(sct.monitors) - 1  # entry 0 is the virtual bbox
        idx = _resolve_monitor_index(monitor, n_monitors)

        try:
            shot = sct.grab(sct.monitors[idx])
        except Exception as e:  # pragma: no cover — pass-through
            raise ScreenshotCaptureError(
                f"mss.grab failed for monitor index {idx}: {e}"
            ) from e

        try:
            png_bytes = to_png(shot.rgb, shot.size)
        except Exception as e:  # pragma: no cover — pass-through
            raise ScreenshotCaptureError(f"png encode failed: {e}") from e

    return png_bytes, n_monitors


def _resolve_monitor_index(monitor: Any, n_monitors: int) -> int:
    """
    map the public monitor selector ('all' | 'primary' | int) to the
    mss-internal 1-indexed monitor list. raises ScreenshotCaptureError
    on invalid input or an out-of-range integer.
    """
    if monitor is None or monitor == "all" or monitor == 0:
        return 0  # virtual bounding box → captures all displays at once
    if monitor == "primary":
        return 1
    if isinstance(monitor, bool):
        # bool is a subclass of int in python, but our public api treats
        # booleans as invalid input — surface that explicitly.
        raise ScreenshotCaptureError(
            f"invalid monitor value: {monitor!r} (bool not accepted)"
        )
    if isinstance(monitor, int):
        if monitor < 0 or monitor > n_monitors:
            raise ScreenshotCaptureError(
                f"monitor index {monitor} out of range (have {n_monitors} displays)"
            )
        return monitor
    raise ScreenshotCaptureError(
        f"invalid monitor value: {monitor!r} (expected 'all', 'primary', or int)"
    )


def request_upload_url(
    api_base: str,
    site_id: str,
    machine_id: str,
    bearer_token: str,
    content_type: str = DEFAULT_CONTENT_TYPE,
) -> dict:
    """
    POST `/api/sites/{site}/machines/{machine}/screenshots/upload-url`,
    returning the parsed `{uploadUrl, storagePath, contentType, expiresAt}`
    envelope. raises ScreenshotCaptureError on non-2xx responses.
    """
    url = api_base.rstrip("/") + SIGNED_URL_PATH_TMPL.format(
        site_id=site_id, machine_id=machine_id
    )
    headers = {
        "Authorization": f"Bearer {bearer_token}",
        "Content-Type": "application/json",
    }
    body = {"contentType": content_type}

    resp = requests.post(url, json=body, headers=headers, timeout=15)
    if resp.status_code >= 400:
        raise ScreenshotCaptureError(
            f"upload-url request failed: {resp.status_code} {resp.text[:200]}"
        )
    payload = resp.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    if not data or not isinstance(data, dict):
        raise ScreenshotCaptureError(
            f"upload-url response missing data envelope: {payload!r}"
        )
    if "uploadUrl" not in data or "storagePath" not in data:
        raise ScreenshotCaptureError(
            f"upload-url response missing fields: {data!r}"
        )
    return data


def upload_to_signed_url(
    upload_url: str,
    png_bytes: bytes,
    content_type: str = DEFAULT_CONTENT_TYPE,
    max_attempts: int = MAX_UPLOAD_ATTEMPTS,
    backoff_s: float = INITIAL_BACKOFF_S,
    sleep_fn: Any = time.sleep,
) -> None:
    """
    PUT the captured bytes directly to the signed url. retries up to
    `max_attempts` times with exponential backoff on 5xx + network
    errors; 4xx responses fail fast (signed-url 4xx means a bad signature
    or expired url, both of which won't recover on retry).
    """
    last_exc: Optional[Exception] = None
    for attempt in range(1, max_attempts + 1):
        try:
            resp = requests.put(
                upload_url,
                data=png_bytes,
                headers={"Content-Type": content_type},
                timeout=UPLOAD_TIMEOUT_S,
            )
            if 200 <= resp.status_code < 300:
                return
            if 400 <= resp.status_code < 500:
                # signed-url 4xx is terminal — don't waste retries.
                raise ScreenshotCaptureError(
                    f"signed-url upload rejected: {resp.status_code} {resp.text[:200]}"
                )
            last_exc = ScreenshotCaptureError(
                f"signed-url upload failed: {resp.status_code} {resp.text[:200]}"
            )
        except requests.RequestException as e:
            last_exc = e

        if attempt < max_attempts:
            sleep_fn(backoff_s * (2 ** (attempt - 1)))

    raise ScreenshotCaptureError(
        f"upload failed after {max_attempts} attempts: {last_exc}"
    )


def capture_and_upload(
    api_base: str,
    site_id: str,
    machine_id: str,
    bearer_token: str,
    monitor: Any = 0,
) -> dict:
    """
    full pipeline: capture → request signed url → upload → return result
    envelope suitable for the command's `result` field.

    returns:
      {
        'screenshot_path': str,   # canonical storage path (no signed url)
        'size_kb': int,
        'monitor': original monitor selector (echoed for logs / dashboard),
        'monitor_count': int,
      }
    """
    png_bytes, n_monitors = capture_to_png_bytes(monitor)
    size_kb = max(1, len(png_bytes) // 1024)

    issued = request_upload_url(api_base, site_id, machine_id, bearer_token)
    upload_url = issued["uploadUrl"]
    storage_path = issued["storagePath"]
    content_type = issued.get("contentType", DEFAULT_CONTENT_TYPE)

    upload_to_signed_url(upload_url, png_bytes, content_type=content_type)

    logger.info(
        "screenshot_capture: uploaded %d KB to %s (monitor=%s)",
        size_kb,
        storage_path,
        monitor,
    )

    return {
        "screenshot_path": storage_path,
        "size_kb": size_kb,
        "monitor": monitor,
        "monitor_count": n_monitors,
    }
