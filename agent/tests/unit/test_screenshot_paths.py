"""Characterization tests for the THREE user-session screenshot pipelines in
owlette_service.py.

The same shape of code is copy-pasted three times:

  * ``OwletteService._handle_capture_screenshot``  (on-demand / Cortex tool)
  * ``OwletteService._capture_crash_screenshot``   (best-effort, on crash)
  * ``OwletteService._live_view_loop``             (periodic live view)

Each one builds a python snippet, hands it to ``execute_in_user_session``,
then *ignores* the ``outputDir`` the executor returns and instead re-derives
the file by scanning ``<ProgramData>/Owlette/ipc/results/`` in REVERSE
lexicographic order for the first directory containing ``screenshot.jpg``.
(The ``execute_in_user_session`` docstring explicitly says ``outputDir``
exists so callers do not have to race on that enumeration -- none of the
three callers use it. That is current behaviour, and it is pinned here.)

These tests exist so a refactor that collapses the three copies into one
helper cannot silently change any of it. They deliberately pin the places
where the three DIVERGE -- capture-code parameters, executor timeout,
which failures log and at what level, which return None vs an error dict,
and which one writes a firebase audit event.

Mocking follows the house style: the real unbound method is bound onto a
``SimpleNamespace`` via the descriptor protocol
(``OwletteService.<method>.__get__(fake, OwletteService)``) so the production
body runs without constructing the Windows service, and owlette_service is
imported lazily inside helpers (matching test_cortex_process_command.py) so
module collection does not eagerly initialize the cryptography rust bindings.
"""

from __future__ import annotations

import base64
import logging
import os

from types import SimpleNamespace
from unittest.mock import MagicMock


# The em dash the source uses in user-facing / log strings. Spelled as an
# escape so this test file stays pure ASCII.
EMDASH = u'\u2014'

# 3072 bytes -> 3.0 KB exactly, so both the float formatting used by
# _handle_capture_screenshot ("{:.0f}") and the integer division used by
# _capture_crash_screenshot ("// 1024") produce "3" with no rounding ambiguity.
PAYLOAD = b'\xff\xd8\xff' + b'\x00' * (3072 - 3)
PAYLOAD_B64 = base64.b64encode(PAYLOAD).decode('ascii')

# 3789 bytes -> 3.7002 KB. Used to tell the two size arithmetics apart:
# _handle_capture_screenshot divides (3.7 -> "4KB"), _capture_crash_screenshot
# floor-divides (3 -> "3KB").
ODD_PAYLOAD = b'\xff\xd8\xff' + b'\x00' * (3789 - 3)

# The crash snippet, pinned byte for byte, as it shipped before the three
# copies were merged. It is the shortest of the three, and the other two are
# derived from it below. Substring assertions cannot see a whitespace or
# indentation slip, and nothing in this repo ever executes the snippet -- it
# runs in the user's desktop session -- so an IndentationError introduced by
# a template edit would reach production silently.
CRASH_SNIPPET = """
import mss
import io
import os
from mss.tools import to_png

with mss.mss() as sct:
    screenshot = sct.grab(sct.monitors[0])
    png_bytes = to_png(screenshot.rgb, screenshot.size)

try:
    from PIL import Image
    img = Image.open(io.BytesIO(png_bytes))
    max_width = 1920
    if img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
    buffer = io.BytesIO()
    img.save(buffer, format='JPEG', quality=60)
    jpeg_bytes = buffer.getvalue()
except ImportError:
    jpeg_bytes = png_bytes

out_path = os.path.join(output_dir, 'screenshot.jpg')
with open(out_path, 'wb') as f:
    f.write(jpeg_bytes)
"""



# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _ipc_tree(monkeypatch, tmp_path, dirs=(), make_results=True):
    """Build <tmp>/ipc/results/<name>/screenshot.jpg for each (name, bytes)
    in `dirs` and point shared_utils.get_data_path at it.

    `dirs` entries are (dirname, payload_or_None); None creates the directory
    without a screenshot.jpg (a result dir from some other job).

    Returns the absolute results/ path.
    """
    import owlette_service

    ipc_dir = tmp_path / 'ipc'
    results_base = ipc_dir / 'results'
    if make_results:
        results_base.mkdir(parents=True)
    else:
        ipc_dir.mkdir(parents=True)

    for name, payload in dirs:
        d = results_base / name
        d.mkdir()
        if payload is not None:
            (d / 'screenshot.jpg').write_bytes(payload)

    def _fake_get_data_path(filename=None):
        if filename is None:
            return str(tmp_path)
        return str(tmp_path / filename)

    monkeypatch.setattr(
        owlette_service.shared_utils, 'get_data_path', _fake_get_data_path
    )
    return str(results_base)


