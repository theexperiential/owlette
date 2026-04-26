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
    dm._last_apply_time = 0.0


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
        ('ZERO_PRIMARY', 'zero_primary'),
        ('MULTIPLE_PRIMARY', 'multiple_primary'),
        ('INVALID_ROTATION', 'invalid_rotation'),
        ('UNSUPPORTED_MODE', 'unsupported_mode'),
        ('AUTO_RESTORE_SKIPPED_UNFIXABLE', 'auto_restore_skipped_unfixable'),
        ('AUTO_RESTORE_RATE_LIMITED', 'auto_restore_rate_limited'),
    ])
    def test_required_codes_present(self, name, value):
        assert getattr(DisplayErrorCode, name).value == value


class TestValidateDesiredLayout:
    """`_validate_desired_layout` is the service-side shape check before the
    helper is invoked. It returns ``(ok, err, code)`` so the dashboard can
    distinguish 'no primary selected' from 'unknown field' without parsing
    the error string."""

    def _monitor(self, **overrides):
        base = {
            'edidHash': 'aaaaaaaa',
            'position': {'x': 0, 'y': 0},
            'primary': False,
            'rotation': 0,
        }
        base.update(overrides)
        return base

    def test_accepts_canonical_layout(self):
        desired = {
            'monitors': [
                self._monitor(primary=True),
                self._monitor(edidHash='bbbbbbbb', position={'x': 1920, 'y': 0}),
            ],
        }
        ok, err, code = dm._validate_desired_layout(desired)
        assert ok is True
        assert err is None
        assert code is None

    def test_rejects_non_dict(self):
        ok, _, code = dm._validate_desired_layout('not a dict')
        assert ok is False
        assert code == DisplayErrorCode.INVALID_INPUT

    def test_rejects_empty_monitors(self):
        ok, _, code = dm._validate_desired_layout({'monitors': []})
        assert ok is False
        assert code == DisplayErrorCode.INVALID_INPUT

    def test_rejects_missing_edid_hash(self):
        desired = {'monitors': [self._monitor(primary=True, edidHash='')]}
        ok, _, code = dm._validate_desired_layout(desired)
        assert ok is False
        assert code == DisplayErrorCode.INVALID_INPUT

    def test_rejects_missing_position(self):
        m = self._monitor(primary=True)
        m.pop('position')
        ok, _, code = dm._validate_desired_layout({'monitors': [m]})
        assert ok is False
        assert code == DisplayErrorCode.INVALID_INPUT

    def test_rejects_zero_primary(self):
        desired = {'monitors': [self._monitor(), self._monitor(edidHash='bbbbbbbb')]}
        ok, err, code = dm._validate_desired_layout(desired)
        assert ok is False
        assert code == DisplayErrorCode.ZERO_PRIMARY
        assert 'primary' in err

    def test_rejects_multiple_primary(self):
        desired = {
            'monitors': [
                self._monitor(primary=True),
                self._monitor(edidHash='bbbbbbbb', primary=True),
            ],
        }
        ok, err, code = dm._validate_desired_layout(desired)
        assert ok is False
        assert code == DisplayErrorCode.MULTIPLE_PRIMARY
        assert '2' in err

    @pytest.mark.parametrize('bad_rotation', [1, 45, 91, 360, -90])
    def test_rejects_non_canonical_rotation(self, bad_rotation):
        desired = {'monitors': [self._monitor(primary=True, rotation=bad_rotation)]}
        ok, _, code = dm._validate_desired_layout(desired)
        assert ok is False
        assert code == DisplayErrorCode.INVALID_ROTATION

    @pytest.mark.parametrize('good_rotation', [0, 90, 180, 270])
    def test_accepts_canonical_rotations(self, good_rotation):
        desired = {'monitors': [self._monitor(primary=True, rotation=good_rotation)]}
        ok, _, code = dm._validate_desired_layout(desired)
        assert ok is True
        assert code is None

    def test_accepts_missing_rotation(self):
        # Legacy captures may omit `rotation` entirely — default to no check.
        m = self._monitor(primary=True)
        m.pop('rotation')
        ok, _, code = dm._validate_desired_layout({'monitors': [m]})
        assert ok is True
        assert code is None


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



