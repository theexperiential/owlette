"""Unit tests for display_manager write path.

Covers the pieces that operate in pure Python with CCD stubbed out:
- `_apply_core` — shared query/mutate/validate/apply/verify sequence.
- `ack_apply` — stale-id rejection + no-in-flight gate.
- `apply_revert_from_sentinel` — schema version check + OSError preservation.
- `DisplayErrorCode` enum — presence of the codes the helper contract uses.

The real CCD calls (`_SetDisplayConfig`, `_query_active_paths_safe`,
`_snapshot_live_config`, `_apply_snapshot`) are patched via `unittest.mock`,
so these tests don't require a real monitor or Windows session.
"""

import json
import os
import threading
from unittest.mock import patch, MagicMock

import pytest

import display_manager as dm
from display_manager import DisplayErrorCode


SAMPLE_DESIRED = {
    'monitors': [
        {'edidHash': 'aaaaaaaa', 'primary': True, 'position': {'x': 0, 'y': 0}},
        {'edidHash': 'bbbbbbbb', 'primary': False, 'position': {'x': 1920, 'y': 0}},
    ],
}

SAMPLE_SNAPSHOT = {'paths': [], 'modes': []}


@pytest.fixture
def tmp_sentinel(tmp_path):
    """Point _get_sentinel_path at a per-test tmp file."""
    sentinel = tmp_path / '.display_revert_pending'
    with patch.object(dm, '_SENTINEL_PATH', str(sentinel)):
        yield str(sentinel)


@pytest.fixture
def reset_apply_state():
    """Clear apply_topology globals between tests so flag state doesn't leak."""
    yield
    dm._apply_in_flight = False
    dm._ack_event.clear()
    dm._current_apply_id = None


class TestDisplayErrorCode:
    """The enum is the IPC vocabulary; regressions here break the helper contract."""

    def test_enum_members_serialize_as_strings(self):
        # `DisplayErrorCode(str, Enum)` subclasses str, so JSON round-trips cleanly.
        payload = json.dumps({'code': DisplayErrorCode.APPLY_FAILED})
        assert '"apply_failed"' in payload

    @pytest.mark.parametrize('name,value', [
        ('BAD_REQUEST', 'bad_request'),
        ('QUERY_FAILED', 'query_failed'),
        ('MISSING_MONITORS', 'missing_monitors'),
        ('VALIDATE_REJECTED', 'validate_rejected'),
        ('APPLY_FAILED', 'apply_failed'),
        ('APPLY_TIMEOUT', 'apply_timeout'),
        ('SENTINEL_WRITE_FAILED', 'sentinel_write_failed'),
        ('UNSUPPORTED_SENTINEL_VERSION', 'unsupported_sentinel_version'),
        ('MOSAIC_ACTIVE', 'mosaic_active'),
        ('STALE_ACK', 'stale_ack'),
        ('NO_PENDING_APPLY', 'no_pending_apply'),
        ('HELPER_FAILED', 'helper_failed'),
        ('UNEXPECTED', 'unexpected'),
    ])
    def test_required_codes_present(self, name, value):
        assert getattr(DisplayErrorCode, name).value == value


class TestAckApply:
    """`ack_apply(apply_id)` gates on both `_apply_in_flight` and matching id."""

    def test_rejects_when_no_apply_in_flight(self, reset_apply_state):
        dm._apply_in_flight = False
        result = dm.ack_apply(apply_id='anything')
        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.NO_PENDING_APPLY

    def test_rejects_stale_apply_id(self, reset_apply_state):
        dm._apply_in_flight = True
        dm._current_apply_id = 'current-apply-uuid'
        result = dm.ack_apply(apply_id='a-different-uuid')
        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.STALE_ACK
        assert not dm._ack_event.is_set(), 'event must not fire on stale ack'

    def test_accepts_matching_apply_id(self, reset_apply_state):
        dm._apply_in_flight = True
        dm._current_apply_id = 'matching-uuid'
        dm._ack_event.clear()
        result = dm.ack_apply(apply_id='matching-uuid')
        assert result['success'] is True
        assert result['applyId'] == 'matching-uuid'
        assert dm._ack_event.is_set()

    def test_legacy_none_applyid_accepted(self, reset_apply_state):
        # Backwards-compat: callers that don't pass apply_id still ack.
        dm._apply_in_flight = True
        dm._current_apply_id = 'any-uuid'
        dm._ack_event.clear()
        result = dm.ack_apply(apply_id=None)
        assert result['success'] is True
        assert dm._ack_event.is_set()


