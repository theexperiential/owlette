"""
screenshot_capture — agent-side flow for the public `capture_screenshot`
command.

End-to-end pipeline (caller passes an executor that runs Python in the
active user's interactive desktop session; service-side this is
`OwletteService.execute_in_user_session`):

  1. capture_in_user_session(executor, monitor)
       The Windows service runs as LocalSystem in Session 0 — mss inside
       Session 0 captures a blank ~2 KB LocalSystem display rather than
       the real desktop. We hand the capture code off to session_exec.py
       via CreateProcessAsUser so mss runs in the user's session and
       sees the actual screen. The user-session script writes the
       captured JPEG bytes into the job's IPC output directory; the
       service reads them back into memory for upload.

  2. request_upload_url(...)
       POST /api/sites/{site}/machines/{machine}/screenshots/upload-url
       → 5-min v4-signed PUT URL + canonical storage path. Auth: bearer
       Firebase ID token (the agent's). Web-side gate is
       requireMachineAuthAndScope which short-circuits for agent tokens
       whose `site_id` + `machine_id` claims match the URL.

  3. upload_to_signed_url(...)
       Direct PUT to GCS via the signed URL. Multi-MB body never proxies
       through Next.js. Bounded retries on 5xx + network errors.

  4. finalize_screenshot(...)
       POST /api/sites/{site}/machines/{machine}/screenshots/finalize
       with the storagePath + sizeKB. Web makes the object publicly
       readable, writes `machine.lastScreenshot = { url, timestamp,
       sizeKB }` (the field the dashboard's ScreenshotDialog listens on
       via Firestore real-time), writes the `screenshots/{docId}`
       history doc, and auto-prunes to the most-recent 20.

Image format: JPEG (PIL quality 72, max-width 7680 px) — matches the
established UX shipped with pre-refactor builds. Falls back to PNG if
PIL is unavailable in the user-session interpreter. The signed-URL
endpoint accepts content-type override `image/jpeg`; the storage path
extension reflects the actual content-type so the URL doesn't lie about
its body.

Error model: every step that fails network-side or schema-side raises
ScreenshotCaptureError with a short tag identifying which step failed.
Unexpected runtime exceptions bubble unchanged — the command_router
catches them and writes the trace into the command's `error` envelope.

Runs on the `_slow_command_worker` thread (CommandRouter contract):
the capture itself is ~200 ms but the IPC + network round-trips are
unbounded; blocking the 10-second main loop would stall heartbeat.
"""

from __future__ import annotations

import logging
import os
import shutil
import time
from typing import Any, Callable, Optional

import requests

logger = logging.getLogger(__name__)


UPLOAD_URL_PATH_TMPL = "/sites/{site_id}/machines/{machine_id}/screenshots/upload-url"
FINALIZE_PATH_TMPL = "/sites/{site_id}/machines/{machine_id}/screenshots/finalize"

DEFAULT_CONTENT_TYPE = "image/jpeg"
SCREENSHOT_FILENAME_JPEG = "screenshot.jpg"
SCREENSHOT_FILENAME_PNG = "screenshot.png"

UPLOAD_TIMEOUT_S = 30
FINALIZE_TIMEOUT_S = 15
MAX_UPLOAD_ATTEMPTS = 3
INITIAL_BACKOFF_S = 1.0
CAPTURE_TIMEOUT_S = 20

# Match the pre-refactor working flow's image budget so the prod history
# feed stays size-comparable across the patch window.
MAX_IMAGE_WIDTH_PX = 7680
JPEG_QUALITY = 72


# UserSessionExecutor is `OwletteService.execute_in_user_session` —
# typed via Callable so unit tests can pass a plain dict-returning
# function without depending on the OwletteService class. Contract:
#
#     executor(job_type='python', code=<str>, timeout=<int>, trusted=True)
#     returns dict {
#         outputDir: str,        # absolute path; mandatory
#         error:     Optional[str],   # presence means failure
#         files:     list[str],       # filenames written under outputDir
#         stdout / stderr / exitCode / durationMs: diagnostic
#     }
UserSessionExecutor = Callable[..., dict]


