"""Unit tests for the display_manager helper-mode entrypoints.

Covers `_helper_apply_to_json` / `_helper_revert_from_json` — the JSON-IPC shims
the service invokes from Session 0 via CreateProcessAsUser. Run in-process with
synthetic request files and stubbed CCD calls.

Invariants under test:
  - the revert sentinel hits disk BEFORE SDC_APPLY, so a crashed apply leaves a
    recoverable trail;
  - every run writes a response file, success or failure — exit codes only
    distinguish "never launched" from "ran and reported".

Run with: cd agent && pytest tests/test_display_helper.py -v
"""

import inspect
import json
import os
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# agent/tests/ may be invoked standalone, without tests/conftest.py.
sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), '..', 'src'),
)

import display_manager as dm  # noqa: E402
from display_manager import DisplayErrorCode  # noqa: E402


SAMPLE_DESIRED_LAYOUT = {
    'monitors': [
        {'edidHash': 'aaaaaaaa', 'primary': True, 'position': {'x': 0, 'y': 0}},
        {'edidHash': 'bbbbbbbb', 'primary': False, 'position': {'x': 1920, 'y': 0}},
    ],
}

SAMPLE_SNAPSHOT = {'paths': [], 'modes': []}


@pytest.fixture
def req_path(tmp_path):
    """Path used for the request JSON file (caller writes, helper reads)."""
    return str(tmp_path / 'request.json')


@pytest.fixture
def resp_path(tmp_path):
    """Path used for the response JSON file (helper writes, caller reads)."""
    return str(tmp_path / 'response.json')


@pytest.fixture
def sentinel_path(tmp_path):
    """Path used for the revert sentinel (written by `_apply_core` before SDC_APPLY)."""
    return str(tmp_path / 'sentinel' / '.display_revert_pending')


def _write_request(path: str, payload: dict) -> None:
    """Drop a JSON request file at ``path`` for the helper to consume."""
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f)


def _read_response(path: str) -> dict:
    """Read back the JSON response the helper wrote."""
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def _stub_ccd_happy_path(monkeypatch, sdc_observer=None):
    """Install stubs so `_apply_core` runs end-to-end without touching Win32.

    `sdc_observer` is an optional callable invoked on every `_SetDisplayConfig`
    call with the flags arg — used by the sidecar-ordering test to capture
    on-disk state at the moment of SDC_APPLY.
    """
    # _apply_core only reads `path.flags` and `path.targetInfo.{adapterId,id}`,
    # so a MagicMock is enough topology.
    mock_path = MagicMock()
    mock_path.flags = dm.DISPLAYCONFIG_PATH_ACTIVE
    monkeypatch.setattr(
        dm, '_query_active_paths_safe',
        lambda: ([mock_path], []),
    )

    # _apply_core fails only when a desired hash is *missing* from the live set,
    # so one path mapped to 'aaaaaaaa' leaves 'bbbbbbbb' missing. Tests needing
    # both present must override this or use a single-monitor layout.
    monkeypatch.setattr(
        dm, '_edid_hash_for_target',
        lambda *a, **kw: 'aaaaaaaa',
    )
    monkeypatch.setattr(
        dm, '_apply_desired_to_paths',
        lambda *a, **kw: [{'monitorId': 'aaaaaaaa', 'field': 'primary'}],
    )
    # 1 pre-apply and post-apply, so ZERO_ACTIVE_PATHS never trips.
    monkeypatch.setattr(dm, '_count_active_paths', lambda paths: 1)
    monkeypatch.setattr(dm, '_snapshot_live_config', lambda: SAMPLE_SNAPSHOT)

    # _SetDisplayConfig is stubbed, so array contents are never inspected — a
    # callable factory returning a list satisfies the ctypes constructors.
    monkeypatch.setattr(
        dm, 'DISPLAYCONFIG_PATH_INFO',
        type('_FakePath', (), {'__mul__': lambda self, n: lambda: [None] * n})(),
    )
    monkeypatch.setattr(
        dm, 'DISPLAYCONFIG_MODE_INFO',
        type('_FakeMode', (), {'__mul__': lambda self, n: lambda: [None] * n})(),
    )

    # Bypass the futures executor so SDC calls are synchronously observable.
    monkeypatch.setattr(dm, '_with_timeout', lambda fn, _t: fn())

    # Succeeds for VALIDATE and APPLY; the observer sees the flags arg.
    def _fake_sdc(num_paths, paths_arr, num_modes, modes_arr, flags):
        if sdc_observer is not None:
            sdc_observer(flags)
        return dm.ERROR_SUCCESS
    monkeypatch.setattr(dm, '_SetDisplayConfig', _fake_sdc)