class TestApplyCore:
    """`_apply_core` is the shared CCD sequence — helper and S1 both call it."""

    def _patch_ccd(self, monkeypatch, query_return, snapshot_return=SAMPLE_SNAPSHOT,
                   validate_rc=0, apply_rc=0, post_query_return=None):
        """Install stubs for the CCD operations."""
        monkeypatch.setattr(dm, '_query_active_paths_safe',
                            lambda: query_return if post_query_return is None
                            else post_query_return if getattr(self, '_call_count', 0) > 0
                            else query_return)

        def _edid_hash(*args, **kwargs):
            return 'aaaaaaaa'  # every path maps to the primary monitor
        monkeypatch.setattr(dm, '_edid_hash_for_target', _edid_hash)
        monkeypatch.setattr(dm, '_apply_desired_to_paths',
                            lambda *a, **kw: [{'monitorId': 'x', 'field': 'primary'}])
        monkeypatch.setattr(dm, '_count_active_paths', lambda paths: 1)
        monkeypatch.setattr(dm, '_snapshot_live_config', lambda: snapshot_return)
        # Return an rc per-call: first call = validate, subsequent = apply
        rcs = iter([validate_rc, apply_rc, apply_rc])
        monkeypatch.setattr(dm, '_SetDisplayConfig', lambda *a, **kw: next(rcs))

    def test_query_failure(self, monkeypatch, tmp_sentinel):
        monkeypatch.setattr(dm, '_query_active_paths_safe', lambda: None)
        result = dm._apply_core(SAMPLE_DESIRED, tmp_sentinel, 30, 'test-id')
        assert result['ok'] is False
        assert result['code'] == DisplayErrorCode.QUERY_FAILED
        assert not os.path.exists(tmp_sentinel), 'no sentinel on query failure'

    def test_missing_monitors(self, monkeypatch, tmp_sentinel):
        # Live topology only has 'aaaaaaaa'; desired includes 'bbbbbbbb'.
        mock_path = MagicMock()
        mock_path.flags = dm.DISPLAYCONFIG_PATH_ACTIVE
        monkeypatch.setattr(dm, '_query_active_paths_safe',
                            lambda: ([mock_path], []))
        monkeypatch.setattr(dm, '_edid_hash_for_target',
                            lambda *a, **kw: 'aaaaaaaa')
        result = dm._apply_core(SAMPLE_DESIRED, tmp_sentinel, 30, 'test-id')
        assert result['ok'] is False
        assert result['code'] == DisplayErrorCode.MISSING_MONITORS
        assert 'bbbbbbbb' in result['missing']
        assert not os.path.exists(tmp_sentinel)


class TestApplyRevertFromSentinel:
    """Startup recovery must fail loud on corruption; preserve sentinel on transient errors."""

    def test_no_sentinel_returns_cleanly(self, tmp_sentinel):
        # Sentinel path doesn't exist yet.
        result = dm.apply_revert_from_sentinel()
        assert result['success'] is False
        assert 'no sentinel' in result['error']

    def test_malformed_json_preserves_sentinel(self, tmp_sentinel):
        # Write garbage; apply_revert_from_sentinel should NOT delete it.
        with open(tmp_sentinel, 'w') as f:
            f.write('not valid json {{{')
        result = dm.apply_revert_from_sentinel()
        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.SENTINEL_MALFORMED
        assert os.path.exists(tmp_sentinel), 'malformed sentinel preserved for operator'

    def test_unsupported_version_preserves_sentinel(self, tmp_sentinel):
        with open(tmp_sentinel, 'w') as f:
            json.dump({'version': 999, 'snapshot': {}}, f)
        result = dm.apply_revert_from_sentinel()
        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.UNSUPPORTED_SENTINEL_VERSION
        assert os.path.exists(tmp_sentinel), 'future-version sentinel preserved'

    def test_missing_snapshot_cleans_sentinel(self, tmp_sentinel):
        # Well-formed JSON but no `snapshot` field — not transient, cleanup.
        with open(tmp_sentinel, 'w') as f:
            json.dump({'version': 1}, f)
        result = dm.apply_revert_from_sentinel()
        assert result['success'] is False
        assert not os.path.exists(tmp_sentinel)

    def test_transient_oserror_preserves_sentinel(self, tmp_sentinel):
        # Simulate a file-read hiccup; sentinel must stay on disk for retry.
        with open(tmp_sentinel, 'w') as f:
            json.dump({'version': 1, 'snapshot': {}}, f)

        # Patch open() to raise OSError on the read inside apply_revert_from_sentinel.
        real_open = open
        call_count = {'n': 0}

        def flaky_open(path, *args, **kwargs):
            if str(path) == tmp_sentinel and 'r' in (args[0] if args else kwargs.get('mode', 'r')):
                call_count['n'] += 1
                if call_count['n'] == 1:
                    raise OSError('transient read failure')
            return real_open(path, *args, **kwargs)

        with patch('builtins.open', flaky_open):
            result = dm.apply_revert_from_sentinel()
        assert result['success'] is False
        assert result.get('deferred') is True
        assert os.path.exists(tmp_sentinel), 'OSError preserves sentinel for retry'


class TestMakeRevertWatchdog:
    """The shared watchdog factory dedupes S0 + S1 paths."""

    def test_ack_cancels_revert(self, reset_apply_state):
        revert_called = threading.Event()
        dm._apply_in_flight = True
        dm._ack_event.clear()

        def _revert():
            revert_called.set()
            return {'ok': True}

        watchdog = dm._make_revert_watchdog(_revert, 1, None)
        t = threading.Thread(target=watchdog, daemon=True)
        t.start()
        # Ack immediately — watchdog should exit before calling revert.
        dm._ack_event.set()
        t.join(timeout=0.5)
        assert not revert_called.is_set(), 'revert must not run when ack fires'
        assert dm._apply_in_flight is False

    def test_timeout_fires_revert(self, reset_apply_state):
        revert_called = threading.Event()
        dm._apply_in_flight = True
        dm._ack_event.clear()

        def _revert():
            revert_called.set()
            return {'ok': True}

        watchdog = dm._make_revert_watchdog(_revert, 0.05, None)  # 50ms timeout
        t = threading.Thread(target=watchdog, daemon=True)
        t.start()
        t.join(timeout=1.0)
        assert revert_called.is_set(), 'revert fires on ack timeout'
        assert dm._apply_in_flight is False

    def test_failed_revert_preserves_apply_in_flight_clear(self, reset_apply_state):
        # Even if revert_fn raises, the finally block must clear _apply_in_flight.
        dm._apply_in_flight = True
        dm._ack_event.clear()

        def _revert_raises():
            raise RuntimeError('boom')

        watchdog = dm._make_revert_watchdog(_revert_raises, 0.05, None)
        t = threading.Thread(target=watchdog, daemon=True)
        t.start()
        t.join(timeout=1.0)
        assert dm._apply_in_flight is False
