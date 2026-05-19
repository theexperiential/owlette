"""Integration tests for the self-restart watchdog flow in ConnectionManager.

Exercises _check_self_restart end-to-end with mocks for internet check,
reboot_state, and restart_callback — covering the wiring that pure-function
tests cannot.
"""

import logging
import time
from unittest.mock import MagicMock, patch

import pytest

try:
    from connection_manager import (
        ConnectionManager,
        WATCHDOG_DEFAULTS,
        REASON_CONNECTION_STUCK,
    )
    import watchdog_state
except ImportError:
    pytest.skip("watchdog modules not importable", allow_module_level=True)


@pytest.fixture
def temp_state(monkeypatch, tmp_path):
    """Isolate watchdog_state files per test."""
    budget = tmp_path / 'watchdog_budget.owlette_service.json'
    history = tmp_path / 'watchdog_history.owlette_service.json'
    monkeypatch.setattr('watchdog_state.BUDGET_PATH', str(budget))
    monkeypatch.setattr('watchdog_state.HISTORY_PATH', str(history))
    yield tmp_path


@pytest.fixture
def cm(monkeypatch, temp_state):
    """ConnectionManager wired with fast thresholds and mocked externals."""
    manager = ConnectionManager(logging.getLogger("test_watchdog_integration"))
    # Force a config that makes the watchdog fire almost immediately
    fast_cfg = {
        'enabled': True,
        'thresholds': {'failure_seconds': 1, 'boot_grace_seconds': 0},
        'budget': {'max_per_window': 3, 'window_seconds': 3600},
        'preconditions': {'require_internet': True, 'fatal_error_suppression_seconds': 3600},
    }
    # Short-circuit the config read to avoid touching real config.json
    monkeypatch.setattr(manager, '_read_watchdog_config', lambda: fast_cfg)
    # Pretend internet is up by default
    monkeypatch.setattr(manager, '_check_internet', lambda: True)
    # Pretend no scheduled reboot
    fake_reboot_state = MagicMock()
    fake_reboot_state.read_state.return_value = {'attempt': None}
    monkeypatch.setitem(__import__('sys').modules, 'reboot_state', fake_reboot_state)
    return manager


class TestCheckSelfRestartFlow:
    def test_fires_when_never_connected_and_threshold_exceeded(self, cm):
        """Fresh boot, no success yet, uptime past threshold → fires."""
        callback = MagicMock()
        cm.set_restart_callback(callback)
        # Simulate 5s of uptime (threshold=1, grace=0 in the fixture)
        cm._process_start_time_mono = time.monotonic() - 5.0

        cm._check_self_restart()

        assert callback.called, "callback should have been invoked"
        exit_code, snapshot = callback.call_args[0]
        assert exit_code == 43
        assert snapshot['reason_code'] == REASON_CONNECTION_STUCK
        assert 'restart_id' in snapshot
        assert snapshot['pid']

    def test_does_not_fire_without_callback_registered(self, cm):
        """If no callback is wired, skip silently but don't crash."""
        cm._process_start_time_mono = time.monotonic() - 5.0
        # No set_restart_callback — should not crash
        cm._check_self_restart()  # should return without raising

    def test_does_not_fire_when_internet_down(self, cm, monkeypatch):
        monkeypatch.setattr(cm, '_check_internet', lambda: False)
        callback = MagicMock()
        cm.set_restart_callback(callback)
        cm._process_start_time_mono = time.monotonic() - 5.0

        cm._check_self_restart()

        assert not callback.called, "callback must not fire when internet is down"

    def test_does_not_fire_during_scheduled_reboot(self, cm, monkeypatch):
        """If reboot_state indicates an attempt in progress, skip."""
        fake = MagicMock()
        fake.read_state.return_value = {'attempt': {'entryId': 'x', 'status': 'pending'}}
        monkeypatch.setitem(__import__('sys').modules, 'reboot_state', fake)
        callback = MagicMock()
        cm.set_restart_callback(callback)
        cm._process_start_time_mono = time.monotonic() - 5.0

        cm._check_self_restart()

        assert not callback.called

    def test_budget_exhaustion_skips_callback(self, cm, temp_state):
        """Fourth fire within window → callback not invoked."""
        callback = MagicMock()
        cm.set_restart_callback(callback)
        cm._process_start_time_mono = time.monotonic() - 5.0

        for _ in range(3):
            cm._check_self_restart()
        assert callback.call_count == 3

        # Fourth attempt is over budget
        cm._check_self_restart()
        assert callback.call_count == 3, "budget exhausted should block callback"

    def test_restart_fires_persist_history_entry(self, cm):
        """Each fire must leave a pending snapshot for the next process to
        submit to Firestore.
        """
        callback = MagicMock()
        cm.set_restart_callback(callback)
        cm._process_start_time_mono = time.monotonic() - 5.0

        cm._check_self_restart()

        pending = watchdog_state.read_pending_history()
        assert len(pending) == 1
        entry = pending[0]
        assert entry['reason_code'] == REASON_CONNECTION_STUCK
        assert 'restart_id' in entry

    def test_emergency_env_var_blocks_fire(self, cm, monkeypatch):
        """Env-var kill switch takes effect even if everything else says fire."""
        monkeypatch.setenv('OWLETTE_DISABLE_WATCHDOG_RESTART', '1')
        callback = MagicMock()
        cm.set_restart_callback(callback)
        cm._process_start_time_mono = time.monotonic() - 5.0

        cm._check_self_restart()

        assert not callback.called

    def test_exception_in_decision_does_not_kill_watchdog(self, cm, monkeypatch):
        """A bug in the decision path must not propagate out of the method."""
        callback = MagicMock()
        cm.set_restart_callback(callback)

        # Force _should_restart to raise
        def boom(**kwargs):
            raise RuntimeError("synthetic failure")
        monkeypatch.setattr('connection_manager._should_restart', boom)

        # Must not raise
        cm._check_self_restart()