class ScreenshotCaptureError(RuntimeError):
    """raised when any step in the capture → upload → finalize pipeline
    fails. The message carries a short tag identifying the step so the
    command result envelope and operator logs surface where it broke."""


# ---------------------------------------------------------------------------
# user-session capture
# ---------------------------------------------------------------------------


def _build_capture_code(monitor: int) -> str:
    """
    Compose the Python source the user-session interpreter will run. The
    code grabs the screen via mss, JPEG-compresses with PIL when
    available (falling back to PNG otherwise), and writes to
    `<output_dir>/screenshot.{jpg|png}`.

    `output_dir` is the symbol session_exec.run_python injects into the
    namespace before exec — same path that's returned in the result
    envelope as `outputDir`. We pass `trusted=True` from the caller so
    the user-session interpreter gives this code full builtins +
    unrestricted imports (needed for `mss` and `PIL`).
    """
    # `monitor` is sanitized to an int by the caller before reaching the
    # template, so f-string substitution is bounded to a numeric value.
    return f"""
import io
import os
import mss
from mss.tools import to_png

with mss.mss() as sct:
    mon_idx = {monitor} if {monitor} > 0 and {monitor} < len(sct.monitors) else 0
    grabbed = sct.grab(sct.monitors[mon_idx])
    png_bytes = to_png(grabbed.rgb, grabbed.size)
    monitors_count = len(sct.monitors) - 1

out_bytes = png_bytes
out_filename = {SCREENSHOT_FILENAME_JPEG!r}
try:
    from PIL import Image
    img = Image.open(io.BytesIO(png_bytes))
    if img.width > {MAX_IMAGE_WIDTH_PX}:
        ratio = {MAX_IMAGE_WIDTH_PX} / img.width
        img = img.resize(({MAX_IMAGE_WIDTH_PX}, int(img.height * ratio)), Image.LANCZOS)
    if img.mode != 'RGB':
        img = img.convert('RGB')
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality={JPEG_QUALITY}, optimize=True)
    out_bytes = buf.getvalue()
except ImportError:
    # PIL missing in user-session interpreter — keep the PNG path
    out_filename = {SCREENSHOT_FILENAME_PNG!r}

out_path = os.path.join(output_dir, out_filename)
with open(out_path, 'wb') as f:
    f.write(out_bytes)
print(f'monitors={{monitors_count}} size={{len(out_bytes)}} filename={{out_filename}}')
"""


def capture_in_user_session(
    executor: UserSessionExecutor,
    monitor: int = 0,
) -> tuple[bytes, str, int]:
    """
    Run the screen capture inside the active user's desktop session and
    return (image_bytes, content_type, monitor_count). Cleans up the
    user-session IPC output directory before returning so successive
    captures don't accumulate disk.

    Raises ScreenshotCaptureError if the user-session execution fails,
    times out, or produces no output file.
    """
    capture_code = _build_capture_code(monitor)
    result = executor(
        'python',
        capture_code,
        timeout=CAPTURE_TIMEOUT_S,
        trusted=True,
    )
    if not isinstance(result, dict):
        raise ScreenshotCaptureError(
            f"capture: user-session executor returned non-dict {type(result).__name__}"
        )

    output_dir = result.get('outputDir')
    err = result.get('error')
    if err:
        raise ScreenshotCaptureError(
            f"capture: user-session execution failed: {err}"
        )
    if not output_dir or not isinstance(output_dir, str):
        raise ScreenshotCaptureError(
            "capture: executor result missing 'outputDir'"
        )

    files = result.get('files') or []
    if SCREENSHOT_FILENAME_JPEG in files:
        chosen = SCREENSHOT_FILENAME_JPEG
        content_type = 'image/jpeg'
    elif SCREENSHOT_FILENAME_PNG in files:
        chosen = SCREENSHOT_FILENAME_PNG
        content_type = 'image/png'
    else:
        stderr = result.get('stderr') or ''
        raise ScreenshotCaptureError(
            f"capture: no screenshot file in user-session output (files={files!r}); "
            f"stderr: {stderr[:200]}"
        )

    image_path = os.path.join(output_dir, chosen)
    try:
        with open(image_path, 'rb') as f:
            image_bytes = f.read()
    except OSError as e:
        raise ScreenshotCaptureError(
            f"capture: failed to read user-session output {image_path}: {e}"
        ) from e

    # Best-effort cleanup of the result dir — orphans are harmless but
    # accumulate over thousands of captures.
    try:
        shutil.rmtree(output_dir, ignore_errors=True)
    except Exception:  # pragma: no cover — defensive only
        pass

    monitors_count = _parse_monitor_count(result.get('stdout') or '')
    return image_bytes, content_type, monitors_count


