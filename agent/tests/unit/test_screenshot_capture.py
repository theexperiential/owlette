"""
tests for screenshot_capture — happy-path upload, retry behavior on
transient failures, and multi-monitor index resolution.

mss is heavy (and unavailable in CI without a display), so we mock the
`mss.mss` context manager and import the SUT lazily inside each test.
"""

from __future__ import annotations

import io
from unittest.mock import MagicMock, patch

import pytest


# ─── monitor index resolution ─────────────────────────────────────────


def test_resolve_monitor_index_handles_aliases_and_ints():
    """'all'/0 → 0, 'primary'/1 → 1, in-range int passes through."""
    from screenshot_capture import _resolve_monitor_index

    assert _resolve_monitor_index("all", 2) == 0
    assert _resolve_monitor_index(0, 2) == 0
    assert _resolve_monitor_index(None, 2) == 0  # default
    assert _resolve_monitor_index("primary", 2) == 1
    assert _resolve_monitor_index(1, 2) == 1
    assert _resolve_monitor_index(2, 2) == 2


def test_resolve_monitor_index_rejects_out_of_range_and_bool():
    from screenshot_capture import _resolve_monitor_index, ScreenshotCaptureError

    with pytest.raises(ScreenshotCaptureError, match="out of range"):
        _resolve_monitor_index(99, 2)
    with pytest.raises(ScreenshotCaptureError, match="out of range"):
        _resolve_monitor_index(-1, 2)
    # bool → ScreenshotCaptureError; we explicitly reject because bool
    # is a subclass of int in python and we don't want True/False to
    # silently mean monitor 1/0.
    with pytest.raises(ScreenshotCaptureError, match="bool"):
        _resolve_monitor_index(True, 2)
    with pytest.raises(ScreenshotCaptureError, match="invalid"):
        _resolve_monitor_index("bogus", 2)


# ─── signed-url upload retry behavior ─────────────────────────────────


def test_upload_to_signed_url_succeeds_on_first_attempt():
    from screenshot_capture import upload_to_signed_url

    mock_resp = MagicMock(status_code=200)
    sleep_calls: list[float] = []

    with patch("screenshot_capture.requests.put", return_value=mock_resp) as mock_put:
        upload_to_signed_url(
            "https://signed.example/write",
            b"\x89PNG\r\n",
            sleep_fn=sleep_calls.append,
        )
        assert mock_put.call_count == 1
        assert sleep_calls == []  # no retry, no backoff


def test_upload_to_signed_url_retries_on_5xx():
    """transient 5xx → retries with exponential backoff, eventually succeeds."""
    from screenshot_capture import upload_to_signed_url

    responses = [
        MagicMock(status_code=503, text="busy"),
        MagicMock(status_code=502, text="bad gateway"),
        MagicMock(status_code=200),
    ]
    sleep_calls: list[float] = []

    with patch("screenshot_capture.requests.put", side_effect=responses) as mock_put:
        upload_to_signed_url(
            "https://signed.example/write",
            b"\x89PNG\r\n",
            backoff_s=0.1,
            sleep_fn=sleep_calls.append,
        )
        assert mock_put.call_count == 3
        # Two backoff sleeps between three attempts: 0.1 * 2^0 and 0.1 * 2^1.
        assert sleep_calls == pytest.approx([0.1, 0.2])


def test_upload_to_signed_url_fails_fast_on_4xx():
    """4xx is terminal — signed-url problems don't recover on retry."""
    from screenshot_capture import upload_to_signed_url, ScreenshotCaptureError

    mock_resp = MagicMock(status_code=403, text="signature mismatch")
    sleep_calls: list[float] = []

    with patch("screenshot_capture.requests.put", return_value=mock_resp) as mock_put:
        with pytest.raises(ScreenshotCaptureError, match="signed-url upload rejected"):
            upload_to_signed_url(
                "https://signed.example/write",
                b"\x89PNG\r\n",
                sleep_fn=sleep_calls.append,
            )
        # No retry on 4xx.
        assert mock_put.call_count == 1
        assert sleep_calls == []


def test_upload_to_signed_url_exhausts_retries_then_raises():
    from screenshot_capture import upload_to_signed_url, ScreenshotCaptureError

    mock_resp = MagicMock(status_code=503, text="busy")
    sleep_calls: list[float] = []

    with patch("screenshot_capture.requests.put", return_value=mock_resp):
        with pytest.raises(ScreenshotCaptureError, match="upload failed after 3 attempts"):
            upload_to_signed_url(
                "https://signed.example/write",
                b"\x89PNG\r\n",
                backoff_s=0.0,
                sleep_fn=sleep_calls.append,
            )
        assert len(sleep_calls) == 2  # 2 backoffs between 3 attempts


# ─── upload-url request envelope parsing ──────────────────────────────


def test_request_upload_url_parses_envelope():
    from screenshot_capture import request_upload_url

    fake_resp = MagicMock(status_code=200)
    fake_resp.json.return_value = {
        "ok": True,
        "data": {
            "uploadUrl": "https://signed.example/write/abc",
            "storagePath": "screenshots/site_a/mach_x/1700000000000-aabb.png",
            "contentType": "image/png",
            "expiresAt": "2026-04-25T12:00:00Z",
        },
    }
    with patch("screenshot_capture.requests.post", return_value=fake_resp) as mock_post:
        out = request_upload_url(
            "https://owlette.app/api",
            "site_a",
            "mach_x",
            "fake-token",
        )
        assert out["uploadUrl"] == "https://signed.example/write/abc"
        assert out["storagePath"].startswith("screenshots/site_a/mach_x/")

        # Verify auth header + json body shape passed through.
        called_kwargs = mock_post.call_args.kwargs
        assert called_kwargs["headers"]["Authorization"] == "Bearer fake-token"
        assert called_kwargs["json"] == {"contentType": "image/png"}


def test_request_upload_url_raises_on_error_status():
    from screenshot_capture import request_upload_url, ScreenshotCaptureError

    fake_resp = MagicMock(status_code=403, text="forbidden")
    with patch("screenshot_capture.requests.post", return_value=fake_resp):
        with pytest.raises(ScreenshotCaptureError, match="upload-url request failed: 403"):
            request_upload_url(
                "https://owlette.app/api", "site_a", "mach_x", "fake-token"
            )


# ─── full pipeline ────────────────────────────────────────────────────


def test_capture_and_upload_full_pipeline_happy_path():
    """capture_to_png_bytes → request_upload_url → upload_to_signed_url, all stubbed."""
    from screenshot_capture import capture_and_upload

    with patch(
        "screenshot_capture.capture_to_png_bytes", return_value=(b"\x89PNG" + b"\x00" * 4096, 2)
    ), patch(
        "screenshot_capture.request_upload_url",
        return_value={
            "uploadUrl": "https://signed.example/write",
            "storagePath": "screenshots/site_a/mach_x/1700000000000-aabb.png",
            "contentType": "image/png",
            "expiresAt": "2026-04-25T12:00:00Z",
        },
    ), patch("screenshot_capture.upload_to_signed_url") as mock_upload:
        result = capture_and_upload(
            api_base="https://owlette.app/api",
            site_id="site_a",
            machine_id="mach_x",
            bearer_token="tok",
            monitor=1,
        )
        assert result["screenshot_path"].startswith("screenshots/site_a/mach_x/")
        assert result["monitor"] == 1
        assert result["monitor_count"] == 2
        assert result["size_kb"] >= 4
        # Upload was called with the bytes from capture + the signed url.
        args, kwargs = mock_upload.call_args
        assert args[0] == "https://signed.example/write"
        assert args[1].startswith(b"\x89PNG")