class TestCcdFailureCode:
    """`_ccd_failure_code(rc, stage)` maps SetDisplayConfig rcs to specific
    error codes so the dashboard can distinguish an unsupported-mode
    rejection from a generic config-rejected failure.
    """

    @pytest.mark.parametrize('rc', [dm.ERROR_GEN_FAILURE, dm.ERROR_BAD_CONFIGURATION])
    @pytest.mark.parametrize('stage', ['validate', 'apply'])
    def test_mode_rcs_map_to_unsupported_mode(self, rc, stage):
        # Both ERROR_GEN_FAILURE (31, post-TDR-retry) and ERROR_BAD_CONFIGURATION
        # (1610, explicit driver rejection) translate to UNSUPPORTED_MODE at
        # either stage — the dashboard's "unsupported mode" toast is the
        # correct surface for both.
        assert dm._ccd_failure_code(rc, stage) == DisplayErrorCode.UNSUPPORTED_MODE

    def test_other_rc_at_validate_stays_generic(self):
        # ERROR_INVALID_PARAMETER is ambiguous — could mean bad struct, bad
        # LUID, bad mode. Leave under VALIDATE_REJECTED so UNSUPPORTED_MODE
        # only fires for the two explicit mode-rejection rcs.
        assert (
            dm._ccd_failure_code(87, 'validate')
            == DisplayErrorCode.VALIDATE_REJECTED
        )

    def test_other_rc_at_apply_stays_generic(self):
        assert dm._ccd_failure_code(87, 'apply') == DisplayErrorCode.APPLY_FAILED

    def test_zero_rc_not_called_in_practice_but_maps_to_generic(self):
        # ERROR_SUCCESS (0) should never be passed to `_ccd_failure_code` —
        # callers only hit this helper after rc != ERROR_SUCCESS. But if a
        # refactor ever leaks through, make sure we don't spuriously tag a
        # success as UNSUPPORTED_MODE. 0 isn't in the mode-rejection set so
        # we fall through to the generic code per stage.
        assert (
            dm._ccd_failure_code(0, 'validate') == DisplayErrorCode.VALIDATE_REJECTED
        )
        assert dm._ccd_failure_code(0, 'apply') == DisplayErrorCode.APPLY_FAILED


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


# ---------------------------------------------------------------------------
# Wave A3.1 — supported-modes enumeration


def _make_enum_mock(specs):
    """Build a fake ``_EnumDisplaySettingsExW`` that serves synthetic modes by
    index. ``specs`` is a list of dicts with keys ``bpp``, ``flags``, ``hz``,
    ``w``, ``h``; index past the list length (or a ``None`` entry) signals
    end-of-enumeration (FALSE) exactly like the real Win32 call.

    The fake writes into the caller's DEVMODEW via the byref's ``._obj``
    attribute — a CPython implementation detail but stable across every
    supported Python 3 we run the agent on, and the alternative (refactoring
    ``_enum_modes_for_monitor`` to take a dependency injection point) would
    distort production code for test scaffolding.
    """
    def _mock(device_name, mode_num, dev_ref, flags):
        if mode_num >= len(specs) or specs[mode_num] is None:
            return 0  # FALSE — end of enumeration
        spec = specs[mode_num]
        dev = dev_ref._obj
        dev.dmBitsPerPel = spec.get('bpp', 32)
        dev._u2.dmDisplayFlags = spec.get('flags', 0)
        dev.dmDisplayFrequency = spec.get('hz', 60)
        dev.dmPelsWidth = spec.get('w', 1920)
        dev.dmPelsHeight = spec.get('h', 1080)
        return 1  # TRUE
    return _mock