def _parse_monitor_count(stdout: str) -> int:
    """Pull `monitors=N` from the user-session stdout. Best-effort —
    returns 1 if the marker is missing or malformed (the actual capture
    succeeded either way, so we don't fail the command on this)."""
    for line in stdout.splitlines():
        for token in line.split():
            if token.startswith('monitors='):
                try:
                    return int(token.split('=', 1)[1])
                except (ValueError, IndexError):
                    continue
    return 1


# ---------------------------------------------------------------------------
# signed-URL upload
# ---------------------------------------------------------------------------


def request_upload_url(
    api_base: str,
    site_id: str,
    machine_id: str,
    bearer_token: str,
    content_type: str = DEFAULT_CONTENT_TYPE,
) -> dict:
    """
    POST /api/sites/{site}/machines/{machine}/screenshots/upload-url and
    return the parsed `{uploadUrl, storagePath, contentType, expiresAt}`
    envelope. Raises ScreenshotCaptureError on non-2xx responses or
    malformed bodies.
    """
    url = api_base.rstrip('/') + UPLOAD_URL_PATH_TMPL.format(
        site_id=site_id, machine_id=machine_id
    )
    headers = {
        'Authorization': f'Bearer {bearer_token}',
        'Content-Type': 'application/json',
    }
    body = {'contentType': content_type}

    try:
        resp = requests.post(url, json=body, headers=headers, timeout=15)
    except requests.RequestException as e:
        raise ScreenshotCaptureError(f"upload-url: network error: {e}") from e

    if resp.status_code >= 400:
        raise ScreenshotCaptureError(
            f"upload-url: request failed: {resp.status_code} {resp.text[:200]}"
        )

    try:
        payload = resp.json()
    except ValueError as e:
        raise ScreenshotCaptureError(
            f"upload-url: response is not json: {resp.text[:200]}"
        ) from e

    data = payload.get('data') if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise ScreenshotCaptureError(
            f"upload-url: response missing data envelope: {payload!r}"
        )
    if 'uploadUrl' not in data or 'storagePath' not in data:
        raise ScreenshotCaptureError(
            f"upload-url: response missing required fields: {data!r}"
        )
    return data


def upload_to_signed_url(
    upload_url: str,
    image_bytes: bytes,
    content_type: str = DEFAULT_CONTENT_TYPE,
    max_attempts: int = MAX_UPLOAD_ATTEMPTS,
    backoff_s: float = INITIAL_BACKOFF_S,
    sleep_fn: Any = time.sleep,
) -> None:
    """
    PUT bytes to the signed URL. Retries 5xx + network errors with
    exponential backoff; 4xx fails fast (signed-URL 4xx = bad signature
    or expired url, neither of which recover on retry).
    """
    last_exc: Optional[Exception] = None
    for attempt in range(1, max_attempts + 1):
        try:
            resp = requests.put(
                upload_url,
                data=image_bytes,
                headers={'Content-Type': content_type},
                timeout=UPLOAD_TIMEOUT_S,
            )
            if 200 <= resp.status_code < 300:
                return
            if 400 <= resp.status_code < 500:
                raise ScreenshotCaptureError(
                    f"upload: signed-url rejected: {resp.status_code} {resp.text[:200]}"
                )
            last_exc = ScreenshotCaptureError(
                f"upload: signed-url 5xx: {resp.status_code} {resp.text[:200]}"
            )
        except requests.RequestException as e:
            last_exc = e

        if attempt < max_attempts:
            sleep_fn(backoff_s * (2 ** (attempt - 1)))

    raise ScreenshotCaptureError(
        f"upload: failed after {max_attempts} attempts: {last_exc}"
    )