def _make_failing_sdc(validate_rc=None, apply_rc=None, observer=None):
    """Build an `_SetDisplayConfig` stub that returns chosen rcs per stage.

    The first call is VALIDATE, second is APPLY. Either can be forced to fail.
    """
    call_count = {'n': 0}

    def _fake_sdc(num_paths, paths_arr, num_modes, modes_arr, flags):
        if observer is not None:
            observer(flags)
        call_count['n'] += 1
        if call_count['n'] == 1:
            return validate_rc if validate_rc is not None else dm.ERROR_SUCCESS
        return apply_rc if apply_rc is not None else dm.ERROR_SUCCESS
    return _fake_sdc


class TestDisplayIpcTempdir:
    """Regression coverage for the Session 0 -> user-session IPC directory."""

    @pytest.mark.parametrize('func_name', [
        '_enumerate_monitors_via_user_session',
        'enumerate_modes_via_user_session',
        '_apply_via_user_session',
        '_revert_via_user_session',
        '_self_test_via_user_session',
    ])
    def test_helper_spawning_functions_use_ipc_tempdir(self, func_name):
        source = inspect.getsource(getattr(dm, func_name))
        assert '_ipc_tempdir()' in source
        assert 'tempfile.gettempdir' not in source

    def test_spawn_helper_stderr_uses_ipc_tempdir(self):
        source = inspect.getsource(dm._spawn_user_session_helper)
        assert '_ipc_tempdir()' in source
        assert 'tempfile.gettempdir' not in source

    def test_display_manager_has_no_tempfile_gettempdir_calls(self):
        source = Path(dm.__file__).read_text(encoding='utf-8')
        assert 'tempfile.gettempdir' not in source

    def test_service_side_helpers_build_paths_under_ipc_tempdir(
        self, monkeypatch, tmp_path,
    ):
        ipc_calls = []
        spawn_calls = []

        def _fake_ipc_tempdir():
            ipc_calls.append(True)
            return str(tmp_path)

        def _fake_spawn(helper_args, out_path, timeout):
            helper_args = list(helper_args)
            spawn_calls.append(helper_args)
            assert Path(out_path).parent == tmp_path
            command = helper_args[0]

            if command in ('--apply-json', '--revert-json'):
                assert Path(helper_args[1]).parent == tmp_path
                assert Path(helper_args[1]).exists()
                assert Path(helper_args[2]).parent == tmp_path
                assert out_path == helper_args[2]
            else:
                assert Path(helper_args[1]).parent == tmp_path
                assert out_path == helper_args[1]

            if command == '--enumerate-json':
                return {'ok': True, 'monitors': []}
            if command == '--enumerate-modes-json':
                return {
                    'ok': True,
                    'schemaVersion': dm.SCHEMA_VERSION,
                    'signatureHash': 'abc',
                    'capturedAt': 123,
                    'byEdidHash': {},
                }
            return {'ok': True}

        monkeypatch.setattr(dm, '_ipc_tempdir', _fake_ipc_tempdir)
        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        assert dm._enumerate_monitors_via_user_session() == []
        assert dm.enumerate_modes_via_user_session()['ok'] is True
        assert dm._apply_via_user_session(
            {'monitors': []}, 'sentinel.json', apply_id='ipc-test',
        )['ok'] is True
        assert dm._revert_via_user_session(snapshot=SAMPLE_SNAPSHOT)['ok'] is True
        assert dm._self_test_via_user_session()['ok'] is True

        assert len(ipc_calls) == 5
        assert [call[0] for call in spawn_calls] == [
            '--enumerate-json',
            '--enumerate-modes-json',
            '--apply-json',
            '--revert-json',
            '--self-test',
        ]

    def test_sweeper_removes_only_stale_display_ipc_files(self, tmp_path):
        now = time.time()
        old = now - (2 * 60 * 60)

        def _touch(name, mtime):
            path = tmp_path / name
            path.write_text('x', encoding='utf-8')
            os.utime(path, (mtime, mtime))
            return path

        old_display = _touch('owlette_display_apply_old.req.json', old)
        old_tmp = _touch('orphan.tmp', old)
        fresh_display = _touch('owlette_display_apply_fresh.req.json', now)
        old_unrelated = _touch('unrelated.json', old)

        dm._sweep_ipc_tempdir(str(tmp_path), now=now)

        assert not old_display.exists()
        assert not old_tmp.exists()
        assert fresh_display.exists()
        assert old_unrelated.exists()