_UNSET = object()


def _make_service(exec_result=None, exec_side_effect=None, upload_result=None,
                  firebase_client=_UNSET):
    """A minimal double carrying only the attributes the three methods read."""
    from owlette_service import OwletteService

    executor = MagicMock(return_value=exec_result)
    if exec_side_effect is not None:
        executor.side_effect = exec_side_effect

    svc = SimpleNamespace(
        execute_in_user_session=executor,
        _upload_screenshot=MagicMock(return_value=upload_result),
        firebase_client=MagicMock() if firebase_client is _UNSET else firebase_client,
        _live_view_active=True,
        _live_view_stop_time=0.0,
    )
    for name in ('_handle_capture_screenshot', '_capture_crash_screenshot',
                 '_live_view_loop'):
        setattr(svc, name, getattr(OwletteService, name).__get__(svc, OwletteService))
    return svc


def _ok_result(files=('screenshot.jpg',), **extra):
    """The success-shaped dict execute_in_user_session returns."""
    out = {
        'stdout': '',
        'stderr': '',
        'exitCode': 0,
        'error': None,
        'durationMs': 12,
        'files': list(files),
    }
    out.update(extra)
    return out


def _capture_code(svc):
    """The python snippet the site handed to execute_in_user_session."""
    return svc.execute_in_user_session.call_args.args[1]


def _log_levels(caplog, needle):
    """Level names of every captured record whose message contains `needle`.

    Asserting on this rather than on caplog.text pins the LEVEL too -- these
    three sites deliberately use different levels for the same class of
    failure, and caplog.text alone would not notice a level change.
    """
    return sorted({r.levelname for r in caplog.records if needle in r.getMessage()})


# ---------------------------------------------------------------------------
# site 1: _handle_capture_screenshot
# ---------------------------------------------------------------------------