class TestEnumerateModes:
    """`_enum_modes_for_monitor` filter/dedup/sort and `_build_display_modes_catalogue`
    byEdidHash keying — the shape the dashboard resolution/refresh dropdowns
    will read in A3.3/A3.4.
    """

    def test_filters_interlaced_and_16bpp_and_low_hz(self, monkeypatch):
        # Four modes: one interlaced (drop), one 16bpp (drop), one <24Hz (drop),
        # one valid. Only the valid one should survive.
        monkeypatch.setattr(dm, '_EnumDisplaySettingsExW', _make_enum_mock([
            {'bpp': 32, 'flags': dm.DM_INTERLACED, 'hz': 60, 'w': 1920, 'h': 1080},
            {'bpp': 16, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 10, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
        ]))
        out = dm._enum_modes_for_monitor(r'\\.\DISPLAY1')
        assert out == [{'w': 1920, 'h': 1080, 'hz': 60}]

    def test_dedupes_repeated_tuples(self, monkeypatch):
        # Same (w, h, hz) offered four times under different BPPs / flags that
        # all pass the filter. The final list should contain exactly one entry.
        monkeypatch.setattr(dm, '_EnumDisplaySettingsExW', _make_enum_mock([
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
        ]))
        out = dm._enum_modes_for_monitor(r'\\.\DISPLAY1')
        assert out == [{'w': 1920, 'h': 1080, 'hz': 60}]

    def test_sorts_descending_w_h_hz(self, monkeypatch):
        # Shuffled input — expect strictly descending (w, h, hz) output.
        monkeypatch.setattr(dm, '_EnumDisplaySettingsExW', _make_enum_mock([
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 120, 'w': 1920, 'h': 1080},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 3840, 'h': 2160},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 2560, 'h': 1440},
            {'bpp': 32, 'flags': 0, 'hz': 60, 'w': 2560, 'h': 1080},  # same w, smaller h
        ]))
        out = dm._enum_modes_for_monitor(r'\\.\DISPLAY1')
        assert out == [
            {'w': 3840, 'h': 2160, 'hz': 60},
            {'w': 2560, 'h': 1440, 'hz': 60},
            {'w': 2560, 'h': 1080, 'hz': 60},
            {'w': 1920, 'h': 1080, 'hz': 120},
            {'w': 1920, 'h': 1080, 'hz': 60},
        ]

    def test_empty_device_name_short_circuits(self):
        # Guard at the top of _enum_modes_for_monitor — never calls Win32.
        assert dm._enum_modes_for_monitor('') == []
        assert dm._enum_modes_for_monitor(None) == []

    def test_catalogue_keys_one_per_edidhash(self, monkeypatch):
        # Stub out everything the catalogue builder calls so we can drive the
        # composition logic with known inputs: two active paths, distinct
        # edidHashes, each with a known canned modes list.

        # 1. Skip the profile walk (we only need its signatureHash surfaced).
        monkeypatch.setattr(dm, 'build_display_profile', lambda: {
            'schemaVersion': dm.SCHEMA_VERSION,
            'signatureHash': 'deadbeef' * 4,  # 32 chars
            'capturedAt': 1_700_000_000,
            'monitors': [],
            'mosaicActive': False,
            'enumerationFailed': False,
        })

        # 2. Two stub paths with distinct (adapterId, sourceId, targetId) tuples.
        def _stub_path(adapter_id, source_id, target_id):
            p = MagicMock()
            p.flags = dm.DISPLAYCONFIG_PATH_ACTIVE
            p.sourceInfo.adapterId = adapter_id
            p.sourceInfo.id = source_id
            p.targetInfo.adapterId = adapter_id
            p.targetInfo.id = target_id
            return p

        paths = [_stub_path('A1', 0, 100), _stub_path('A1', 1, 101)]
        monkeypatch.setattr(dm, '_query_active_paths_safe', lambda: (paths, []))

        # 3. Fake target-device-name returns shaped like the real one.
        def _fake_target_name(adapter, target):
            info = MagicMock()
            info.monitorFriendlyDeviceName = f'MON{target}'
            info.flags.bits.edidIdsValid = 1
            # Distinct mfg/product per target so the edidHashes differ.
            info.edidManufactureId = 0x1000 + target
            info.edidProductCodeId = target
            info.monitorDevicePath = f'\\\\?\\DISPLAY#TST{target}#5&abc&0&UID{target}#{{x}}'
            return info
        monkeypatch.setattr(dm, '_get_target_device_name', _fake_target_name)

        # 4. Source-name lookup — deterministic per sourceId.
        def _fake_source_name(adapter, source_id):
            return f'\\\\.\\DISPLAY{source_id + 1}'
        monkeypatch.setattr(dm, '_get_source_device_name', _fake_source_name)

        # 5. Canned modes per monitor — keyed on the gdi name.
        modes_by_gdi = {
            r'\\.\DISPLAY1': [{'w': 3840, 'h': 2160, 'hz': 60}],
            r'\\.\DISPLAY2': [
                {'w': 2560, 'h': 1440, 'hz': 144},
                {'w': 1920, 'h': 1080, 'hz': 60},
            ],
        }
        monkeypatch.setattr(dm, '_enum_modes_for_monitor',
                            lambda name: list(modes_by_gdi.get(name, [])))

        cat = dm._build_display_modes_catalogue()
        assert cat['schemaVersion'] == dm.SCHEMA_VERSION
        assert cat['signatureHash'] == 'deadbeef' * 4
        assert len(cat['byEdidHash']) == 2, 'one key per distinct edidHash'
        # Modes land under their monitor's edidHash — spot-check the counts.
        counts = sorted(len(info['modes']) for info in cat['byEdidHash'].values())
        assert counts == [1, 2]
        # Every entry carries the full DPI scale table.
        for info in cat['byEdidHash'].values():
            assert info['dpiScales'] == list(dm._DPI_SCALE_TABLE)

    def test_catalogue_tolerates_empty_modes(self, monkeypatch):
        # Monitor present but EnumDisplaySettings returns nothing — the catalogue
        # should still carry its edidHash, with modes: []. Matches Risk 2 in the
        # sub-plan: "don't fail the whole catalogue".
        monkeypatch.setattr(dm, 'build_display_profile', lambda: {
            'schemaVersion': dm.SCHEMA_VERSION,
            'signatureHash': 'cafe' * 8,
            'capturedAt': 1_700_000_000,
            'monitors': [],
            'mosaicActive': False,
            'enumerationFailed': False,
        })
        p = MagicMock()
        p.flags = dm.DISPLAYCONFIG_PATH_ACTIVE
        p.sourceInfo.adapterId = 'A'
        p.sourceInfo.id = 0
        p.targetInfo.adapterId = 'A'
        p.targetInfo.id = 77
        monkeypatch.setattr(dm, '_query_active_paths_safe', lambda: ([p], []))

        info = MagicMock()
        info.monitorFriendlyDeviceName = 'HEADLESS'
        info.flags.bits.edidIdsValid = 1
        info.edidManufactureId = 0x1077
        info.edidProductCodeId = 77
        info.monitorDevicePath = r'\\?\DISPLAY#HDL#0&0&0&UID77#{x}'
        monkeypatch.setattr(dm, '_get_target_device_name', lambda *a, **kw: info)
        monkeypatch.setattr(dm, '_get_source_device_name',
                            lambda *a, **kw: r'\\.\DISPLAY1')
        monkeypatch.setattr(dm, '_enum_modes_for_monitor', lambda name: [])

        cat = dm._build_display_modes_catalogue()
        assert len(cat['byEdidHash']) == 1
        only_entry = next(iter(cat['byEdidHash'].values()))
        assert only_entry['modes'] == []
        assert only_entry['dpiScales'] == list(dm._DPI_SCALE_TABLE)

    def test_catalogue_surfaces_enumeration_failed(self, monkeypatch):
        # When build_display_profile reports enumerationFailed, the catalogue
        # short-circuits with an empty byEdidHash and the flag set — A3.2 will
        # read this and skip the Firestore upload.
        monkeypatch.setattr(dm, 'build_display_profile', lambda: {
            'schemaVersion': dm.SCHEMA_VERSION,
            'signatureHash': '0' * 32,
            'capturedAt': 1_700_000_000,
            'monitors': [],
            'mosaicActive': False,
            'enumerationFailed': True,
        })
        cat = dm._build_display_modes_catalogue()
        assert cat['enumerationFailed'] is True
        assert cat['byEdidHash'] == {}