# _helper_apply_to_json — happy path


class TestHelperApplyHappyPath:
    """Wave 6: the apply helper writes a sentinel before SDC_APPLY and emits
    a structured success response."""

    def test_writes_response_with_ok_true_and_changes(
        self, monkeypatch, req_path, resp_path, sentinel_path,
    ):
        _stub_ccd_happy_path(monkeypatch)
        # Single monitor: every desired hash is in the stubbed live topology.
        _write_request(req_path, {
            'desired_layout': {'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
            ]},
            'sentinel_path': sentinel_path,
            'ack_timeout_s': 30,
            'apply_id': 'happy-path-id',
        })

        rc = dm._helper_apply_to_json(req_path, resp_path)

        assert rc == 0, 'happy path returns shell exit 0'
        resp = _read_response(resp_path)
        assert resp['ok'] is True
        assert 'changes' in resp
        assert resp['post_active_paths'] == 1
        # `_snapshot` is stripped at the IPC boundary — the on-disk sentinel is
        # the snapshot of record.
        assert '_snapshot' not in resp

    def test_sentinel_written_before_sdc_apply(
        self, monkeypatch, req_path, resp_path, sentinel_path,
    ):
        """SIDECAR ORDERING INVARIANT: sentinel exists on disk at the moment
        SDC_APPLY is invoked. If the apply crashes mid-call, the sentinel
        gives startup recovery a snapshot to revert to.
        """
        observed = []

        def _observer(flags):
            # Does the sentinel exist at THIS exact SDC call?
            sentinel_exists = os.path.exists(sentinel_path)
            stage = (
                'apply' if flags & dm.SDC_APPLY
                else 'validate' if flags & dm.SDC_VALIDATE
                else 'unknown'
            )
            observed.append({'stage': stage, 'sentinel_exists': sentinel_exists})

        _stub_ccd_happy_path(monkeypatch, sdc_observer=_observer)
        _write_request(req_path, {
            'desired_layout': {'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
            ]},
            'sentinel_path': sentinel_path,
            'ack_timeout_s': 30,
            'apply_id': 'sidecar-ordering-id',
        })

        rc = dm._helper_apply_to_json(req_path, resp_path)
        assert rc == 0

        # Call 1 is VALIDATE (pre-sentinel), call 2 APPLY (post-sentinel).
        assert len(observed) == 2, f'expected 2 SDC calls, got {observed}'
        assert observed[0]['stage'] == 'validate'
        assert observed[0]['sentinel_exists'] is False, (
            'sentinel must NOT exist at SDC_VALIDATE — premature write would '
            'leave a stale sentinel after a validate-only failure'
        )
        assert observed[1]['stage'] == 'apply'
        assert observed[1]['sentinel_exists'] is True, (
            'CRITICAL: sentinel MUST exist at SDC_APPLY — a crashed apply '
            'without a sentinel leaves no recovery trail'
        )
        # And it survives the helper returning.
        assert os.path.exists(sentinel_path)

    def test_sentinel_contents_carry_apply_id_and_snapshot(
        self, monkeypatch, req_path, resp_path, sentinel_path,
    ):
        _stub_ccd_happy_path(monkeypatch)
        _write_request(req_path, {
            'desired_layout': {'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
            ]},
            'sentinel_path': sentinel_path,
            'ack_timeout_s': 45,
            'apply_id': 'contents-test-id',
        })
        dm._helper_apply_to_json(req_path, resp_path)

        with open(sentinel_path, 'r', encoding='utf-8') as f:
            sentinel = json.load(f)
        assert sentinel['version'] == dm._SENTINEL_SCHEMA_VERSION
        assert sentinel['apply_id'] == 'contents-test-id'
        assert sentinel['snapshot'] == SAMPLE_SNAPSHOT
        assert 'deadline' in sentinel
        assert sentinel['desired_summary'] == [
            {'edidHash': 'aaaaaaaa', 'primary': True},
        ]


# _helper_apply_to_json — failure paths