# ---------------------------------------------------------------------------
# finalize (writes lastScreenshot + history server-side)
# ---------------------------------------------------------------------------


def finalize_screenshot(
    api_base: str,
    site_id: str,
    machine_id: str,
    bearer_token: str,
    storage_path: str,
    size_kb: int,
    monitor: int,
    content_type: str = DEFAULT_CONTENT_TYPE,
) -> dict:
    """
    POST /api/sites/{site}/machines/{machine}/screenshots/finalize. Web
    flips the object to public-read, writes `machine.lastScreenshot`,
    appends a history doc, and returns the canonical public URL. Raises
    ScreenshotCaptureError on non-2xx.
    """
    url = api_base.rstrip('/') + FINALIZE_PATH_TMPL.format(
        site_id=site_id, machine_id=machine_id
    )
    headers = {
        'Authorization': f'Bearer {bearer_token}',
        'Content-Type': 'application/json',
    }
    body = {
        'storagePath': storage_path,
        'sizeKB': int(size_kb),
        'monitor': int(monitor),
        'contentType': content_type,
    }

    try:
        resp = requests.post(url, json=body, headers=headers, timeout=FINALIZE_TIMEOUT_S)
    except requests.RequestException as e:
        raise ScreenshotCaptureError(f"finalize: network error: {e}") from e

    if resp.status_code >= 400:
        raise ScreenshotCaptureError(
            f"finalize: request failed: {resp.status_code} {resp.text[:200]}"
        )

    try:
        payload = resp.json()
    except ValueError as e:
        raise ScreenshotCaptureError(
            f"finalize: response is not json: {resp.text[:200]}"
        ) from e

    data = payload.get('data') if isinstance(payload, dict) else None
    if not isinstance(data, dict) or 'url' not in data:
        raise ScreenshotCaptureError(
            f"finalize: response missing data.url: {payload!r}"
        )
    return data


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------


def capture_and_upload(
    user_session_executor: UserSessionExecutor,
    api_base: str,
    site_id: str,
    machine_id: str,
    bearer_token: str,
    monitor: Any = 0,
) -> dict:
    """
    Full pipeline: capture (user session) → request signed url → PUT →
    finalize. Returns a result envelope suitable for the command's
    `result` field.

    On success:
        {
          'storage_path': str,    # canonical GCS path of the captured frame
          'url':          str,    # public read URL (also written to
                                  # machine.lastScreenshot by finalize)
          'size_kb':      int,
          'monitor':      int,    # echoed input selector
          'monitor_count':int,    # how many physical displays were enumerated
        }

    Any failure raises ScreenshotCaptureError with a short tag in the
    message indicating which step failed
    (capture / upload-url / upload / finalize).
    """
    monitor_int = int(monitor) if isinstance(monitor, (int, float, bool)) else 0
    # bool is a subclass of int — treat True/False as 0 to avoid surprises
    if isinstance(monitor, bool):
        monitor_int = 0

    # 1. capture in user session
    image_bytes, content_type, monitor_count = capture_in_user_session(
        user_session_executor, monitor_int
    )
    size_kb = max(1, round(len(image_bytes) / 1024))

    # 2. request signed PUT url, pinning content-type to what was captured
    issued = request_upload_url(
        api_base=api_base,
        site_id=site_id,
        machine_id=machine_id,
        bearer_token=bearer_token,
        content_type=content_type,
    )

    # 3. PUT bytes directly to GCS
    upload_to_signed_url(
        upload_url=issued['uploadUrl'],
        image_bytes=image_bytes,
        content_type=content_type,
    )

    # 4. finalize — web writes lastScreenshot + history + returns public URL
    finalized = finalize_screenshot(
        api_base=api_base,
        site_id=site_id,
        machine_id=machine_id,
        bearer_token=bearer_token,
        storage_path=issued['storagePath'],
        size_kb=size_kb,
        monitor=monitor_int,
        content_type=content_type,
    )

    return {
        'storage_path': issued['storagePath'],
        'url': finalized['url'],
        'size_kb': size_kb,
        'monitor': monitor_int,
        'monitor_count': monitor_count,
    }