# ---------------------------------------------------------------------------
# Wave B2.4 — post-apply suppression window for display events


@pytest.fixture
def reset_suppression_state():
    """Restore `_last_apply_finished_at` after each test so the global
    doesn't leak between cases. Default 0.0 = "no apply since startup".
    """
    yield
    dm._last_apply_finished_at = 0.0


class TestSuppressionWindow:
    """`is_within_apply_suppression_window(now, window_s)` — pure predicate
    behind owlette_service's `suppressAlert` stamping. Default window is
    90s; pre-apply (initial 0.0 timestamp) returns False unconditionally.
    """

    def test_initial_state_is_not_suppressed(self, reset_suppression_state):
        # Fresh service start — no apply has run yet. Drift events emitted
        # in the first 90s of uptime must NOT be misclassified as
        # apply-correlated, or the operator never sees real bootup drift.
        dm._last_apply_finished_at = 0.0
        assert dm.is_within_apply_suppression_window(now=1_700_000_000.0) is False

    def test_event_within_window_is_suppressed(self, reset_suppression_state):
        # Apply finished 30s ago — well inside the 90s window. The follow-on
        # drift events that always arrive after a successful apply (OS
        # settling + topology re-check tick) get correctly tagged for
        # suppression downstream.
        dm._last_apply_finished_at = 1_700_000_000.0
        assert (
            dm.is_within_apply_suppression_window(now=1_700_000_030.0) is True
        )

    def test_event_at_window_edge_is_suppressed(self, reset_suppression_state):
        # Strictly less-than gate: an event 89.999s after apply still
        # qualifies. Off-by-one guard so a single-second floor doesn't
        # collapse "just inside" to False.
        dm._last_apply_finished_at = 1_700_000_000.0
        assert (
            dm.is_within_apply_suppression_window(now=1_700_000_089.999) is True
        )

    def test_event_after_window_is_not_suppressed(self, reset_suppression_state):
        # 91s after apply — past the window, so the event represents real
        # operator-relevant drift (something physically changed long after
        # the apply settled) and routing should treat it as a normal alert.
        dm._last_apply_finished_at = 1_700_000_000.0
        assert (
            dm.is_within_apply_suppression_window(now=1_700_000_091.0) is False
        )

    def test_window_boundary_exactly_90s_is_not_suppressed(
        self, reset_suppression_state,
    ):
        # The < (not <=) comparison means 90.0 exactly falls OUTSIDE the
        # window. Documents the boundary so a future tweak to <= can't
        # silently flip the semantics.
        dm._last_apply_finished_at = 1_700_000_000.0
        assert (
            dm.is_within_apply_suppression_window(now=1_700_000_090.0) is False
        )

    def test_custom_window_s_overrides_default(self, reset_suppression_state):
        # Test injection: caller can shorten or lengthen the window for
        # specific scenarios. 30s window with a 60s gap → not suppressed
        # even though 60s would suppress under the default 90s.
        dm._last_apply_finished_at = 1_700_000_000.0
        assert (
            dm.is_within_apply_suppression_window(
                now=1_700_000_060.0, window_s=30.0,
            ) is False
        )
        # Same gap, 90s window → suppressed (sanity-check the override).
        assert (
            dm.is_within_apply_suppression_window(
                now=1_700_000_060.0, window_s=90.0,
            ) is True
        )

    def test_now_defaults_to_wall_clock(self, reset_suppression_state):
        # When `now` is omitted the helper reads `time.time()`. Set
        # `_last_apply_finished_at` to "just now" via the same source so
        # the helper sees a sub-second elapsed value and reports True.
        import time as _time
        dm._last_apply_finished_at = _time.time()
        assert dm.is_within_apply_suppression_window() is True
        # And the converse: an apply timestamp from far in the past falls
        # outside the window even with the default-now path.
        dm._last_apply_finished_at = _time.time() - 3600
        assert dm.is_within_apply_suppression_window() is False


# ---------------------------------------------------------------------------
# Wave C1 — auto_restore branch in apply_topology