class TestReportSuccessStampsTimestamps:
    def test_report_success_sets_both_timestamps(self, cm):
        before_mono = time.monotonic()
        before_wall = time.time()
        cm.report_success()
        assert cm._last_success_time_mono is not None
        assert cm._last_success_time_wall is not None
        assert cm._last_success_time_mono >= before_mono
        assert cm._last_success_time_wall >= before_wall

    def test_report_success_clears_fatal_error_timestamp(self, cm):
        cm._last_fatal_error_time_mono = time.monotonic() - 10.0
        cm.report_success()
        assert cm._last_fatal_error_time_mono is None


class TestReportErrorCapturesDiagnostics:
    def test_error_message_captured_and_truncated(self, cm):
        # Install required callbacks so report_error can trigger reconnection
        # without real threads
        cm._shutdown_event.set()
        long_msg = "x" * 1000
        cm.report_error(Exception(long_msg), context="test")
        assert cm._last_error_message is not None
        assert len(cm._last_error_message) <= 500

    def test_fatal_error_stamps_timestamp(self, cm):
        cm._shutdown_event.set()
        cm.report_error(Exception("invalid_grant"), context="auth")
        assert cm._last_fatal_error_time_mono is not None


class TestGetStatusDiagnostic:
    def test_diagnostic_mode_includes_extra_fields(self, cm, monkeypatch):
        monkeypatch.setattr(cm, '_check_internet', lambda: True)
        cm._last_success_time_mono = time.monotonic() - 30.0
        cm._last_error_message = "something broke"

        status = cm.get_status(diagnostic=True)

        assert 'seconds_since_last_success' in status
        assert status['seconds_since_last_success'] >= 30
        assert status['last_error'] == "something broke"
        assert 'process_uptime_s' in status
        assert 'timestamp_utc' in status
        assert 'internet_check_tcp' in status
        assert 'restart_count_in_window' in status

    def test_diagnostic_mode_handles_never_connected(self, cm, monkeypatch):
        monkeypatch.setattr(cm, '_check_internet', lambda: True)
        cm._last_success_time_mono = None
        status = cm.get_status(diagnostic=True)
        assert status['seconds_since_last_success'] is None

    def test_non_diagnostic_mode_backward_compatible(self, cm):
        """Default get_status() must not add the new fields."""
        status = cm.get_status()
        assert 'seconds_since_last_success' not in status
        assert 'last_error' not in status
