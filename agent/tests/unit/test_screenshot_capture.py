"""
Unit tests for `screenshot_capture` — the agent-side capture →
signed-URL upload → finalize pipeline.

The runtime depends on:
  * the host having `mss` available in the active user's session
    interpreter (real screen capture)
  * a callable `user_session_executor` injected by the service that
    runs Python code via CreateProcessAsUser

In test we substitute the executor with a fake that mimics the
`OwletteService.execute_in_user_session` contract, and we monkey-patch
`requests.post` / `requests.put` so no real network calls happen.
"""

from __future__ import annotations

import os
import tempfile
from unittest.mock import MagicMock, patch

import pytest


# ─── helpers ──────────────────────────────────────────────────────────


def _make_executor_result(output_dir: str, payload_bytes: bytes, filename: str = 'screenshot.jpg'):
    """Stand in for OwletteService.execute_in_user_session — writes
    `payload_bytes` into <output_dir>/<filename> and returns the dict
    contract the real executor produces (outputDir + files + stdout)."""
    os.makedirs(output_dir, exist_ok=True)
    with open(os.path.join(output_dir, filename), 'wb') as f:
        f.write(payload_bytes)
    return {
        'outputDir': output_dir,
        'files': [filename],
        'stdout': f'monitors=2 size={len(payload_bytes)} filename={filename}\n',
        'stderr': '',
        'exitCode': 0,
        'durationMs': 42,
    }


# ─── user-session capture ─────────────────────────────────────────────


def test_capture_in_user_session_reads_jpeg_from_output_dir(tmp_path):
    from screenshot_capture import capture_in_user_session

    output_dir = str(tmp_path / 'capture')
    payload = b'\xff\xd8\xff' + b'\x00' * 8192  # JPEG SOI + filler

    def fake_executor(job_type, code, **kwargs):
        assert job_type == 'python'
        assert kwargs.get('trusted') is True  # screenshot must be trusted
        assert 'import mss' in code
        return _make_executor_result(output_dir, payload, 'screenshot.jpg')

    image_bytes, content_type, monitors = capture_in_user_session(fake_executor, monitor=0)
    assert image_bytes == payload
    assert content_type == 'image/jpeg'
    assert monitors == 2
    # Output dir should be cleaned up so successive captures don't accumulate.
    assert not os.path.exists(output_dir)


def test_capture_in_user_session_falls_back_to_png(tmp_path):
    """PIL missing in the user-session interpreter → screenshot.png produced."""
    from screenshot_capture import capture_in_user_session

    output_dir = str(tmp_path / 'capture')
    payload = b'\x89PNG\r\n' + b'\x00' * 8192

    def fake_executor(*_args, **_kwargs):
        return _make_executor_result(output_dir, payload, 'screenshot.png')

    image_bytes, content_type, _monitors = capture_in_user_session(fake_executor, monitor=0)
    assert image_bytes == payload
    assert content_type == 'image/png'


def test_capture_in_user_session_surfaces_executor_error():
    from screenshot_capture import capture_in_user_session, ScreenshotCaptureError

    def fake_executor(*_a, **_kw):
        return {'error': 'no interactive session available', 'outputDir': '/tmp/x'}

    with pytest.raises(ScreenshotCaptureError, match='capture: user-session'):
        capture_in_user_session(fake_executor, monitor=0)


def test_capture_in_user_session_missing_output_dir():
    from screenshot_capture import capture_in_user_session, ScreenshotCaptureError

    def fake_executor(*_a, **_kw):
        return {'files': ['screenshot.jpg']}  # no outputDir

    with pytest.raises(ScreenshotCaptureError, match="missing 'outputDir'"):
        capture_in_user_session(fake_executor, monitor=0)


def test_capture_in_user_session_no_screenshot_file(tmp_path):
    from screenshot_capture import capture_in_user_session, ScreenshotCaptureError

    def fake_executor(*_a, **_kw):
        return {
            'outputDir': str(tmp_path),
            'files': ['other.txt'],
            'stderr': 'mss is not installed',
        }

    with pytest.raises(ScreenshotCaptureError, match='no screenshot file'):
        capture_in_user_session(fake_executor, monitor=0)


# ─── upload retry behavior ────────────────────────────────────────────


def test_upload_to_signed_url_succeeds_on_first_attempt():
    from screenshot_capture import upload_to_signed_url

    mock_resp = MagicMock(status_code=200)
    sleep_calls: list[float] = []

    with patch('screenshot_capture.requests.put', return_value=mock_resp) as mock_put:
        upload_to_signed_url(
            'https://signed.example/write',
            b'\xff\xd8\xff',
            sleep_fn=sleep_calls.append,
        )
        assert mock_put.call_count == 1
        assert sleep_calls == []


