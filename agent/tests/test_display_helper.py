"""Unit tests for the display_manager helper-mode entrypoints.

Covers `_helper_apply_to_json` and `_helper_revert_from_json` — the JSON-IPC
shims invoked by the service from Session 0 via CreateProcessAsUser. The
helpers read a request file, exercise the CCD write sequence (or revert),
and write a structured response file. These tests run them in-process with
synthetic request files and stubbed CCD calls.

Invariant under test (helper apply): the revert sentinel is written to disk
BEFORE SDC_APPLY is called. A crashed apply must leave a recoverable trail.

Invariant under test (helper response): every helper run writes a response
file (success or failure) — the spawner uses exit codes only to distinguish
"process never launched" from "process ran and reported".

Run with:
    cd agent && pytest tests/test_display_helper.py -v
"""

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# Add src/ to path so display_manager is importable as a top-level module
# (the existing agent test suite uses the same pattern via tests/conftest.py
# but agent/tests/ may also be invoked standalone, so insert here too).
sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), '..', 'src'),
)

import display_manager as dm  # noqa: E402
from display_manager import DisplayErrorCode  # noqa: E402


# ---------------------------------------------------------------------------
# Shared fixtures


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
    # Live topology: one fake "path" with the active flag set, and an empty
    # modes list. _apply_core only iterates `paths` and reads `path.flags` /
    # `path.targetInfo.{adapterId,id}` — a MagicMock satisfies all of that.
    mock_path = MagicMock()
    mock_path.flags = dm.DISPLAYCONFIG_PATH_ACTIVE
    monkeypatch.setattr(
        dm, '_query_active_paths_safe',
        lambda: ([mock_path], []),
    )

    # Every live target maps to one of the desired EDID hashes so the
    # missing-monitors check passes. Two desired monitors but only one live
    # path is fine — _apply_core only fails when a desired hash is *missing*
    # from the live set; one path mapped to 'aaaaaaaa' means 'bbbbbbbb' is
    # missing. For tests that need both present, override this stub or use a
    # single-monitor desired layout.
    monkeypatch.setattr(
        dm, '_edid_hash_for_target',
        lambda *a, **kw: 'aaaaaaaa',
    )
    monkeypatch.setattr(
        dm, '_apply_desired_to_paths',
        lambda *a, **kw: [{'monitorId': 'aaaaaaaa', 'field': 'primary'}],
    )
    # Active-paths count: 1 pre-apply, 1 post-apply (avoids ZERO_ACTIVE_PATHS).
    monkeypatch.setattr(dm, '_count_active_paths', lambda paths: 1)
    monkeypatch.setattr(dm, '_snapshot_live_config', lambda: SAMPLE_SNAPSHOT)

    # Stub the ctypes array constructors so we don't need real DEVMODEW /
    # DISPLAYCONFIG_PATH_INFO struct contents — _SetDisplayConfig is stubbed
    # so the array contents are never inspected. The constructors get called
    # with a length argument; a callable factory returning a list works.
    monkeypatch.setattr(
        dm, 'DISPLAYCONFIG_PATH_INFO',
        type('_FakePath', (), {'__mul__': lambda self, n: lambda: [None] * n})(),
    )
    monkeypatch.setattr(
        dm, 'DISPLAYCONFIG_MODE_INFO',
        type('_FakeMode', (), {'__mul__': lambda self, n: lambda: [None] * n})(),
    )

    # `_with_timeout(fn, timeout)` runs `fn` and returns its value; bypass
    # the futures executor so we can synchronously observe SDC calls.
    monkeypatch.setattr(dm, '_with_timeout', lambda fn, _t: fn())

    # _SetDisplayConfig: succeed for both VALIDATE and APPLY. Optionally
    # invoke the observer with the flags arg so a test can capture disk state.
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


# ---------------------------------------------------------------------------
# _helper_apply_to_json — happy path


class TestHelperApplyHappyPath:
    """Wave 6: the apply helper writes a sentinel before SDC_APPLY and emits
    a structured success response."""

    def test_writes_response_with_ok_true_and_changes(
        self, monkeypatch, req_path, resp_path, sentinel_path,
    ):
        _stub_ccd_happy_path(monkeypatch)
        # Single-monitor layout — every desired hash is present in the stubbed
        # live topology, so the missing-monitors check passes cleanly.
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
        # Internal `_snapshot` field is stripped before crossing the IPC
        # boundary — the sentinel on disk is the snapshot of record.
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
            # Capture whether the sentinel exists at THIS exact SDC call.
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

        # Two SDC calls: first VALIDATE (pre-sentinel), second APPLY (post-sentinel).
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
        # Confirm the sentinel actually lives on disk after the helper returns.
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