class TestHelperApplyFailures:
    """Failure surfaces use the DisplayErrorCode vocabulary so the dashboard
    can route on `code` rather than parsing free-text errors."""

    def test_missing_request_file_returns_ipc_failure(self, resp_path, tmp_path):
        # Missing request path must produce a structured failure response and a
        # non-zero exit, never a crash.
        rc = dm._helper_apply_to_json(str(tmp_path / 'nope.json'), resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.IPC_FAILURE
        assert 'failed to read IPC request' in resp['error']

    def test_malformed_request_json_returns_bad_request(
        self, req_path, resp_path,
    ):
        with open(req_path, 'w', encoding='utf-8') as f:
            f.write('{ not valid json')
        rc = dm._helper_apply_to_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.BAD_REQUEST

    def test_missing_desired_layout_returns_bad_request(
        self, req_path, resp_path, sentinel_path,
    ):
        _write_request(req_path, {'sentinel_path': sentinel_path})
        rc = dm._helper_apply_to_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.BAD_REQUEST
        assert 'desired_layout' in resp['error']
        assert not os.path.exists(sentinel_path), (
            'sentinel must not be written when the request itself is invalid'
        )

    def test_missing_sentinel_path_returns_bad_request(
        self, req_path, resp_path,
    ):
        _write_request(req_path, {'desired_layout': SAMPLE_DESIRED_LAYOUT})
        rc = dm._helper_apply_to_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.BAD_REQUEST

    def test_validate_failure_does_not_write_sentinel(
        self, monkeypatch, req_path, resp_path, sentinel_path,
    ):
        """VALIDATE failure happens BEFORE the sentinel write — confirms
        sidecar ordering on the failure path. ERROR_BAD_CONFIGURATION (1610)
        is the canonical "driver rejected this layout" rc.
        """
        observed = []

        def _observer(flags):
            observed.append({
                'stage': 'apply' if flags & dm.SDC_APPLY else 'validate',
                'sentinel_exists': os.path.exists(sentinel_path),
            })

        _stub_ccd_happy_path(monkeypatch)
        # Fail at VALIDATE.
        monkeypatch.setattr(
            dm, '_SetDisplayConfig',
            _make_failing_sdc(
                validate_rc=dm.ERROR_BAD_CONFIGURATION, observer=_observer,
            ),
        )
        _write_request(req_path, {
            'desired_layout': {'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
            ]},
            'sentinel_path': sentinel_path,
            'ack_timeout_s': 30,
            'apply_id': 'validate-fail-id',
        })

        rc = dm._helper_apply_to_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        # ERROR_BAD_CONFIGURATION at validate maps to UNSUPPORTED_MODE, which the
        # dashboard shows as the "unsupported mode" toast.
        assert resp['code'] == DisplayErrorCode.UNSUPPORTED_MODE
        # VALIDATE only, and no sentinel.
        assert len(observed) == 1
        assert observed[0]['stage'] == 'validate'
        assert observed[0]['sentinel_exists'] is False
        assert not os.path.exists(sentinel_path), (
            'a VALIDATE failure must not leave a sentinel — there is no '
            'apply to recover from'
        )

    def test_apply_failure_preserves_sentinel(
        self, monkeypatch, req_path, resp_path, sentinel_path,
    ):
        """APPLY failure happens AFTER the sentinel write — the sentinel must
        survive so startup recovery can revert. Response carries
        `sentinel_written: True` so the service-side caller can decide whether
        to fire a defensive revert.
        """
        _stub_ccd_happy_path(monkeypatch)
        # APPLY fails with rc=87 (ERROR_INVALID_PARAMETER) -> APPLY_FAILED.
        monkeypatch.setattr(
            dm, '_SetDisplayConfig',
            _make_failing_sdc(validate_rc=dm.ERROR_SUCCESS, apply_rc=87),
        )
        _write_request(req_path, {
            'desired_layout': {'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
            ]},
            'sentinel_path': sentinel_path,
            'ack_timeout_s': 30,
            'apply_id': 'apply-fail-id',
        })

        rc = dm._helper_apply_to_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.APPLY_FAILED
        assert resp['sentinel_written'] is True, (
            'APPLY failure must report sentinel_written so the caller knows '
            'to fire startup recovery / defensive revert'
        )
        assert os.path.exists(sentinel_path), (
            'sentinel must remain on disk after an APPLY failure — it is the '
            'recovery trail'
        )

    def test_sentinel_write_failure_returns_specific_code(
        self, monkeypatch, req_path, resp_path, sentinel_path,
    ):
        """OSError during the sentinel write surfaces as SENTINEL_WRITE_FAILED
        — NOT a generic apply failure. Routing on this code lets the dashboard
        recommend "check disk space / ACLs" instead of "check display driver".
        """
        _stub_ccd_happy_path(monkeypatch)

        # Fail the sentinel write only — the helper must still write a response.
        real_write = dm._atomic_write_json

        def _selective_fail(out_path, payload):
            if out_path == sentinel_path:
                raise OSError('disk full (simulated)')
            return real_write(out_path, payload)
        monkeypatch.setattr(dm, '_atomic_write_json', _selective_fail)

        _write_request(req_path, {
            'desired_layout': {'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
            ]},
            'sentinel_path': sentinel_path,
            'ack_timeout_s': 30,
            'apply_id': 'sentinel-fail-id',
        })

        rc = dm._helper_apply_to_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.SENTINEL_WRITE_FAILED
        assert 'failed to write revert sentinel' in resp['error']
        # The sentinel write failed, so no file.
        assert not os.path.exists(sentinel_path)

    def test_query_failure_returns_query_failed(
        self, monkeypatch, req_path, resp_path, sentinel_path,
    ):
        # None from the CCD query (transient driver hiccup): _apply_core bails
        # before mutating anything, so no sentinel.
        _stub_ccd_happy_path(monkeypatch)
        monkeypatch.setattr(dm, '_query_active_paths_safe', lambda: None)
        _write_request(req_path, {
            'desired_layout': {'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
            ]},
            'sentinel_path': sentinel_path,
            'ack_timeout_s': 30,
            'apply_id': 'query-fail-id',
        })
        rc = dm._helper_apply_to_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.QUERY_FAILED
        assert not os.path.exists(sentinel_path)

    def test_missing_monitors_returns_missing_monitors_code(
        self, monkeypatch, req_path, resp_path, sentinel_path,
    ):
        # Live topology has only 'aaaaaaaa'; the layout wants 'bbbbbbbb'.
        _stub_ccd_happy_path(monkeypatch)
        _write_request(req_path, {
            'desired_layout': SAMPLE_DESIRED_LAYOUT,
            'sentinel_path': sentinel_path,
            'ack_timeout_s': 30,
            'apply_id': 'missing-mon-id',
        })
        rc = dm._helper_apply_to_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.MISSING_MONITORS
        assert 'bbbbbbbb' in resp['missing']
        assert not os.path.exists(sentinel_path)