def test_upload_to_signed_url_retries_on_5xx():
    from screenshot_capture import upload_to_signed_url

    responses = [
        MagicMock(status_code=503, text='busy'),
        MagicMock(status_code=502, text='bad gateway'),
        MagicMock(status_code=200),
    ]
    sleep_calls: list[float] = []

    with patch('screenshot_capture.requests.put', side_effect=responses) as mock_put:
        upload_to_signed_url(
            'https://signed.example/write',
            b'\xff\xd8\xff',
            backoff_s=0.1,
            sleep_fn=sleep_calls.append,
        )
        assert mock_put.call_count == 3
        # Two backoff sleeps between three attempts: 0.1 * 2^0 and 0.1 * 2^1.
        assert sleep_calls == pytest.approx([0.1, 0.2])


def test_upload_to_signed_url_fails_fast_on_4xx():
    from screenshot_capture import upload_to_signed_url, ScreenshotCaptureError

    mock_resp = MagicMock(status_code=403, text='signature mismatch')
    sleep_calls: list[float] = []

    with patch('screenshot_capture.requests.put', return_value=mock_resp) as mock_put:
        with pytest.raises(ScreenshotCaptureError, match='signed-url rejected'):
            upload_to_signed_url(
                'https://signed.example/write',
                b'\xff\xd8\xff',
                sleep_fn=sleep_calls.append,
            )
        assert mock_put.call_count == 1
        assert sleep_calls == []


def test_upload_to_signed_url_exhausts_retries_then_raises():
    from screenshot_capture import upload_to_signed_url, ScreenshotCaptureError

    mock_resp = MagicMock(status_code=503, text='busy')
    sleep_calls: list[float] = []

    with patch('screenshot_capture.requests.put', return_value=mock_resp):
        with pytest.raises(ScreenshotCaptureError, match='failed after 3 attempts'):
            upload_to_signed_url(
                'https://signed.example/write',
                b'\xff\xd8\xff',
                backoff_s=0.0,
                sleep_fn=sleep_calls.append,
            )
        assert len(sleep_calls) == 2


# ─── upload-url request envelope parsing ──────────────────────────────


def test_request_upload_url_parses_envelope():
    from screenshot_capture import request_upload_url

    fake_resp = MagicMock(status_code=200)
    fake_resp.json.return_value = {
        'ok': True,
        'data': {
            'uploadUrl': 'https://signed.example/write/abc',
            'storagePath': 'screenshots/site_a/mach_x/1700000000000-aabb.jpg',
            'contentType': 'image/jpeg',
            'expiresAt': '2026-04-25T12:00:00Z',
        },
    }
    with patch('screenshot_capture.requests.post', return_value=fake_resp) as mock_post:
        out = request_upload_url(
            'https://owlette.app/api',
            'site_a',
            'mach_x',
            'fake-token',
            content_type='image/jpeg',
        )
        assert out['uploadUrl'] == 'https://signed.example/write/abc'
        assert out['storagePath'].startswith('screenshots/site_a/mach_x/')

        called_kwargs = mock_post.call_args.kwargs
        assert called_kwargs['headers']['Authorization'] == 'Bearer fake-token'
        assert called_kwargs['json'] == {'contentType': 'image/jpeg'}


def test_request_upload_url_raises_on_error_status():
    from screenshot_capture import request_upload_url, ScreenshotCaptureError

    fake_resp = MagicMock(status_code=403, text='forbidden')
    with patch('screenshot_capture.requests.post', return_value=fake_resp):
        with pytest.raises(ScreenshotCaptureError, match='request failed: 403'):
            request_upload_url(
                'https://owlette.app/api', 'site_a', 'mach_x', 'fake-token'
            )


# ─── finalize ─────────────────────────────────────────────────────────


def test_finalize_screenshot_posts_storage_path_and_size():
    from screenshot_capture import finalize_screenshot

    fake_resp = MagicMock(status_code=200)
    fake_resp.json.return_value = {
        'ok': True,
        'data': {
            'url': 'https://storage.googleapis.com/owlette-dev.firebasestorage.app/screenshots/site_a/mach_x/1700-aa.jpg?t=1700',
            'storagePath': 'screenshots/site_a/mach_x/1700-aa.jpg',
            'sizeKB': 1182,
            'monitor': 0,
        },
    }
    with patch('screenshot_capture.requests.post', return_value=fake_resp) as mock_post:
        out = finalize_screenshot(
            api_base='https://owlette.app/api',
            site_id='site_a',
            machine_id='mach_x',
            bearer_token='fake-token',
            storage_path='screenshots/site_a/mach_x/1700-aa.jpg',
            size_kb=1182,
            monitor=0,
        )
        assert out['url'].startswith('https://storage.googleapis.com/')

        called_kwargs = mock_post.call_args.kwargs
        assert called_kwargs['headers']['Authorization'] == 'Bearer fake-token'
        assert called_kwargs['json'] == {
            'storagePath': 'screenshots/site_a/mach_x/1700-aa.jpg',
            'sizeKB': 1182,
            'monitor': 0,
            'contentType': 'image/jpeg',
        }


