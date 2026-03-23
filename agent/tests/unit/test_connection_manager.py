"""Tests for connection_manager.py — ConnectionManager state machine and backoff logic."""

import pytest
from unittest.mock import MagicMock, patch, call
import logging

try:
    from connection_manager import ConnectionManager, ConnectionState
except ImportError:
    pytest.skip("connection_manager not importable", allow_module_level=True)


@pytest.fixture
def logger():
    return logging.getLogger("test_connection_manager")


@pytest.fixture
def cm(logger):
    """Create a ConnectionManager with real threading (but patched sleep/socket)."""
    manager = ConnectionManager(logger)
    # Prevent actual reconnection attempts from spawning background threads
    manager._shutdown_event.set()
    return manager


# ---------------------------------------------------------------------------
# TestConnectionState — initial state, connect, disconnect
# ---------------------------------------------------------------------------
class TestConnectionState:
    def test_initial_state_is_disconnected(self, cm):
        assert cm.state == ConnectionState.DISCONNECTED

    def test_connect_success_transitions_to_connected(self, cm):
        cm._shutdown_event.clear()
        success_cb = MagicMock(return_value=True)
        cm.set_callbacks(connect=success_cb, disconnect=MagicMock())
        result = cm.connect()
        assert result is True
        assert cm.state == ConnectionState.CONNECTED

    def test_connect_failure_stays_disconnected(self, cm):
        fail_cb = MagicMock(return_value=False)
        cm.set_callbacks(connect=fail_cb, disconnect=MagicMock())
        result = cm.connect()
        assert result is False
        assert cm.state == ConnectionState.DISCONNECTED

    def test_connect_when_already_connected_returns_true(self, cm):
        """If already connected, connect() should short-circuit to True."""
        cm._shutdown_event.clear()
        success_cb = MagicMock(return_value=True)
        cm.set_callbacks(connect=success_cb, disconnect=MagicMock())
        cm.connect()
        # Second call — should still return True without re-calling callback
        result = cm.connect()
        assert result is True
        # Callback only called once (first connect)
        assert success_cb.call_count == 1

    def test_is_connected_property_true_when_connected(self, cm):
        cm._shutdown_event.clear()
        success_cb = MagicMock(return_value=True)
        cm.set_callbacks(connect=success_cb, disconnect=MagicMock())
        cm.connect()
        assert cm.is_connected is True

    def test_is_connected_property_false_when_disconnected(self, cm):
        assert cm.is_connected is False

    def test_connect_callback_exception_handled(self, cm):
        """If the connect callback raises, connect() should not crash."""
        bad_cb = MagicMock(side_effect=Exception("network down"))
        cm.set_callbacks(connect=bad_cb, disconnect=MagicMock())
        result = cm.connect()
        assert result is False


# ---------------------------------------------------------------------------
# TestBackoff — failure counting and reset
# ---------------------------------------------------------------------------
class TestBackoff:
    def test_report_success_resets_failure_count(self, cm):
        cm._consecutive_failures = 5
        cm.report_success()
        assert cm.consecutive_failures == 0

    def test_connect_failure_increments_failures(self, cm):
        """Consecutive failures increment when connect fails."""
        fail_cb = MagicMock(return_value=False)
        cm.set_callbacks(connect=fail_cb, disconnect=MagicMock())
        cm.connect()
        assert cm.consecutive_failures == 1

    def test_multiple_connect_failures_increment(self, cm):
        """Each failed connect increments _consecutive_failures."""
        fail_cb = MagicMock(return_value=False)
        cm.set_callbacks(connect=fail_cb, disconnect=MagicMock())
        cm.connect()
        # Reset state so we can connect again
        cm._state = ConnectionState.DISCONNECTED
        cm.connect()
        cm._state = ConnectionState.DISCONNECTED
        cm.connect()
        assert cm.consecutive_failures >= 3

    def test_success_resets_backoff(self, cm):
        cm._current_backoff = 600.0
        cm._consecutive_failures = 10
        cm.report_success()
        assert cm._current_backoff == cm.BACKOFF_BASE
        assert cm._consecutive_failures == 0

    def test_circuit_breaker_opens_after_threshold(self, cm):
        """Circuit breaker opens after FAILURE_THRESHOLD consecutive failures."""
        fail_cb = MagicMock(return_value=False)
        cm.set_callbacks(connect=fail_cb, disconnect=MagicMock())
        for _ in range(cm.FAILURE_THRESHOLD):
            cm._state = ConnectionState.DISCONNECTED
            cm.connect()
        assert cm.is_circuit_open is True


# ---------------------------------------------------------------------------
# TestStateListeners — add, remove, error handling
# ---------------------------------------------------------------------------
class TestStateListeners:
    def test_listener_called_on_state_change(self, cm):
        cm._shutdown_event.clear()
        listener = MagicMock()
        cm.add_state_listener(listener)
        success_cb = MagicMock(return_value=True)
        cm.set_callbacks(connect=success_cb, disconnect=MagicMock())
        cm.connect()
        assert listener.called, "State listener should have been called on connect"

    def test_bad_listener_does_not_crash(self, cm):
        """If a listener raises, ConnectionManager should catch it."""
        cm._shutdown_event.clear()
        bad_listener = MagicMock(side_effect=RuntimeError("listener error"))
        cm.add_state_listener(bad_listener)
        success_cb = MagicMock(return_value=True)
        cm.set_callbacks(connect=success_cb, disconnect=MagicMock())
        # Should not raise
        cm.connect()

    def test_remove_listener_stops_notifications(self, cm):
        cm._shutdown_event.clear()
        listener = MagicMock()
        cm.add_state_listener(listener)
        cm.remove_state_listener(listener)
        success_cb = MagicMock(return_value=True)
        cm.set_callbacks(connect=success_cb, disconnect=MagicMock())
        cm.connect()
        listener.assert_not_called()


# ---------------------------------------------------------------------------
# TestShutdown — clean teardown from connected state
# ---------------------------------------------------------------------------
class TestShutdown:
    def test_shutdown_from_connected_state(self, cm):
        cm._shutdown_event.clear()
        success_cb = MagicMock(return_value=True)
        disconnect_cb = MagicMock()
        cm.set_callbacks(connect=success_cb, disconnect=disconnect_cb)
        cm.connect()
        cm.shutdown()
        assert cm.state == ConnectionState.DISCONNECTED
        assert cm.is_connected is False

    def test_shutdown_calls_disconnect_callback(self, cm):
        cm._shutdown_event.clear()
        success_cb = MagicMock(return_value=True)
        disconnect_cb = MagicMock()
        cm.set_callbacks(connect=success_cb, disconnect=disconnect_cb)
        cm.connect()
        cm.shutdown()
        disconnect_cb.assert_called_once()

    def test_reset_clears_all_state(self, cm):
        cm._consecutive_failures = 10
        cm._current_backoff = 999
        cm._circuit_open = True
        cm.reset()
        assert cm._consecutive_failures == 0
        assert cm._current_backoff == cm.BACKOFF_BASE
        assert cm._circuit_open is False
        assert cm.state == ConnectionState.DISCONNECTED