# _helper_revert_from_json


class TestHelperRevert:
    """Revert helper accepts either an inline snapshot or a sentinel path,
    delegates to `_apply_snapshot`, and writes a structured response."""

    def test_revert_from_inline_snapshot_success(
        self, monkeypatch, req_path, resp_path,
    ):
        called_with = {}

        def _fake_apply_snapshot(snapshot):
            called_with['snapshot'] = snapshot
            return True
        monkeypatch.setattr(dm, '_apply_snapshot', _fake_apply_snapshot)

        _write_request(req_path, {'snapshot': SAMPLE_SNAPSHOT})
        rc = dm._helper_revert_from_json(req_path, resp_path)
        assert rc == 0
        resp = _read_response(resp_path)
        assert resp == {'ok': True}
        assert called_with['snapshot'] == SAMPLE_SNAPSHOT

    def test_revert_from_sentinel_path_loads_snapshot(
        self, monkeypatch, req_path, resp_path, tmp_path,
    ):
        # sentinel_path instead of an inline snapshot: the helper reads the file.
        sentinel = tmp_path / 'sentinel.json'
        with open(sentinel, 'w', encoding='utf-8') as f:
            json.dump({'version': 1, 'snapshot': SAMPLE_SNAPSHOT}, f)

        called_with = {}

        def _fake_apply_snapshot(snapshot):
            called_with['snapshot'] = snapshot
            return True
        monkeypatch.setattr(dm, '_apply_snapshot', _fake_apply_snapshot)

        _write_request(req_path, {'sentinel_path': str(sentinel)})
        rc = dm._helper_revert_from_json(req_path, resp_path)
        assert rc == 0
        resp = _read_response(resp_path)
        assert resp == {'ok': True}
        assert called_with['snapshot'] == SAMPLE_SNAPSHOT

    def test_revert_apply_snapshot_failure_returns_apply_failed(
        self, monkeypatch, req_path, resp_path,
    ):
        # `_apply_snapshot` returns False rather than raising; surface APPLY_FAILED.
        monkeypatch.setattr(dm, '_apply_snapshot', lambda snapshot: False)
        _write_request(req_path, {'snapshot': SAMPLE_SNAPSHOT})
        rc = dm._helper_revert_from_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.APPLY_FAILED
        assert 'SetDisplayConfig failed during revert' in resp['error']

    def test_revert_apply_snapshot_unexpected_exception_returns_unexpected(
        self, monkeypatch, req_path, resp_path,
    ):
        # `_apply_snapshot` should never raise, but if a refactor leaks one the
        # outer try/except must surface UNEXPECTED rather than crash the
        # subprocess with no response file.
        def _explode(snapshot):
            raise RuntimeError('boom')
        monkeypatch.setattr(dm, '_apply_snapshot', _explode)
        _write_request(req_path, {'snapshot': SAMPLE_SNAPSHOT})
        rc = dm._helper_revert_from_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.UNEXPECTED
        assert 'RuntimeError' in resp['error']

    def test_revert_missing_request_file_returns_ipc_failure(
        self, resp_path, tmp_path,
    ):
        rc = dm._helper_revert_from_json(str(tmp_path / 'nope.json'), resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.IPC_FAILURE

    def test_revert_missing_snapshot_and_sentinel_returns_bad_request(
        self, req_path, resp_path,
    ):
        _write_request(req_path, {})
        rc = dm._helper_revert_from_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.BAD_REQUEST
        assert 'snapshot' in resp['error']

    def test_revert_sentinel_read_failure_returns_sentinel_read_failed(
        self, req_path, resp_path, tmp_path,
    ):
        # A missing sentinel_path raises OSError -> SENTINEL_READ_FAILED, distinct
        # from BAD_REQUEST so the dashboard can say "sentinel missing/corrupted".
        _write_request(req_path, {
            'sentinel_path': str(tmp_path / 'does-not-exist.json'),
        })
        rc = dm._helper_revert_from_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.SENTINEL_READ_FAILED

    def test_revert_sentinel_without_snapshot_field_returns_no_snapshot(
        self, req_path, resp_path, tmp_path,
    ):
        # Well-formed JSON missing `snapshot` — distinct from a malformed file.
        sentinel = tmp_path / 'sentinel.json'
        with open(sentinel, 'w', encoding='utf-8') as f:
            json.dump({'version': 1, 'apply_id': 'x'}, f)
        _write_request(req_path, {'sentinel_path': str(sentinel)})
        rc = dm._helper_revert_from_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.SENTINEL_NO_SNAPSHOT

    def test_revert_malformed_sentinel_returns_sentinel_read_failed(
        self, req_path, resp_path, tmp_path,
    ):
        sentinel = tmp_path / 'sentinel.json'
        with open(sentinel, 'w', encoding='utf-8') as f:
            f.write('{ not json')
        _write_request(req_path, {'sentinel_path': str(sentinel)})
        rc = dm._helper_revert_from_json(req_path, resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        # A json decode ValueError shares the OSError clause -> SENTINEL_READ_FAILED.
        assert resp['code'] == DisplayErrorCode.SENTINEL_READ_FAILED


# Response-write failure (covers both helpers)


class TestHelperResponseWriteFailure:
    """If the response file itself cannot be written, the helper returns
    exit code 2 — the spawner reads this as 'process ran but reporting
    failed' and surfaces a HELPER_FAILED to the dashboard instead of
    parsing a non-existent response file."""

    def test_apply_response_write_failure_returns_exit_2(
        self, monkeypatch, req_path, resp_path, sentinel_path,
    ):
        # Every _atomic_write_json fails. The apply helper's first write is the
        # response (BAD_REQUEST branch, no sentinel reached); exit 2 means the
        # response file is missing or stale.
        _write_request(req_path, {})  # missing desired_layout — BAD_REQUEST
        monkeypatch.setattr(
            dm, '_atomic_write_json',
            lambda *a, **kw: (_ for _ in ()).throw(OSError('no perms')),
        )
        rc = dm._helper_apply_to_json(req_path, resp_path)
        assert rc == 2

    def test_revert_response_write_failure_returns_exit_2(
        self, monkeypatch, req_path, resp_path,
    ):
        _write_request(req_path, {})  # BAD_REQUEST path
        monkeypatch.setattr(
            dm, '_atomic_write_json',
            lambda *a, **kw: (_ for _ in ()).throw(OSError('no perms')),
        )
        rc = dm._helper_revert_from_json(req_path, resp_path)
        assert rc == 2