def test_finalize_screenshot_raises_on_error_status():
    from screenshot_capture import finalize_screenshot, ScreenshotCaptureError

    fake_resp = MagicMock(status_code=500, text='internal error')
    with patch('screenshot_capture.requests.post', return_value=fake_resp):
        with pytest.raises(ScreenshotCaptureError, match='finalize: request failed: 500'):
            finalize_screenshot(
                api_base='https://owlette.app/api',
                site_id='site_a',
                machine_id='mach_x',
                bearer_token='fake-token',
                storage_path='screenshots/site_a/mach_x/x.jpg',
                size_kb=100,
                monitor=0,
            )


def test_finalize_screenshot_raises_on_missing_url():
    from screenshot_capture import finalize_screenshot, ScreenshotCaptureError

    fake_resp = MagicMock(status_code=200)
    fake_resp.json.return_value = {'ok': True, 'data': {}}  # url missing
    with patch('screenshot_capture.requests.post', return_value=fake_resp):
        with pytest.raises(ScreenshotCaptureError, match='response missing data.url'):
            finalize_screenshot(
                api_base='https://owlette.app/api',
                site_id='site_a',
                machine_id='mach_x',
                bearer_token='fake-token',
                storage_path='screenshots/site_a/mach_x/x.jpg',
                size_kb=100,
                monitor=0,
            )


# ─── full pipeline ────────────────────────────────────────────────────


def test_capture_and_upload_full_pipeline_happy_path(tmp_path):
    """capture (user-session executor) → upload-url → PUT → finalize."""
    from screenshot_capture import capture_and_upload

    output_dir = str(tmp_path / 'capture-run')
    payload = b'\xff\xd8\xff' + b'\x00' * 4096

    def fake_executor(*_a, **_kw):
        return _make_executor_result(output_dir, payload, 'screenshot.jpg')

    with patch(
        'screenshot_capture.request_upload_url',
        return_value={
            'uploadUrl': 'https://signed.example/write',
            'storagePath': 'screenshots/site_a/mach_x/1700-aabb.jpg',
            'contentType': 'image/jpeg',
            'expiresAt': '2026-04-25T12:00:00Z',
        },
    ) as mock_request_url, patch(
        'screenshot_capture.upload_to_signed_url'
    ) as mock_upload, patch(
        'screenshot_capture.finalize_screenshot',
        return_value={
            'url': 'https://storage.googleapis.com/bucket/screenshots/site_a/mach_x/1700-aabb.jpg?t=1700',
            'storagePath': 'screenshots/site_a/mach_x/1700-aabb.jpg',
            'sizeKB': 4,
            'monitor': 1,
        },
    ) as mock_finalize:
        result = capture_and_upload(
            user_session_executor=fake_executor,
            api_base='https://owlette.app/api',
            site_id='site_a',
            machine_id='mach_x',
            bearer_token='tok',
            monitor=1,
        )

    assert result['storage_path'] == 'screenshots/site_a/mach_x/1700-aabb.jpg'
    assert result['url'].startswith('https://storage.googleapis.com/')
    assert result['monitor'] == 1
    assert result['monitor_count'] == 2
    assert result['size_kb'] >= 4

    # Verify the call shapes — content type flows from capture → upload-url
    # → upload → finalize as image/jpeg (since the executor wrote a .jpg).
    assert mock_request_url.call_args.kwargs['content_type'] == 'image/jpeg'
    upload_args, upload_kwargs = mock_upload.call_args
    assert upload_kwargs['upload_url'] == 'https://signed.example/write'
    assert upload_kwargs['image_bytes'] == payload
    assert upload_kwargs['content_type'] == 'image/jpeg'
    assert mock_finalize.call_args.kwargs['storage_path'] == 'screenshots/site_a/mach_x/1700-aabb.jpg'
    assert mock_finalize.call_args.kwargs['monitor'] == 1
    assert mock_finalize.call_args.kwargs['content_type'] == 'image/jpeg'


def test_capture_and_upload_propagates_executor_error(tmp_path):
    """If the user-session capture step fails, capture_and_upload raises
    ScreenshotCaptureError before any network call is attempted."""
    from screenshot_capture import capture_and_upload, ScreenshotCaptureError

    def broken_executor(*_a, **_kw):
        return {'error': 'no interactive session', 'outputDir': str(tmp_path)}

    with patch('screenshot_capture.request_upload_url') as mock_request_url, \
         patch('screenshot_capture.upload_to_signed_url') as mock_upload, \
         patch('screenshot_capture.finalize_screenshot') as mock_finalize:
        with pytest.raises(ScreenshotCaptureError, match='no interactive session'):
            capture_and_upload(
                user_session_executor=broken_executor,
                api_base='https://owlette.app/api',
                site_id='site_a',
                machine_id='mach_x',
                bearer_token='tok',
                monitor=0,
            )
        # No network calls — capture failed before any upload step.
        mock_request_url.assert_not_called()
        mock_upload.assert_not_called()
        mock_finalize.assert_not_called()
