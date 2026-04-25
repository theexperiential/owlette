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
        ('ZERO_PRIMARY', 'zero_primary'),
        ('MULTIPLE_PRIMARY', 'multiple_primary'),
        ('INVALID_ROTATION', 'invalid_rotation'),
        ('UNSUPPORTED_MODE', 'unsupported_mode'),
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