# ---------------------------------------------------------------------------
# _helper_apply_to_json — failure paths


class TestHelperApplyFailures:
    """Failure surfaces use the DisplayErrorCode vocabulary so the dashboard
    can route on `code` rather than parsing free-text errors."""

    def test_missing_request_file_returns_bad_request(self, resp_path, tmp_path):
        # Request path doesn't exist — the helper should NOT crash; it must
        # write a structured failure response and return non-zero.
        rc = dm._helper_apply_to_json(str(tmp_path / 'nope.json'), resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.BAD_REQUEST
        assert 'failed to read request' in resp['error']

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
        # Override the SDC stub to fail at VALIDATE.
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
        # ERROR_BAD_CONFIGURATION at validate stage maps to UNSUPPORTED_MODE
        # via _ccd_failure_code — the dashboard surfaces this as the
        # "unsupported mode" toast specifically.
        assert resp['code'] == DisplayErrorCode.UNSUPPORTED_MODE
        # Only one SDC call happened (VALIDATE), and the sentinel never landed.
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
        # VALIDATE succeeds (pass-through), APPLY fails with rc=87
        # (ERROR_INVALID_PARAMETER) which maps to APPLY_FAILED.
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

        # Make _atomic_write_json fail when called for the sentinel, but
        # succeed for the response file. Path-discriminate so we don't break
        # the helper's ability to write its own response.
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
        # The sentinel write failed, so the file must not exist on disk.
        assert not os.path.exists(sentinel_path)

    def test_query_failure_returns_query_failed(
        self, monkeypatch, req_path, resp_path, sentinel_path,
    ):
        # CCD query returns None (transient driver hiccup). _apply_core bails
        # before any mutation; sentinel is never written.
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
        # Live topology only has 'aaaaaaaa'; desired layout asks for 'bbbbbbbb'.
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


# ---------------------------------------------------------------------------
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
        # Caller supplies a sentinel_path instead of an inline snapshot — the
        # helper reads the file and pulls `snapshot` out.
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
        # `_apply_snapshot` returns False on SetDisplayConfig failure (it
        # never raises); the helper must surface APPLY_FAILED.
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
        # `_apply_snapshot` is documented to never raise — but if a future
        # refactor ever leaks an exception, the helper's outer try/except
        # must catch it and surface UNEXPECTED rather than letting the
        # subprocess crash with no response file.
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

    def test_revert_missing_request_file_returns_bad_request(
        self, resp_path, tmp_path,
    ):
        rc = dm._helper_revert_from_json(str(tmp_path / 'nope.json'), resp_path)
        assert rc == 1
        resp = _read_response(resp_path)
        assert resp['ok'] is False
        assert resp['code'] == DisplayErrorCode.BAD_REQUEST

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
        # sentinel_path points at a path that doesn't exist; open() raises
        # OSError, and the helper surfaces SENTINEL_READ_FAILED — distinct
        # from BAD_REQUEST so the dashboard can show "sentinel missing /
        # corrupted" specifically.
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
        # Well-formed sentinel JSON but missing the `snapshot` key — distinct
        # from a malformed file (caught by SENTINEL_READ_FAILED via ValueError).
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
        # ValueError (json decode) is caught by the same except clause as
        # OSError, so it surfaces under SENTINEL_READ_FAILED.
        assert resp['code'] == DisplayErrorCode.SENTINEL_READ_FAILED


# ---------------------------------------------------------------------------
# Response-write failure (covers both helpers)


class TestHelperResponseWriteFailure:
    """If the response file itself cannot be written, the helper returns
    exit code 2 — the spawner reads this as 'process ran but reporting
    failed' and surfaces a HELPER_FAILED to the dashboard instead of
    parsing a non-existent response file."""

    def test_apply_response_write_failure_returns_exit_2(
        self, monkeypatch, req_path, resp_path, sentinel_path,
    ):
        # Force every _atomic_write_json call to fail. The apply helper's
        # FIRST write attempt is the response (via _respond on the BAD_REQUEST
        # branch — no sentinel write reached). Exit code 2 signals the
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
