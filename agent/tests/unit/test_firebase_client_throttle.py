"""
tests for should_emit_progress — the pure throttle-decision helper used
by FirebaseClient.update_command_progress (wave 4b.5).

prevents firestore cost explosion: a 64k-chunk roost distribution would
otherwise write 64k progress docs per machine. throttle coalesces same-
status writes within both PROGRESS_THROTTLE_SECONDS and PROGRESS_THROTTLE_PERCENT
thresholds.

uses the module-level pure function so we don't have to instantiate
FirebaseClient (which pulls in cryptography/PyO3 and conflicts with
pytest's interpreter reuse model).
"""
import sys
from unittest.mock import MagicMock, patch

import pytest

# pre-mock win32 so the import works on non-windows CI as well as locally.
_MOCK_MODULES = {
    "win32api": MagicMock(),
    "win32con": MagicMock(),
    "win32event": MagicMock(),
    "win32service": MagicMock(),
    "win32serviceutil": MagicMock(),
    "servicemanager": MagicMock(),
    "win32ts": MagicMock(),
    "win32process": MagicMock(),
    "win32gui": MagicMock(),
    "win32security": MagicMock(),
    "pywintypes": MagicMock(),
    "wmi": MagicMock(),
}
_patches = {m: mock for m, mock in _MOCK_MODULES.items() if m not in sys.modules}

try:
    with patch.dict("sys.modules", _patches):
        from firebase_client import should_emit_progress
except ImportError as exc:
    pytest.skip(f"firebase_client not importable: {exc}", allow_module_level=True)
except Exception as exc:
    pytest.skip(f"firebase_client import failed: {exc}", allow_module_level=True)


SECONDS = 30.0
PCT = 5


def test_first_write_emits_with_no_prior_state():
    emit, state = should_emit_progress(
        prev_state=None, status='downloading', progress=5, force=False,
        now=1000.0, min_seconds=SECONDS, min_pct=PCT,
    )
    assert emit is True
    assert state == {'ts': 1000.0, 'status': 'downloading', 'progress': 5}


def test_within_both_thresholds_coalesces():
    prev = {'ts': 1000.0, 'status': 'downloading', 'progress': 5}
    emit, state = should_emit_progress(
        prev_state=prev, status='downloading', progress=6, force=False,
        now=1010.0,  # +10s, well below 30s
        min_seconds=SECONDS, min_pct=PCT,
    )
    # +1% is below 5% threshold AND +10s is below 30s — coalesce.
    assert emit is False
    # state preserved (not advanced)
    assert state is prev


def test_percent_threshold_breach_emits():
    prev = {'ts': 1000.0, 'status': 'downloading', 'progress': 5}
    emit, state = should_emit_progress(
        prev_state=prev, status='downloading', progress=11,  # +6% > 5%
        force=False, now=1010.0, min_seconds=SECONDS, min_pct=PCT,
    )
    assert emit is True
    assert state['progress'] == 11


def test_time_threshold_breach_emits():
    prev = {'ts': 1000.0, 'status': 'downloading', 'progress': 5}
    emit, state = should_emit_progress(
        prev_state=prev, status='downloading', progress=6,  # only +1%
        force=False, now=1060.0,  # but +60s > 30s
        min_seconds=SECONDS, min_pct=PCT,
    )
    assert emit is True
    assert state['ts'] == 1060.0


def test_status_change_always_emits():
    """transitions are observable cliffs; never throttle them."""
    prev = {'ts': 1000.0, 'status': 'downloading', 'progress': 99}
    emit, state = should_emit_progress(
        prev_state=prev, status='extracting', progress=0,  # status changed
        force=False, now=1001.0,  # only +1s
        min_seconds=SECONDS, min_pct=PCT,
    )
    assert emit is True
    assert state['status'] == 'extracting'


def test_force_bypasses_throttling():
    """terminal events MUST land — force=True ignores both thresholds."""
    prev = {'ts': 1000.0, 'status': 'downloading', 'progress': 5}
    emit, state = should_emit_progress(
        prev_state=prev, status='downloading', progress=6,
        force=True, now=1001.0,  # +1s, +1% — would normally coalesce
        min_seconds=SECONDS, min_pct=PCT,
    )
    assert emit is True


def test_progress_none_treated_as_zero_delta():
    """if progress is None on either side, the % check shouldn't blow up."""
    prev = {'ts': 1000.0, 'status': 'downloading', 'progress': None}
    emit, _ = should_emit_progress(
        prev_state=prev, status='downloading', progress=None,
        force=False, now=1010.0, min_seconds=SECONDS, min_pct=PCT,
    )
    # within time threshold + no usable percent delta → coalesce
    assert emit is False


def test_threshold_at_exactly_the_boundary_emits():
    """boundary semantics: elapsed >= min_seconds OR pct_delta >= min_pct emits."""
    prev = {'ts': 1000.0, 'status': 'downloading', 'progress': 5}
    emit, _ = should_emit_progress(
        prev_state=prev, status='downloading', progress=10,  # +5% == threshold
        force=False, now=1015.0, min_seconds=SECONDS, min_pct=PCT,
    )
    assert emit is True


def test_first_emit_at_zero_progress_records_state():
    emit, state = should_emit_progress(
        prev_state=None, status='downloading', progress=0,
        force=False, now=500.0, min_seconds=SECONDS, min_pct=PCT,
    )
    assert emit is True
    assert state == {'ts': 500.0, 'status': 'downloading', 'progress': 0}