class TestApplyTopologyAutoRestore:
    """`apply_topology(..., auto_restore=True)` is the unattended drift-correction
    path driven by the topology checker (C2). Success skips the watchdog (no
    operator to ack), removes the sentinel, emits ``display_auto_restore_fired``,
    and returns a dict shaped for `_maybe_auto_restore` to consume.
    """

    def _patch_auto_restore_success_path(self, monkeypatch, changes=None):
        """Force the S1 in-process branch with `_apply_core` returning success.

        Stubs out: session probe (S1), Mosaic detect (inactive),
        `shared_utils.read_config` (kill switch absent → enabled), CCD apply,
        and the profile resync trigger.
        """
        if changes is None:
            changes = [{'monitorId': 'aaaaaaaa', 'field': 'primary'}]

        # Force S1 (in-process) so `_apply_core` is the success-path stub point.
        monkeypatch.setattr(dm, '_is_session_0', lambda: False)

        # `displays.enabled` absent → feature enabled (missing-key default);
        # `displays.remoteApplyEnabled` must read True or the Wave 6.1 master
        # kill switch rejects the apply.
        import shared_utils

        def _read_config(keys=None, **kw):
            if keys == ['displays', 'remoteApplyEnabled']:
                return True
            return None
        monkeypatch.setattr(shared_utils, 'read_config', _read_config)

        # Mosaic refuse-guard inactive on the test host.
        import nvapi_display
        monkeypatch.setattr(
            nvapi_display, 'detect_mosaic', lambda: {'mosaicActive': False},
        )

        # `_apply_core` is the only CCD-touching call on the S1 path; stub the
        # whole thing so the test never reaches Win32.
        monkeypatch.setattr(
            dm,
            '_apply_core',
            lambda *a, **kw: {'ok': True, 'changes': changes, '_snapshot': SAMPLE_SNAPSHOT},
        )
        # `_trigger_profile_resync` is fire-and-forget; stub to avoid touching
        # the (mocked) firebase client's `_ensure_display_profile`.
        monkeypatch.setattr(dm, '_trigger_profile_resync', lambda fb: None)

        return changes

    def test_no_watchdog_thread_started_on_success(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        self._patch_auto_restore_success_path(monkeypatch)
        # Pre-test sanity: no leftover watchdog from a prior test in this proc.
        assert not any(
            t.name == 'display-apply-watchdog' and t.is_alive()
            for t in threading.enumerate()
        )
        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='test-apply-1',
            auto_restore=True,
        )
        assert result['success'] is True
        # Watchdog is the only thing that holds `_apply_in_flight` past return.
        assert dm._apply_in_flight is False
        assert not any(
            t.name == 'display-apply-watchdog' and t.is_alive()
            for t in threading.enumerate()
        ), 'auto-restore success path must not arm a revert watchdog'

    def test_sentinel_cleaned_up_on_success(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        self._patch_auto_restore_success_path(monkeypatch)
        # Pre-create a sentinel as if a prior interactive apply orphaned one;
        # auto-restore success must remove it (no recovery hook needed —
        # drift will re-fire from a fresh state on the next checker tick).
        with open(tmp_sentinel, 'w') as f:
            json.dump({'version': 1, 'snapshot': {}}, f)
        assert os.path.exists(tmp_sentinel)
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=MagicMock(),
            apply_id='test-apply-2', auto_restore=True,
        )
        assert result['success'] is True
        assert not os.path.exists(tmp_sentinel), \
            'auto-restore success must clean up any sentinel on disk'

    def test_audit_event_shape(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        changes = [
            {'monitorId': 'aaaaaaaa', 'field': 'primary'},
            {'monitorId': 'bbbbbbbb', 'field': 'position'},
        ]
        self._patch_auto_restore_success_path(monkeypatch, changes=changes)
        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb,
            apply_id='audit-id-xyz', auto_restore=True,
        )
        assert result['success'] is True
        # Exactly one audit event on the auto-restore success path.
        assert fb.log_event.call_count == 1
        kwargs = fb.log_event.call_args.kwargs
        assert kwargs['action'] == 'display_auto_restore_fired'
        assert kwargs['level'] == 'info'
        extras = kwargs['extra_fields']
        assert extras['eventType'] == 'display_auto_restore_fired'
        assert extras['autoRestore'] is True
        assert extras['applyId'] == 'audit-id-xyz'
        assert extras['monitorCount'] == len(SAMPLE_DESIRED['monitors'])
        assert extras['changes'] == changes

    def test_lock_contention_returns_graceful_error(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        self._patch_auto_restore_success_path(monkeypatch)
        # Simulate a concurrent apply by holding the apply lock; a separate
        # in-flight flag is set so we can verify the contention path doesn't
        # clobber it (the holder still owns that flag's lifecycle).
        dm._apply_in_flight = True
        assert dm._apply_lock.acquire(blocking=False), 'precondition: lock free'
        try:
            fb = MagicMock()
            result = dm.apply_topology(
                SAMPLE_DESIRED, firebase_client=fb,
                apply_id='contention-id', auto_restore=True,
            )
            assert result['success'] is False
            assert 'apply already in progress' in result['error']
            # Contention path emits no audit event — it's a pre-apply gate.
            assert fb.log_event.call_count == 0
            # Crucially, the contention return path must NOT touch
            # `_apply_in_flight` — the existing apply's holder owns it.
            assert dm._apply_in_flight is True
        finally:
            dm._apply_lock.release()

    def test_rate_limit_returns_cooldown_response(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        import time as _time
        self._patch_auto_restore_success_path(monkeypatch)
        # Simulate an apply that finished < cooldown ago.
        original_last = dm._last_apply_time
        dm._last_apply_time = _time.time()
        try:
            fb = MagicMock()
            result = dm.apply_topology(
                SAMPLE_DESIRED, firebase_client=fb,
                apply_id='cooldown-id', auto_restore=True,
            )
            assert result['success'] is False
            assert 'rate limited' in result['error']
            # No `code` field — C2 must distinguish rate-limit (transient,
            # not a failure) from a real failure with a code.
            assert 'code' not in result
            # No audit event on rate-limit return.
            assert fb.log_event.call_count == 0
        finally:
            dm._last_apply_time = original_last

    def test_killswitch_returns_disabled_error(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        # Force just the displays.enabled key to read False; everything else
        # behaves as default. Mosaic stub still installed in case the killswitch
        # gate ever moves (defensive).
        import shared_utils
        import nvapi_display
        monkeypatch.setattr(dm, '_is_session_0', lambda: False)
        monkeypatch.setattr(
            nvapi_display, 'detect_mosaic', lambda: {'mosaicActive': False},
        )

        def _fake_read_config(keys=None, **kw):
            if keys == ['displays', 'enabled']:
                return False
            return None
        monkeypatch.setattr(shared_utils, 'read_config', _fake_read_config)

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb,
            apply_id='killswitch-id', auto_restore=True,
        )
        assert result == {
            'success': False,
            'error': 'displays feature disabled by config',
        }
        # Killswitch returns before any audit emit — no event on disable.
        assert fb.log_event.call_count == 0

    def test_return_shape_on_success(
        self, monkeypatch, tmp_sentinel, reset_apply_state,
    ):
        changes = [{'monitorId': 'aaaaaaaa', 'field': 'primary'}]
        self._patch_auto_restore_success_path(monkeypatch, changes=changes)
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=MagicMock(),
            apply_id='shape-id', auto_restore=True,
        )
        # C2's `_maybe_auto_restore` reads each of these fields; pin the shape.
        assert result['success'] is True
        assert result['autoRestore'] is True
        assert result['applyId'] == 'shape-id'
        assert result['changes'] == changes


# ---------------------------------------------------------------------------
# Wave C2.5 — full auto-restore cycle integration test


class _FakeService:
    """Minimum surface needed to bind `OwletteService._maybe_auto_restore` and
    `_run_auto_restore` as bound methods. Constructing a real OwletteService
    pulls in pywin32 ServiceFramework, threading watchdogs, Firestore listeners
    — all unnecessary noise for unit-testing the orchestration logic.

    Method binding (in tests) uses ``OwletteService.<method>.__get__(fake, OwletteService)``
    so the production code paths execute verbatim against the fake's attributes.
    """

    _DISPLAY_DRIFT_FIELDS = (
        ('position.x',        lambda m: (m.get('position') or {}).get('x')),
        ('position.y',        lambda m: (m.get('position') or {}).get('y')),
        ('resolution.width',  lambda m: (m.get('resolution') or {}).get('width')),
        ('resolution.height', lambda m: (m.get('resolution') or {}).get('height')),
        ('refreshHz',         lambda m: m.get('refreshHz')),
        ('rotation',          lambda m: m.get('rotation')),
        ('scalePct',          lambda m: m.get('scalePct')),
        ('primary',           lambda m: m.get('primary')),
    )

    def __init__(self):
        # `_run_auto_restore` reads ``self.firebase_client.update_display_autorestore_state``
        # and `_maybe_auto_restore` doesn't touch firebase_client directly, but
        # both methods reach `self._emit_display_event` via the unfixable /
        # breaker-trip branches.
        self.firebase_client = MagicMock()
        # Drift-persistence gate (gate 6): default at the firing threshold so
        # _maybe_auto_restore proceeds unless a test overrides it.
        self._drift_pending_tick_count = 2
        # _emit_display_event is invoked by both methods; mock so tests can
        # assert call_args_list against the real production-side payloads.
        self._emit_display_event = MagicMock()


class TestAutoRestoreCycle:
    """Full auto-restore cycle (C2.5): drift -> apply -> failure-counter ->
    breaker trip -> skip-while-tripped -> manual reset re-enables.

    Mocks at the I/O boundary only (apply_topology, update_display_autorestore_state,
    shared_utils.read_config); the orchestration logic in `_maybe_auto_restore` /
    `_run_auto_restore` runs unmodified by binding the real methods to a tiny
    `_FakeService` via descriptor protocol (``__get__``).
    """

    @pytest.fixture
    def fake_service(self):
        from owlette_service import OwletteService
        svc = _FakeService()
        # Bind the production methods so the body executes against the fake's
        # attributes. ``__get__(svc, cls)`` is the standard descriptor recipe
        # for turning an unbound function into a bound method on a foreign
        # instance — keeps the test honest (real branches, real call shapes).
        svc._maybe_auto_restore = OwletteService._maybe_auto_restore.__get__(
            svc, OwletteService,
        )
        svc._assigned_drift_hashes = OwletteService._assigned_drift_hashes.__get__(
            svc, OwletteService,
        )
        svc._maybe_auto_restore_assigned_drift = (
            OwletteService._maybe_auto_restore_assigned_drift.__get__(
                svc, OwletteService,
            )
        )
        svc._run_auto_restore = OwletteService._run_auto_restore.__get__(
            svc, OwletteService,
        )
        return svc

    @pytest.fixture
    def assigned_layout(self):
        # The layout `_run_auto_restore` passes to `apply_topology`. Identical
        # shape to what gates pull from `displays.assigned` in a real config.
        return {
            'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
                {'edidHash': 'bbbbbbbb', 'primary': False,
                 'position': {'x': 1920, 'y': 0}},
            ],
        }

    def _make_config_reader(self, config_state):
        """Build a `shared_utils.read_config` stub that resolves dotted-key paths
        from a nested ``config_state`` dict. Mirrors the production traversal
        (return None on missing key) so the gate logic sees the same shape.
        """
        def _read(keys=None, **kw):
            if not keys:
                return config_state
            cur = config_state
            for k in keys:
                if not isinstance(cur, dict):
                    return None
                cur = cur.get(k)
                if cur is None:
                    return None
            return cur
        return _read

    def test_full_cycle(
        self, monkeypatch, fake_service, assigned_layout, reset_apply_state,
    ):
        """End-to-end: 3 consecutive failures trip the breaker, the next drift
        is skipped while tripped, and a manual reset re-enables firing.

        Failure-counter steps invoke `_run_auto_restore` directly — bypassing
        the thread spawn keeps the assertions deterministic without monkey-
        patching `threading.Thread`. The skip-while-tripped + reset steps
        invoke `_maybe_auto_restore` end-to-end so the real gate chain runs.
        """
        import shared_utils
        import display_manager as dm_mod

        # Mutable config state — drives both `shared_utils.read_config` (gate
        # reads) and the in-flight breaker counter `_run_auto_restore` reads
        # before incrementing. Tests mutate this dict to simulate Firestore
        # -> local config sync (e.g., manual reset writing tripped=False).
        config_state = {
            'displays': {
                'enabled': True,
                'autoRestore': {
                    'enabled': True,
                    'circuitBreaker': {'failures': 0, 'tripped': False},
                },
                'assigned': assigned_layout,
            },
        }
        monkeypatch.setattr(
            shared_utils, 'read_config', self._make_config_reader(config_state),
        )

        # `update_display_autorestore_state` is the sole Firestore write surface
        # for breaker bookkeeping. Patch it on the fake's MagicMock so we can
        # also propagate writes back into local `config_state` — that mirrors
        # the real Firestore listener pulling the new value into `config.json`
        # on the next sync tick, which is what the gate chain will read.
        def _record_state_write(patch):
            cb = config_state['displays']['autoRestore']['circuitBreaker']
            cb.update(patch)
        fake_service.firebase_client.update_display_autorestore_state.side_effect = (
            _record_state_write
        )

        # Sequence of `apply_topology` outcomes: fail, fail, fail (which trips
        # the breaker on the 3rd). Codes are the generic apply-failure path
        # (NOT rate-limited / unfixable, which are pre-apply skips that don't
        # increment the counter).
        apply_results = [
            {'success': False, 'error': 'ccd rejected layout',
             'code': dm_mod.DisplayErrorCode.APPLY_FAILED},
            {'success': False, 'error': 'set-display-config rc=87',
             'code': dm_mod.DisplayErrorCode.VALIDATE_REJECTED},
            {'success': False, 'error': 'unsupported mode',
             'code': dm_mod.DisplayErrorCode.UNSUPPORTED_MODE},
        ]
        apply_calls = []

        def _mock_apply_topology(layout, **kw):
            apply_calls.append({'layout': layout, 'kwargs': kw})
            return apply_results[len(apply_calls) - 1]

        monkeypatch.setattr(dm_mod, 'apply_topology', _mock_apply_topology)

        # --- Failure 1: counter -> 1, breaker untripped ---------------------
        fake_service._run_auto_restore(assigned_layout)
        cb = config_state['displays']['autoRestore']['circuitBreaker']
        assert cb['failures'] == 1
        assert cb.get('tripped') is False
        # No trip event yet — only fires when failures >= 3.
        assert fake_service._emit_display_event.call_count == 0

        # --- Failure 2: counter -> 2, breaker still untripped ---------------
        fake_service._run_auto_restore(assigned_layout)
        cb = config_state['displays']['autoRestore']['circuitBreaker']
        assert cb['failures'] == 2
        assert cb.get('tripped') is False
        assert fake_service._emit_display_event.call_count == 0

        # --- Failure 3: counter -> 3, breaker trips, audit event fires ------
        fake_service._run_auto_restore(assigned_layout)
        cb = config_state['displays']['autoRestore']['circuitBreaker']
        assert cb['failures'] == 3
        assert cb['tripped'] is True
        assert 'trippedAt' in cb
        # The trip event must fire exactly once at the trip moment.
        assert fake_service._emit_display_event.call_count == 1
        trip_call = fake_service._emit_display_event.call_args_list[0]
        # _emit_display_event(event_type, severity, payload) — positional.
        assert trip_call.args[0] == 'display_auto_restore_circuit_breaker_tripped'
        assert trip_call.args[1] == 'error'
        trip_payload = trip_call.args[2]
        assert trip_payload['eventType'] == (
            'display_auto_restore_circuit_breaker_tripped'
        )
        assert trip_payload['failures'] == 3
        assert trip_payload['lastError'] == 'unsupported mode'

        # --- 3 apply_topology calls so far; no more should occur while tripped
        assert len(apply_calls) == 3

        # --- New drift while tripped: gate 3 short-circuits, no apply spawn -
        # `_maybe_auto_restore` is the gate-chain entry point. With tripped=True
        # in local config it must return before reaching the thread spawn.
        # Use a fresh profile object — content is irrelevant since gate 3
        # rejects before any profile-shape reads.
        new_profile = {'monitors': [], 'signatureHash': 'abc'}
        drifted_hashes = ['aaaaaaaa']
        fake_service._maybe_auto_restore(new_profile, drifted_hashes)
        # Apply count unchanged, no new audit events.
        assert len(apply_calls) == 3
        assert fake_service._emit_display_event.call_count == 1

        # --- Manual reset (dashboard writes tripped=False; Firestore listener
        # propagates back into local config.json on next sync) ----------------
        # Also reset the failures counter, mirroring how the manual-reset
        # endpoint clears both fields atomically.
        config_state['displays']['autoRestore']['circuitBreaker'] = {
            'failures': 0, 'tripped': False,
        }
        # Next apply succeeds — `_maybe_auto_restore` should let it through
        # and `_run_auto_restore` (called manually here, since we don't want
        # the test to depend on real thread-spawn timing) writes the success
        # state back. Replace the apply mock with a success result.
        success_changes = [{'monitorId': 'aaaaaaaa', 'field': 'primary'}]
        success_result = {
            'success': True,
            'applyId': 'reset-apply-id',
            'autoRestore': True,
            'changes': success_changes,
        }
        post_reset_calls = []

        def _mock_apply_success(layout, **kw):
            post_reset_calls.append({'layout': layout, 'kwargs': kw})
            return success_result

        monkeypatch.setattr(dm_mod, 'apply_topology', _mock_apply_success)

        # First, prove the gate chain now lets `_maybe_auto_restore` through —
        # it spawns a daemon thread that calls `_run_auto_restore`. Capture
        # the spawn so we can join it deterministically rather than racing.
        spawned = []
        real_thread_cls = threading.Thread

        def _capture_thread(target, args=(), daemon=False, name=None, **kw):
            t = real_thread_cls(
                target=target, args=args, daemon=daemon, name=name, **kw,
            )
            spawned.append(t)
            return t
        monkeypatch.setattr(threading, 'Thread', _capture_thread)

        fake_service._maybe_auto_restore(new_profile, drifted_hashes)
        # Exactly one auto-restore worker spawned (and `_maybe_auto_restore`
        # already invoked .start() on it before returning).
        assert len(spawned) == 1
        assert spawned[0].name == 'display-auto-restore'
        spawned[0].join(timeout=2.0)
        assert not spawned[0].is_alive(), 'auto-restore worker must complete'

        # The worker called apply_topology and wrote the success state.
        assert len(post_reset_calls) == 1
        cb = config_state['displays']['autoRestore']['circuitBreaker']
        assert cb['failures'] == 0
        assert cb['tripped'] is False
        assert 'lastSuccessAt' in cb
        # No additional breaker-trip events from the success path.
        assert fake_service._emit_display_event.call_count == 1

    def test_stable_assigned_drift_fires_after_two_display_ticks(
        self, monkeypatch, fake_service, assigned_layout, reset_apply_state,
    ):
        """Auto-restore must catch stable live-vs-assigned drift, not only
        topology-change events. First tick records persistence; second tick
        enters the normal gate chain and spawns the worker.
        """
        import shared_utils
        import display_manager as dm_mod

        config_state = {
            'displays': {
                'enabled': True,
                'autoRestore': {
                    'enabled': True,
                    'circuitBreaker': {'failures': 0, 'tripped': False},
                },
                'assigned': assigned_layout,
            },
        }
        monkeypatch.setattr(
            shared_utils, 'read_config', self._make_config_reader(config_state),
        )

        live_profile = {
            'monitors': [
                {'edidHash': 'aaaaaaaa', 'primary': True,
                 'position': {'x': 0, 'y': 0}},
                {'edidHash': 'bbbbbbbb', 'primary': False,
                 'position': {'x': 1920, 'y': 100}},
            ],
        }

        apply_calls = []

        def _mock_apply_success(layout, **kw):
            apply_calls.append({'layout': layout, 'kwargs': kw})
            return {'success': True, 'changes': [], 'autoRestore': True}

        monkeypatch.setattr(dm_mod, 'apply_topology', _mock_apply_success)

        spawned = []
        real_thread_cls = threading.Thread

        def _capture_thread(target, args=(), daemon=False, name=None, **kw):
            t = real_thread_cls(
                target=target, args=args, daemon=daemon, name=name, **kw,
            )
            spawned.append(t)
            return t

        monkeypatch.setattr(threading, 'Thread', _capture_thread)
        fake_service._drift_pending_tick_count = 0

        fake_service._maybe_auto_restore_assigned_drift(live_profile)
        assert fake_service._drift_pending_tick_count == 1
        assert spawned == []

        fake_service._maybe_auto_restore_assigned_drift(live_profile)
        assert fake_service._drift_pending_tick_count == 2
        assert len(spawned) == 1
        spawned[0].join(timeout=2.0)
        assert len(apply_calls) == 1
        assert apply_calls[0]['layout'] == assigned_layout