class TestHandleCaptureScreenshot:

    def test_launch_primitive_arguments(self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/x.jpg'})

        svc._handle_capture_screenshot({'monitor': 0})

        assert svc.execute_in_user_session.call_count == 1
        args = svc.execute_in_user_session.call_args.args
        kwargs = svc.execute_in_user_session.call_args.kwargs
        assert args[0] == 'python'
        assert kwargs == {'timeout': 20, 'trusted': True}

    def test_capture_code_parameters(self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/x.jpg'})

        svc._handle_capture_screenshot({'monitor': 2})

        code = _capture_code(svc)
        # Only this site is monitor-aware, and the index is interpolated in.
        assert 'mon_idx = 2 if 2 > 0 and 2 < len(sct.monitors) else 0' in code
        assert 'sct.grab(sct.monitors[mon_idx])' in code
        assert 'max_width = 7680' in code
        assert "quality=72" in code
        # Only this site echoes diagnostics back on stdout.
        assert "print(f'size_kb=" in code
        assert "print(f'monitors=" in code
        assert "os.path.join(output_dir, 'screenshot.jpg')" in code

    def test_default_monitor_is_zero(self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/x.jpg'})

        out = svc._handle_capture_screenshot({})

        assert 'mon_idx = 0 if 0 > 0 and 0 < len(sct.monitors) else 0' in _capture_code(svc)
        assert out['monitor'] == 0

    def test_success_return_shape(self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/x.jpg'})

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert out == {
            'message': ('Screenshot captured (all monitors, 3KB)'
                        + ' ' + EMDASH + ' URL: https://cdn/x.jpg'),
            'url': 'https://cdn/x.jpg',
            'base64': PAYLOAD_B64,
            'size_kb': 3.0,
            'monitor': 0,
        }
        svc._upload_screenshot.assert_called_once_with(PAYLOAD_B64)

    def test_size_kb_is_true_division_not_floor(self, monkeypatch, tmp_path, caplog):
        """size_kb is bytes / 1024 (a float, rounded to 1dp in the payload and
        formatted "{:.0f}" everywhere else) -- NOT the floor division the crash
        site uses."""
        _ipc_tree(monkeypatch, tmp_path, [('run-a', ODD_PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/x.jpg'})

        with caplog.at_level(logging.DEBUG):
            out = svc._handle_capture_screenshot({'monitor': 0})

        assert out['size_kb'] == 3.7
        assert out['message'].startswith('Screenshot captured (all monitors, 4KB)')
        assert _log_levels(caplog, 'Screenshot captured: 4KB') == ['INFO']
        svc.firebase_client.log_event.assert_called_once_with(
            action='command_executed',
            level='info',
            details='Screenshot captured (4KB)',
        )

    def test_monitor_label_for_specific_monitor(self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/x.jpg'})

        out = svc._handle_capture_screenshot({'monitor': 2})

        assert out['message'].startswith('Screenshot captured (monitor 2, 3KB)')
        assert out['monitor'] == 2

    def test_writes_firebase_audit_event(self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/x.jpg'})

        svc._handle_capture_screenshot({'monitor': 0})

        svc.firebase_client.log_event.assert_called_once_with(
            action='command_executed',
            level='info',
            details='Screenshot captured (3KB)',
        )

    def test_logs_size_at_info(self, monkeypatch, tmp_path, caplog):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/x.jpg'})

        with caplog.at_level(logging.DEBUG):
            svc._handle_capture_screenshot({'monitor': 0})

        assert _log_levels(caplog, 'Screenshot captured: 3KB') == ['INFO']

    def test_upload_returning_none_yields_empty_url_and_bare_message(
            self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(), upload_result=None)

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert out['url'] == ''
        assert out['message'] == 'Screenshot captured (all monitors, 3KB)'
        assert EMDASH not in out['message']
        # The audit event is still written even though the upload failed.
        assert svc.firebase_client.log_event.call_count == 1

    def test_upload_result_without_url_key_yields_empty_url(
            self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(), upload_result={})

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert out['url'] == ''
        assert out['message'] == 'Screenshot captured (all monitors, 3KB)'

    def test_executor_error_returns_error_dict(self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(
            exec_result=_ok_result(error='no interactive session available'))

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert out == {'error': 'Screenshot failed: no interactive session available'}
        svc._upload_screenshot.assert_not_called()
        svc.firebase_client.log_event.assert_not_called()

    def test_missing_file_with_stderr_returns_error_dict(self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(
            exec_result=_ok_result(files=[], stderr='ModuleNotFoundError: mss'))

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert out == {
            'error': 'Screenshot capture failed: ModuleNotFoundError: mss'
        }
        svc._upload_screenshot.assert_not_called()

    def test_missing_file_without_stderr_returns_bare_error(self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(files=[], stderr=''))

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert out == {'error': 'Screenshot capture failed'}

    def test_file_absent_on_disk_returns_not_found_error(self, monkeypatch, tmp_path):
        # Executor claims success, but no result dir holds a screenshot.jpg.
        _ipc_tree(monkeypatch, tmp_path, [('run-a', None)])
        svc = _make_service(exec_result=_ok_result())

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert out == {'error': 'Screenshot file not found after capture'}
        svc._upload_screenshot.assert_not_called()

    def test_selection_is_reverse_lexicographic_and_ignores_outputdir(
            self, monkeypatch, tmp_path):
        """The file is chosen by scanning results/ in reverse name order --
        NOT by the executor's own outputDir. Directories without a
        screenshot.jpg are skipped."""
        older = b'\xff\xd8\xffOLDER' + b'\x00' * 1000
        newer = b'\xff\xd8\xffNEWER' + b'\x00' * 2000
        results_base = _ipc_tree(monkeypatch, tmp_path, [
            ('aaa-oldest', older),
            ('mmm-newest', newer),
            ('zzz-other-job', None),   # highest name, but no screenshot.jpg
        ])
        svc = _make_service(
            exec_result=_ok_result(
                outputDir=os.path.join(results_base, 'aaa-oldest')),
            upload_result={'url': 'https://cdn/x.jpg'},
        )

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert base64.b64decode(out['base64']) == newer
        # Only the selected dir is removed; the others survive.
        assert not os.path.exists(os.path.join(results_base, 'mmm-newest'))
        assert os.path.exists(os.path.join(results_base, 'aaa-oldest'))
        assert os.path.exists(os.path.join(results_base, 'zzz-other-job'))

    def test_unexpected_exception_is_swallowed_into_error_dict(
            self, monkeypatch, tmp_path):
        # No results/ directory at all -> os.listdir raises inside the try.
        _ipc_tree(monkeypatch, tmp_path, make_results=False)
        svc = _make_service(exec_result=_ok_result())

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert list(out.keys()) == ['error']
        assert out['error'].startswith('Screenshot failed: ')
        svc._upload_screenshot.assert_not_called()

    def test_firebase_log_failure_turns_a_successful_capture_into_an_error(
            self, monkeypatch, tmp_path):
        """Unlike the other two sites, this one touches firebase_client with no
        guard, so a firebase problem discards an otherwise-successful capture
        (the upload has already happened by then)."""
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/x.jpg'},
                            firebase_client=None)

        out = svc._handle_capture_screenshot({'monitor': 0})

        assert list(out.keys()) == ['error']
        assert out['error'].startswith('Screenshot failed: ')
        svc._upload_screenshot.assert_called_once_with(PAYLOAD_B64)


# ---------------------------------------------------------------------------
# site 2: _capture_crash_screenshot
# ---------------------------------------------------------------------------


class TestCaptureCrashScreenshot:

    def test_launch_primitive_arguments(self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/crash.jpg'})

        svc._capture_crash_screenshot()

        assert svc.execute_in_user_session.call_count == 1
        args = svc.execute_in_user_session.call_args.args
        kwargs = svc.execute_in_user_session.call_args.kwargs
        assert args[0] == 'python'
        assert kwargs == {'timeout': 8, 'trusted': True}

    def test_capture_code_parameters(self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/crash.jpg'})

        svc._capture_crash_screenshot()

        code = _capture_code(svc)
        # Not monitor-aware -- always the virtual "all monitors" grab.
        assert 'sct.grab(sct.monitors[0])' in code
        assert 'mon_idx' not in code
        assert 'max_width = 1920' in code
        assert "quality=60" in code
        assert 'print(' not in code

    def test_returns_url_and_logs_size_on_success(self, monkeypatch, tmp_path, caplog):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/crash.jpg'})

        with caplog.at_level(logging.DEBUG):
            out = svc._capture_crash_screenshot()

        assert out == 'https://cdn/crash.jpg'
        assert _log_levels(caplog, 'Crash screenshot captured: 3KB') == ['INFO']
        svc._upload_screenshot.assert_called_once_with(PAYLOAD_B64)

    def test_size_log_uses_floor_division(self, monkeypatch, tmp_path, caplog):
        """This site floor-divides (len // 1024) where the on-demand site
        divides -- the same 3789-byte capture logs "3KB" here and "4KB" there."""
        _ipc_tree(monkeypatch, tmp_path, [('run-a', ODD_PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/crash.jpg'})

        with caplog.at_level(logging.DEBUG):
            svc._capture_crash_screenshot()

        assert _log_levels(caplog, 'Crash screenshot captured: 3KB') == ['INFO']

    def test_writes_no_firebase_audit_event(self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/crash.jpg'})

        svc._capture_crash_screenshot()

        svc.firebase_client.log_event.assert_not_called()

    def test_executor_error_returns_none_and_logs_debug(
            self, monkeypatch, tmp_path, caplog):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(
            exec_result=_ok_result(error='no interactive session available'))

        with caplog.at_level(logging.DEBUG):
            out = svc._capture_crash_screenshot()

        assert out is None
        msg = ('Crash screenshot capture failed ' + EMDASH
               + ' proceeding with relaunch')
        assert msg in caplog.text
        assert _log_levels(caplog, msg) == ['DEBUG']
        svc._upload_screenshot.assert_not_called()

    def test_missing_file_in_files_returns_none_and_logs_debug(
            self, monkeypatch, tmp_path, caplog):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(files=[]))

        with caplog.at_level(logging.DEBUG):
            out = svc._capture_crash_screenshot()

        assert out is None
        assert _log_levels(
            caplog, 'Crash screenshot capture failed ' + EMDASH) == ['DEBUG']

    def test_file_absent_on_disk_returns_none_silently(
            self, monkeypatch, tmp_path, caplog):
        """Distinct from the executor-failure path: this one logs NOTHING."""
        _ipc_tree(monkeypatch, tmp_path, [('run-a', None)])
        svc = _make_service(exec_result=_ok_result())

        with caplog.at_level(logging.DEBUG):
            out = svc._capture_crash_screenshot()

        assert out is None
        assert 'Crash screenshot' not in caplog.text
        svc._upload_screenshot.assert_not_called()

    def test_upload_returning_none_yields_none(self, monkeypatch, tmp_path, caplog):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(), upload_result=None)

        with caplog.at_level(logging.DEBUG):
            out = svc._capture_crash_screenshot()

        assert out is None
        # The success log is gated on a non-empty url.
        assert 'Crash screenshot captured' not in caplog.text
        svc._upload_screenshot.assert_called_once_with(PAYLOAD_B64)

    def test_upload_with_empty_url_yields_none(self, monkeypatch, tmp_path):
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(), upload_result={'url': ''})

        assert svc._capture_crash_screenshot() is None

    def test_selection_is_reverse_lexicographic_and_ignores_outputdir(
            self, monkeypatch, tmp_path):
        older = b'\xff\xd8\xffOLDER' + b'\x00' * 1000
        newer = b'\xff\xd8\xffNEWER' + b'\x00' * 2000
        results_base = _ipc_tree(monkeypatch, tmp_path, [
            ('aaa-oldest', older),
            ('mmm-newest', newer),
            ('zzz-other-job', None),
        ])
        svc = _make_service(
            exec_result=_ok_result(
                outputDir=os.path.join(results_base, 'aaa-oldest')),
            upload_result={'url': 'https://cdn/crash.jpg'},
        )

        svc._capture_crash_screenshot()

        uploaded = base64.b64decode(svc._upload_screenshot.call_args.args[0])
        assert uploaded == newer
        assert not os.path.exists(os.path.join(results_base, 'mmm-newest'))
        assert os.path.exists(os.path.join(results_base, 'aaa-oldest'))
        assert os.path.exists(os.path.join(results_base, 'zzz-other-job'))

    def test_unexpected_exception_returns_none_and_logs_debug(
            self, monkeypatch, tmp_path, caplog):
        _ipc_tree(monkeypatch, tmp_path, make_results=False)
        svc = _make_service(exec_result=_ok_result())

        with caplog.at_level(logging.DEBUG):
            out = svc._capture_crash_screenshot()

        assert out is None
        assert _log_levels(caplog, 'Crash screenshot failed: ') == ['DEBUG']


# ---------------------------------------------------------------------------
# site 3: _live_view_loop
# ---------------------------------------------------------------------------


def _one_shot(svc, result=None, raises=None):
    """Executor side effect that ends the loop after a single iteration.

    Clearing _live_view_active makes both the sleep loop and the outer while
    fall through immediately, so the test never waits on real time.
    """
    def _side_effect(*_a, **_kw):
        svc._live_view_active = False
        if raises is not None:
            raise raises
        return result
    return _side_effect


def _live_service(monkeypatch, tmp_path, dirs=(), make_results=True,
                  exec_result=None, upload_result=None, raises=None):
    import time as _time
    results_base = _ipc_tree(monkeypatch, tmp_path, dirs, make_results=make_results)
    svc = _make_service(upload_result=upload_result)
    svc._live_view_stop_time = _time.time() + 3600
    svc.execute_in_user_session.side_effect = _one_shot(
        svc, result=exec_result, raises=raises)
    return svc, results_base


class TestLiveViewLoop:

    def test_launch_primitive_arguments(self, monkeypatch, tmp_path):
        svc, _ = _live_service(monkeypatch, tmp_path, [('run-a', PAYLOAD)],
                               exec_result=_ok_result())

        svc._live_view_loop(10)

        assert svc.execute_in_user_session.call_count == 1
        args = svc.execute_in_user_session.call_args.args
        kwargs = svc.execute_in_user_session.call_args.kwargs
        assert args[0] == 'python'
        assert kwargs == {'timeout': 10, 'trusted': True}

    def test_capture_code_parameters(self, monkeypatch, tmp_path):
        svc, _ = _live_service(monkeypatch, tmp_path, [('run-a', PAYLOAD)],
                               exec_result=_ok_result())

        svc._live_view_loop(10)

        code = _capture_code(svc)
        assert 'sct.grab(sct.monitors[0])' in code
        assert 'mon_idx' not in code
        assert 'max_width = 1920' in code
        # The only site that drops to quality 50.
        assert "quality=50" in code
        assert 'print(' not in code

    def test_uploads_and_returns_none(self, monkeypatch, tmp_path):
        svc, _ = _live_service(monkeypatch, tmp_path, [('run-a', PAYLOAD)],
                               exec_result=_ok_result(),
                               upload_result={'url': 'https://cdn/live.jpg'})

        out = svc._live_view_loop(10)

        assert out is None
        svc._upload_screenshot.assert_called_once_with(PAYLOAD_B64)
        # The upload result is discarded -- no url is surfaced anywhere.
        svc.firebase_client.log_event.assert_not_called()

    def test_start_and_end_logs(self, monkeypatch, tmp_path, caplog):
        svc, _ = _live_service(monkeypatch, tmp_path, [('run-a', PAYLOAD)],
                               exec_result=_ok_result())

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(7)

        assert _log_levels(caplog, 'Live view loop started (interval=7s)') == ['INFO']
        assert _log_levels(caplog, 'Live view loop ended') == ['INFO']
        # No per-capture size log on this path.
        assert 'Screenshot captured' not in caplog.text

    def test_finally_clears_flag_and_publishes_inactive(self, monkeypatch, tmp_path):
        svc, _ = _live_service(monkeypatch, tmp_path, [('run-a', PAYLOAD)],
                               exec_result=_ok_result())
        svc.firebase_client.is_connected.return_value = True

        svc._live_view_loop(10)

        assert svc._live_view_active is False
        svc.firebase_client.set_machine_flag.assert_called_once_with(
            'liveView', {'active': False})

    def test_finally_skips_flag_when_disconnected(self, monkeypatch, tmp_path, caplog):
        svc, _ = _live_service(monkeypatch, tmp_path, [('run-a', PAYLOAD)],
                               exec_result=_ok_result())
        svc.firebase_client.is_connected.return_value = False

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)

        svc.firebase_client.set_machine_flag.assert_not_called()
        assert 'Live view loop ended' in caplog.text

    def test_executor_error_logs_debug_and_skips_upload(
            self, monkeypatch, tmp_path, caplog):
        svc, _ = _live_service(
            monkeypatch, tmp_path, [('run-a', PAYLOAD)],
            exec_result=_ok_result(error='no interactive session available'))

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)

        assert _log_levels(
            caplog,
            'Live view capture failed: no interactive session available',
        ) == ['DEBUG']
        svc._upload_screenshot.assert_not_called()

    def test_missing_file_in_files_logs_placeholder_reason(
            self, monkeypatch, tmp_path, caplog):
        """With no 'error' value the log falls back to the literal
        'no screenshot file'."""
        svc, _ = _live_service(monkeypatch, tmp_path, [('run-a', PAYLOAD)],
                               exec_result=_ok_result(files=[]))

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)

        assert _log_levels(caplog, 'Live view capture failed: None') == ['DEBUG']
        svc._upload_screenshot.assert_not_called()

    def test_missing_file_and_absent_error_key_logs_no_screenshot_file(
            self, monkeypatch, tmp_path, caplog):
        svc, _ = _live_service(monkeypatch, tmp_path, [('run-a', PAYLOAD)],
                               exec_result={'files': [], 'stderr': ''})

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)

        assert _log_levels(
            caplog, 'Live view capture failed: no screenshot file') == ['DEBUG']

    def test_file_absent_on_disk_is_silent(self, monkeypatch, tmp_path, caplog):
        svc, _ = _live_service(monkeypatch, tmp_path, [('run-a', None)],
                               exec_result=_ok_result())

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)

        assert 'Live view capture failed' not in caplog.text
        assert 'Live view capture error' not in caplog.text
        svc._upload_screenshot.assert_not_called()

    def test_selection_is_reverse_lexicographic_and_ignores_outputdir(
            self, monkeypatch, tmp_path):
        older = b'\xff\xd8\xffOLDER' + b'\x00' * 1000
        newer = b'\xff\xd8\xffNEWER' + b'\x00' * 2000
        svc, results_base = _live_service(monkeypatch, tmp_path, [
            ('aaa-oldest', older),
            ('mmm-newest', newer),
            ('zzz-other-job', None),
        ])
        svc.execute_in_user_session.side_effect = _one_shot(
            svc,
            result=_ok_result(
                outputDir=os.path.join(str(tmp_path), 'ipc', 'results', 'aaa-oldest')),
        )

        svc._live_view_loop(10)

        uploaded = base64.b64decode(svc._upload_screenshot.call_args.args[0])
        assert uploaded == newer
        assert not os.path.exists(os.path.join(results_base, 'mmm-newest'))
        assert os.path.exists(os.path.join(results_base, 'aaa-oldest'))
        assert os.path.exists(os.path.join(results_base, 'zzz-other-job'))

    def test_inner_exception_logs_warning_and_keeps_loop_alive(
            self, monkeypatch, tmp_path, caplog):
        # No results/ dir -> os.listdir raises inside the per-iteration try.
        svc, _ = _live_service(monkeypatch, tmp_path, make_results=False,
                               exec_result=_ok_result())

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)

        assert _log_levels(caplog, 'Live view capture error: ') == ['WARNING']
        # The iteration failure does not crash the loop -- it ends normally.
        assert 'Live view loop crashed' not in caplog.text
        assert 'Live view loop ended' in caplog.text

    def test_executor_exception_logs_warning(self, monkeypatch, tmp_path, caplog):
        svc, _ = _live_service(monkeypatch, tmp_path, [('run-a', PAYLOAD)],
                               raises=RuntimeError('session gone'))

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)

        assert _log_levels(
            caplog, 'Live view capture error: session gone') == ['WARNING']
        svc._upload_screenshot.assert_not_called()

    def test_outer_exception_logs_error_and_still_runs_finally(
            self, monkeypatch, tmp_path, caplog):
        # A non-comparable stop time makes the while condition raise before
        # the first iteration, exercising the outer handler.
        svc, _ = _live_service(monkeypatch, tmp_path, [('run-a', PAYLOAD)],
                               exec_result=_ok_result())
        svc._live_view_stop_time = object()
        svc.firebase_client.is_connected.return_value = True

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)

        assert _log_levels(caplog, 'Live view loop crashed: ') == ['ERROR']
        assert svc._live_view_active is False
        svc.firebase_client.set_machine_flag.assert_called_once_with(
            'liveView', {'active': False})
        assert 'Live view loop ended' in caplog.text
        svc.execute_in_user_session.assert_not_called()

    def test_finally_swallows_flag_publish_failure(self, monkeypatch, tmp_path, caplog):
        svc, _ = _live_service(monkeypatch, tmp_path, [('run-a', PAYLOAD)],
                               exec_result=_ok_result())
        svc.firebase_client.is_connected.return_value = True
        svc.firebase_client.set_machine_flag.side_effect = RuntimeError('offline')

        with caplog.at_level(logging.DEBUG):
            svc._live_view_loop(10)  # must not raise

        assert 'Live view loop ended' in caplog.text


# ---------------------------------------------------------------------------
# cross-site divergences -- the whole risk of collapsing these into one helper
# ---------------------------------------------------------------------------


class TestThreeSitesDiverge:
    """One test that states, in one place, exactly how the three near-duplicate
    capture snippets and their launch calls differ today. A refactor that
    unifies them must either keep these differences or change this test
    deliberately."""

    def _codes_and_kwargs(self, monkeypatch, tmp_path):
        out = {}

        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])

        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/x.jpg'})
        svc._handle_capture_screenshot({'monitor': 0})
        out['handle'] = (_capture_code(svc),
                         svc.execute_in_user_session.call_args.kwargs)

        _ipc_tree(monkeypatch, tmp_path / 'crash', [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(),
                            upload_result={'url': 'https://cdn/x.jpg'})
        svc._capture_crash_screenshot()
        out['crash'] = (_capture_code(svc),
                        svc.execute_in_user_session.call_args.kwargs)

        svc, _ = _live_service(monkeypatch, tmp_path / 'live',
                               [('run-a', PAYLOAD)], exec_result=_ok_result())
        svc._live_view_loop(10)
        out['live'] = (_capture_code(svc),
                       svc.execute_in_user_session.call_args.kwargs)
        return out

    def test_timeouts_differ(self, monkeypatch, tmp_path):
        sites = self._codes_and_kwargs(monkeypatch, tmp_path)
        assert sites['handle'][1]['timeout'] == 20
        assert sites['crash'][1]['timeout'] == 8
        assert sites['live'][1]['timeout'] == 10
        # All three run trusted.
        for name in sites:
            assert sites[name][1]['trusted'] is True

    def test_jpeg_quality_and_max_width_differ(self, monkeypatch, tmp_path):
        sites = self._codes_and_kwargs(monkeypatch, tmp_path)
        assert 'quality=72' in sites['handle'][0]
        assert 'quality=60' in sites['crash'][0]
        assert 'quality=50' in sites['live'][0]
        assert 'max_width = 7680' in sites['handle'][0]
        assert 'max_width = 1920' in sites['crash'][0]
        assert 'max_width = 1920' in sites['live'][0]

    def test_only_the_ondemand_site_is_monitor_aware(self, monkeypatch, tmp_path):
        sites = self._codes_and_kwargs(monkeypatch, tmp_path)
        assert 'mon_idx' in sites['handle'][0]
        assert 'mon_idx' not in sites['crash'][0]
        assert 'mon_idx' not in sites['live'][0]

    def test_only_the_ondemand_site_prints_diagnostics(self, monkeypatch, tmp_path):
        sites = self._codes_and_kwargs(monkeypatch, tmp_path)
        assert 'print(' in sites['handle'][0]
        assert 'print(' not in sites['crash'][0]
        assert 'print(' not in sites['live'][0]

    def test_the_crash_and_live_snippets_are_otherwise_identical(
            self, monkeypatch, tmp_path):
        """They differ ONLY in the JPEG quality literal -- the closest pair,
        and the easiest to merge incorrectly."""
        sites = self._codes_and_kwargs(monkeypatch, tmp_path)
        assert (sites['crash'][0].replace('quality=60', 'quality=Q')
                == sites['live'][0].replace('quality=50', 'quality=Q'))

    def test_return_contracts_differ(self, monkeypatch, tmp_path):
        """Same failure (executor error) -> three different observable results:
        an error dict, None, and nothing at all."""
        _ipc_tree(monkeypatch, tmp_path, [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(error='boom'))
        assert svc._handle_capture_screenshot({'monitor': 0}) == {
            'error': 'Screenshot failed: boom'}

        _ipc_tree(monkeypatch, tmp_path / 'crash', [('run-a', PAYLOAD)])
        svc = _make_service(exec_result=_ok_result(error='boom'))
        assert svc._capture_crash_screenshot() is None

        svc, _ = _live_service(monkeypatch, tmp_path / 'live',
                               [('run-a', PAYLOAD)],
                               exec_result=_ok_result(error='boom'))
        assert svc._live_view_loop(10) is None

    def test_each_snippet_is_byte_for_byte_what_it_was(self, monkeypatch, tmp_path):
        """The generated text, not just substrings of it. The crash snippet is
        the golden copy; the other two are it plus exactly the deltas the tests
        above name -- grab block, max_width, quality, trailing prints."""
        sites = self._codes_and_kwargs(monkeypatch, tmp_path)

        assert sites['crash'][0] == CRASH_SNIPPET
        assert sites['live'][0] == CRASH_SNIPPET.replace('quality=60', 'quality=50')

        expected_handle = (
            CRASH_SNIPPET
            .replace(
                '    screenshot = sct.grab(sct.monitors[0])\n',
                '    mon_idx = 0 if 0 > 0 and 0 < len(sct.monitors) else 0\n'
                '    screenshot = sct.grab(sct.monitors[mon_idx])\n',
            )
            .replace('max_width = 1920', 'max_width = 7680')
            .replace('quality=60', 'quality=72')
            + "print(f'size_kb={len(jpeg_bytes) // 1024}')\n"
              "print(f'monitors={len(sct.monitors) - 1}')\n"
        )
        assert sites['handle'][0] == expected_handle

    def test_every_snippet_is_valid_python(self, monkeypatch, tmp_path):
        """`output_dir` is injected by the executor, so compiling is as far as
        this can go -- but it is what catches a template that indents the grab
        line wrong or loses the newline before the trailing prints."""
        sites = self._codes_and_kwargs(monkeypatch, tmp_path)

        for name, (code, _kwargs) in sites.items():
            compile(code, '<%s snippet>' % name, 'exec')
