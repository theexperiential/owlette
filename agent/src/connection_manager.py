"""
Connection Manager for Owlette Agent

Centralized connection state management implementing industry-standard patterns:
- State Machine: DISCONNECTED -> CONNECTING -> CONNECTED (with RECONNECTING, BACKOFF states)
- Circuit Breaker: Prevents hammering server during outages
- Thread Supervision: Watchdog monitors and restarts dead worker threads
- Exponential Backoff with Jitter: Prevents thundering herd problem
- Single Reconnection Queue: No duplicate reconnection attempts

This module is the SINGLE SOURCE OF TRUTH for connection state.
All components report errors through this manager, and it coordinates recovery.

Usage:
    from connection_manager import ConnectionManager, ConnectionState

    # Create manager
    conn_mgr = ConnectionManager(logger)

    # Set callbacks
    conn_mgr.set_callbacks(connect=do_connect, disconnect=do_disconnect)

    # Register supervised threads
    conn_mgr.register_thread("command_listener", lambda: Thread(target=cmd_loop))

    # Start
    conn_mgr.connect()
    conn_mgr.start_watchdog()

    # Report errors from any component
    conn_mgr.report_error(exception, "Metrics upload failed")

    # Report success to reset failure counters
    conn_mgr.report_success()
"""

import datetime
import os
import threading
import time
import random
import socket
import logging
import uuid
from enum import Enum, auto
from typing import Callable, Optional, List, Dict, Any, Tuple
from dataclasses import dataclass, field

import shared_utils
import watchdog_state


# =============================================================================
# Self-restart watchdog config + enums
# =============================================================================

# v1 reason code enum — closed set. Extend via new constants, don't reuse values.
REASON_CONNECTION_STUCK = "connection_stuck"

# Defaults used if config.json is missing the watchdog section or keys.
WATCHDOG_DEFAULTS = {
    "enabled": True,
    "thresholds": {"failure_seconds": 360, "boot_grace_seconds": 180},
    "budget": {"max_per_window": 3, "window_seconds": 3600},
    "preconditions": {"require_internet": True, "fatal_error_suppression_seconds": 3600},
}

# Config re-read TTL inside the watchdog — keeps remote kill-switch responsive
# without hammering the cross-process config lock every 10s.
_WATCHDOG_CONFIG_TTL_SECONDS = 60.0

# Sentinel file: touch this to disable the watchdog without restarting the
# service. Checked every watchdog cycle; belt-and-braces for when config sync
# itself is broken.
_EMERGENCY_SENTINEL_PATH = shared_utils.get_data_path('tmp/watchdog_disabled')
_EMERGENCY_ENV_VAR = "OWLETTE_DISABLE_WATCHDOG_RESTART"

# Budget-exhaustion log throttling — avoid spamming the log file every 10s
# forever once the budget is used up.
_BUDGET_EXHAUSTED_LOG_THROTTLE_SECONDS = 3600.0


@dataclass
class RestartDecision:
    """Result of _should_restart() pure function."""
    should_fire: bool
    reason_code: Optional[str] = None
    detail: str = ""


def _should_restart(
    now_mono: float,
    last_success_mono: Optional[float],
    process_start_mono: float,
    last_fatal_mono: Optional[float],
    config: dict,
) -> RestartDecision:
    """Pure decision function — no I/O, no clock reads.

    Caller supplies all timing inputs so this is deterministically testable.
    Does NOT check internet, budget, or reboot state — those have side effects
    and are evaluated separately in _check_self_restart.

    Returns a RestartDecision with should_fire=True only when the time-since-
    last-success threshold has been exceeded AND the boot grace has elapsed
    AND no recent fatal error has been suppressing retries.
    """
    if not config.get('enabled', True):
        return RestartDecision(False, detail="disabled by config")

    thresholds = config.get('thresholds', {})
    preconditions = config.get('preconditions', {})
    failure_seconds = float(thresholds.get('failure_seconds', 360))
    boot_grace_seconds = float(thresholds.get('boot_grace_seconds', 180))
    fatal_suppress_seconds = float(preconditions.get('fatal_error_suppression_seconds', 3600))

    # Boot grace — based on process uptime (monotonic), not system uptime.
    # psutil.boot_time() is wall-clock and vulnerable to NTP corrections.
    process_uptime = now_mono - process_start_mono
    if process_uptime < boot_grace_seconds:
        return RestartDecision(False, detail=f"in boot grace ({process_uptime:.0f}s < {boot_grace_seconds:.0f}s)")

    # Fatal-error suppression — if we recently saw an error fingerprint that
    # a restart won't fix (revoked token, deleted project), don't churn.
    if last_fatal_mono is not None:
        fatal_age = now_mono - last_fatal_mono
        if fatal_age < fatal_suppress_seconds:
            return RestartDecision(False, detail=f"fatal-error suppression ({fatal_age:.0f}s < {fatal_suppress_seconds:.0f}s)")

    # "Time since last success" check.
    # Never-connected case: last_success_mono is None. Use process start as the
    # reference so a process that can't connect at all still fires (once the
    # boot grace passes), recovering from cold-boot stuck states.
    reference_mono = last_success_mono if last_success_mono is not None else process_start_mono
    seconds_since_success = now_mono - reference_mono
    if seconds_since_success < failure_seconds:
        return RestartDecision(False, detail=f"below threshold ({seconds_since_success:.0f}s < {failure_seconds:.0f}s)")

    return RestartDecision(True, reason_code=REASON_CONNECTION_STUCK,
                           detail=f"{seconds_since_success:.0f}s since last success")


def _emergency_kill_active() -> bool:
    """Check env var + sentinel file. Cheap; called every watchdog cycle."""
    if os.environ.get(_EMERGENCY_ENV_VAR) == "1":
        return True
    try:
        if os.path.exists(_EMERGENCY_SENTINEL_PATH):
            return True
    except OSError:
        pass
    return False


def _merge_watchdog_config(user_cfg: Optional[dict]) -> dict:
    """Merge user config over defaults, one level deep for nested groups."""
    cfg = {k: (v.copy() if isinstance(v, dict) else v) for k, v in WATCHDOG_DEFAULTS.items()}
    if not user_cfg:
        return cfg
    for key, default_value in WATCHDOG_DEFAULTS.items():
        user_value = user_cfg.get(key)
        if user_value is None:
            continue
        if isinstance(default_value, dict) and isinstance(user_value, dict):
            merged = default_value.copy()
            merged.update(user_value)
            cfg[key] = merged
        else:
            cfg[key] = user_value
    return cfg


class ConnectionState(Enum):
    """
    Connection state machine states.

    State transitions:
        DISCONNECTED -> CONNECTING (initial connect)
        CONNECTING -> CONNECTED (success) or DISCONNECTED (failure)
        CONNECTED -> RECONNECTING (error detected)
        RECONNECTING -> BACKOFF (need to wait) or CONNECTED (success)
        BACKOFF -> RECONNECTING (backoff complete)
        Any -> FATAL_ERROR (unrecoverable error)
    """
    DISCONNECTED = auto()      # Not connected, not actively trying
    CONNECTING = auto()        # Initial connection attempt in progress
    CONNECTED = auto()         # Fully operational
    RECONNECTING = auto()      # Lost connection, attempting recovery
    BACKOFF = auto()           # Waiting before next reconnect attempt
    FATAL_ERROR = auto()       # Unrecoverable error (e.g., machine removed from site)


@dataclass
class ConnectionEvent:
    """Event dispatched on state changes for listeners."""
    old_state: ConnectionState
    new_state: ConnectionState
    reason: str
    timestamp: float = field(default_factory=time.time)


class ConnectionManager:
    """
    Centralized connection state management for Owlette agent.

    Responsibilities:
    - Single source of truth for connection state
    - Coordinates all reconnection attempts (prevents duplicates)
    - Supervises worker threads (restarts dead threads)
    - Dispatches state change events to listeners
    - Implements circuit breaker pattern
    - Manages exponential backoff with jitter

    Thread Safety:
    - All state changes are protected by _state_lock (RLock for reentrant access)
    - Reconnection coordination uses _reconnect_lock
    - Event dispatch happens outside locks to prevent deadlocks
    """

    # =========================================================================
    # Configuration Constants
    # =========================================================================

    # Backoff configuration
    BACKOFF_BASE = 30.0           # Initial backoff: 30 seconds
    BACKOFF_MAX = 3600.0          # Maximum backoff: 1 hour - ALWAYS keep trying!
    BACKOFF_JITTER = 0.5          # Jitter range: 50-100% of calculated wait

    # Circuit breaker configuration
    FAILURE_THRESHOLD = 5         # Consecutive failures before circuit opens
    RECOVERY_TIMEOUT = 300.0      # 5 minutes before testing recovery

    # "Fatal" error backoff - use longer backoff but NEVER stop trying
    FATAL_ERROR_BACKOFF = 3600.0  # 1 hour backoff for "fatal" errors, but still retry

    # Watchdog configuration
    WATCHDOG_INTERVAL = 10.0      # Check thread health every 10 seconds

    # Internet connectivity check
    CONNECTIVITY_TIMEOUT = 3.0    # Socket timeout for connectivity check
    CONNECTIVITY_HOSTS = [        # Hosts to check for internet (Google DNS, Cloudflare DNS)
        ("8.8.8.8", 53),
        ("1.1.1.1", 53),
    ]

    def __init__(self, logger: Optional[logging.Logger] = None):
        """
        Initialize the connection manager.

        Args:
            logger: Logger instance. If None, creates a new logger.
        """
        self.logger = logger or logging.getLogger(__name__)

        # =====================================================================
        # State Management
        # =====================================================================
        self._state = ConnectionState.DISCONNECTED
        self._state_lock = threading.RLock()  # RLock for reentrant access
        self._state_reason = "Not started"

        # =====================================================================
        # Backoff Tracking
        # =====================================================================
        self._consecutive_failures = 0
        self._last_attempt_time = 0.0
        self._current_backoff = self.BACKOFF_BASE

        # =====================================================================
        # Circuit Breaker
        # =====================================================================
        self._circuit_open = False
        self._circuit_opened_at = 0.0

        # =====================================================================
        # Thread Supervision
        # =====================================================================
        self._supervised_threads: Dict[str, threading.Thread] = {}
        self._thread_factories: Dict[str, Callable[[], threading.Thread]] = {}
        self._watchdog_thread: Optional[threading.Thread] = None
        self._shutdown_event = threading.Event()
        self._thread_supervision_enabled = False  # Set True by enable_thread_supervision()

        # =====================================================================
        # Event Listeners
        # =====================================================================
        self._state_listeners: List[Callable[[ConnectionEvent], None]] = []
        self._listeners_lock = threading.Lock()

        # =====================================================================
        # Reconnection Coordination
        # =====================================================================
        self._reconnect_lock = threading.Lock()
        self._reconnect_in_progress = False
        self._reconnect_thread: Optional[threading.Thread] = None

        # =====================================================================
        # Callbacks (injected by FirebaseClient)
        # =====================================================================
        self._connect_callback: Optional[Callable[[], bool]] = None
        self._disconnect_callback: Optional[Callable[[], None]] = None
        self._on_connected_callback: Optional[Callable[[], None]] = None

        # =====================================================================
        # Self-restart watchdog state
        # =====================================================================
        # None until first reported success — distinguishes "never connected"
        # from "connected once, now stuck"
        self._last_success_time_mono: Optional[float] = None
        self._last_success_time_wall: Optional[float] = None
        # Process start anchors the boot-grace and the never-connected fallback
        self._process_start_time_mono: float = time.monotonic()
        self._process_start_time_wall: float = time.time()
        # Captured by report_error for inclusion in the diagnostic snapshot
        self._last_error_message: Optional[str] = None
        # Timestamp of last fatal-error fingerprint match — suppresses self-
        # restart when the failure is one that a restart can't fix
        self._last_fatal_error_time_mono: Optional[float] = None
        # Invoked by _check_self_restart when a restart is authorized
        self._restart_callback: Optional[Callable[[int, dict], None]] = None
        # 60s-TTL cache for the watchdog config section (see _read_watchdog_config)
        self._wd_config_cache: Optional[Tuple[float, dict]] = None
        # Throttle for the budget-exhausted log message
        self._budget_exhausted_last_log_mono: Optional[float] = None
        # One-shot flag for the budget_exhausted Firestore event
        self._budget_exhausted_event_emitted: bool = False

        self.logger.debug("ConnectionManager initialized")

    # =========================================================================
    # Properties
    # =========================================================================

    @property
    def state(self) -> ConnectionState:
        """Current connection state (thread-safe read)."""
        with self._state_lock:
            return self._state

    @property
    def state_reason(self) -> str:
        """Reason for current state (thread-safe read)."""
        with self._state_lock:
            return self._state_reason

    @property
    def is_connected(self) -> bool:
        """Check if fully connected and operational."""
        return self.state == ConnectionState.CONNECTED

    @property
    def is_operational(self) -> bool:
        """
        Check if operations can be attempted.

        Returns True for CONNECTED and RECONNECTING states,
        as we may still succeed during reconnection.
        """
        return self.state in (ConnectionState.CONNECTED, ConnectionState.RECONNECTING)

    @property
    def consecutive_failures(self) -> int:
        """Number of consecutive failures (for monitoring)."""
        return self._consecutive_failures

    @property
    def is_circuit_open(self) -> bool:
        """Check if circuit breaker is open."""
        return self._circuit_open

    # =========================================================================
    # Callback Registration
    # =========================================================================

    def set_callbacks(
        self,
        connect: Callable[[], bool],
        disconnect: Optional[Callable[[], None]] = None,
        on_connected: Optional[Callable[[], None]] = None
    ):
        """
        Register connection callbacks.

        Args:
            connect: Called to establish connection. Returns True on success.
            disconnect: Called during shutdown to cleanup resources.
            on_connected: Called after successful connection/reconnection.
        """
        self._connect_callback = connect
        self._disconnect_callback = disconnect
        self._on_connected_callback = on_connected
        self.logger.debug("Connection callbacks registered")

    def add_state_listener(self, listener: Callable[[ConnectionEvent], None]):
        """
        Register a callback for state changes.

        Listeners are called synchronously after state change,
        but outside of the state lock to prevent deadlocks.

        Args:
            listener: Function that receives ConnectionEvent
        """
        with self._listeners_lock:
            self._state_listeners.append(listener)
        self.logger.debug(f"State listener registered (total: {len(self._state_listeners)})")

    def remove_state_listener(self, listener: Callable[[ConnectionEvent], None]):
        """Remove a previously registered state listener."""
        with self._listeners_lock:
            if listener in self._state_listeners:
                self._state_listeners.remove(listener)

    def set_health_callback(self, callback: Callable[[str, str], None]):
        """
        Register a callback invoked when the connection enters a persistent
        failure state (BACKOFF or FATAL_ERROR).

        The callback receives (error_code: str, reason: str) and should update
        the service health state for IPC, Firestore, and remote alerting.

        Args:
            callback: Called with (error_code, reason) on BACKOFF/FATAL_ERROR transitions.
        """
        def _health_listener(event: ConnectionEvent):
            if event.new_state in (ConnectionState.BACKOFF, ConnectionState.FATAL_ERROR):
                error_code = (
                    'fatal_error' if event.new_state == ConnectionState.FATAL_ERROR
                    else 'connection_failure'
                )
                try:
                    callback(error_code, event.reason)
                except Exception as e:
                    self.logger.debug(f"Health callback error: {e}")

        self.add_state_listener(_health_listener)
        self.logger.debug("Health callback registered")

    def set_restart_callback(self, callback: Callable[[int, dict], None]):
        """Register callback for self-restart watchdog.

        Invoked when _check_self_restart decides the process should exit for
        self-recovery. The callback receives (exit_code: int, snapshot: dict)
        and is responsible for signalling a clean process exit that NSSM will
        auto-restart from.

        Args:
            callback: Called with (exit_code, diagnostic_snapshot)
        """
        self._restart_callback = callback
        self.logger.debug("Watchdog restart callback registered")

    # =========================================================================
    # State Management (Internal)
    # =========================================================================

    def _set_state(self, new_state: ConnectionState, reason: str):
        """
        Internal state transition with event dispatch.

        Thread-safe. Events are dispatched outside the lock.

        Args:
            new_state: New state to transition to
            reason: Human-readable reason for the transition
        """
        event = None

        with self._state_lock:
            old_state = self._state
            if old_state == new_state:
                # No change, but update reason
                self._state_reason = reason
                return

            self._state = new_state
            self._state_reason = reason

            # Log the transition
            log_msg = f"[CONNECTION] {old_state.name} -> {new_state.name}: {reason}"
            if new_state == ConnectionState.CONNECTED:
                self.logger.info(log_msg)
            elif new_state in (ConnectionState.DISCONNECTED, ConnectionState.FATAL_ERROR):
                self.logger.error(log_msg)
            else:
                self.logger.warning(log_msg)

            # Prepare event for dispatch
            event = ConnectionEvent(
                old_state=old_state,
                new_state=new_state,
                reason=reason
            )

        # Dispatch event outside lock to prevent deadlocks
        if event:
            self._dispatch_event(event)

    def _dispatch_event(self, event: ConnectionEvent):
        """Dispatch state change event to all listeners."""
        with self._listeners_lock:
            listeners = list(self._state_listeners)

        for listener in listeners:
            try:
                listener(event)
            except Exception as e:
                self.logger.error(f"State listener error: {e}")

    # =========================================================================
    # Connection Operations
    # =========================================================================

    def connect(self) -> bool:
        """
        Initial connection attempt.

        This is the entry point for establishing the first connection.
        Use report_error() for handling errors during operation.

        Returns:
            True if connected successfully, False otherwise.
        """
        if self.state == ConnectionState.CONNECTED:
            self.logger.debug("Already connected")
            return True

        if self.state == ConnectionState.FATAL_ERROR:
            self.logger.error("Cannot connect - in FATAL_ERROR state")
            return False

        self._set_state(ConnectionState.CONNECTING, "Initial connection")

        if self._try_connect():
            self._on_connect_success()
            return True
        else:
            self._on_connect_failure("Initial connection failed")
            return False

    def report_error(self, error: Exception, context: str = ""):
        """
        Report an error from any component.

        This is the SINGLE ENTRY POINT for error handling.
        All components should call this when they encounter connection errors.

        The manager will:
        1. Check if error is fatal (machine removed, auth revoked)
        2. Check circuit breaker state
        3. Trigger reconnection if appropriate

        Args:
            error: The exception that occurred
            context: Additional context about where the error occurred
        """
        error_str = str(error)
        full_context = f"{context}: {error_str}" if context else error_str

        self.logger.warning(f"[ERROR REPORTED] {full_context}")

        # Capture for watchdog diagnostic snapshot (truncated to avoid leaking
        # long tokens/project IDs into logs or Firestore)
        self._last_error_message = error_str[:500] if error_str else None

        # Check for "fatal" errors - these get longer backoff but we STILL retry
        if self._is_fatal_error(error):
            self.logger.warning(f"[FATAL-ISH ERROR] {full_context} - will retry in {self.FATAL_ERROR_BACKOFF}s")
            self._current_backoff = self.FATAL_ERROR_BACKOFF
            # Stamp for watchdog: suppress self-restart while a restart-can't-
            # fix-this error is live (revoked token, deleted project, etc.)
            self._last_fatal_error_time_mono = time.monotonic()
            # DON'T return - still trigger reconnection below!

        # Check circuit breaker
        if self._circuit_open:
            time_since_open = time.time() - self._circuit_opened_at
            if time_since_open > self.RECOVERY_TIMEOUT:
                self.logger.info(f"[CIRCUIT BREAKER] Testing recovery after {time_since_open:.0f}s")
                self._circuit_open = False
            else:
                remaining = self.RECOVERY_TIMEOUT - time_since_open
                self.logger.debug(f"[CIRCUIT BREAKER] Open, skipping reconnect ({remaining:.0f}s remaining)")
                return

        # Mark as disconnected if currently connected
        if self.state == ConnectionState.CONNECTED:
            self._set_state(ConnectionState.DISCONNECTED, full_context)

        # Trigger reconnection
        self._trigger_reconnect(full_context)

    def report_success(self):
        """
        Report successful operation.

        Call this after successful Firestore operations to reset
        failure counters and circuit breaker.
        """
        if self._consecutive_failures > 0:
            self.logger.debug(f"[SUCCESS] Resetting failure counter (was {self._consecutive_failures})")

        self._consecutive_failures = 0
        self._current_backoff = self.BACKOFF_BASE
        self._circuit_open = False

        # Stamp success timestamps for the self-restart watchdog.
        # Monotonic is authoritative for the "time since last success" check
        # (NTP-skew safe). Wall-clock is only used for diagnostic snapshots.
        self._last_success_time_mono = time.monotonic()
        self._last_success_time_wall = time.time()
        # A healthy connection is evidence the prior fatal error no longer applies
        self._last_fatal_error_time_mono = None
        # Reset the budget-exhausted one-shot so a later re-exhaustion re-fires
        self._budget_exhausted_event_emitted = False

        # Ensure state is CONNECTED if we're getting successes
        if self.state not in (ConnectionState.CONNECTED, ConnectionState.FATAL_ERROR):
            self._set_state(ConnectionState.CONNECTED, "Operation succeeded")

    def force_reconnect(self, reason: str = "Manual reconnect requested"):
        """
        Force an immediate reconnection attempt.

        Use sparingly - this bypasses normal backoff logic.

        Args:
            reason: Reason for the forced reconnect
        """
        self.logger.info(f"[FORCE RECONNECT] {reason}")

        # Reset backoff to allow immediate retry
        self._current_backoff = self.BACKOFF_BASE
        self._last_attempt_time = 0

        if self.state == ConnectionState.CONNECTED:
            self._set_state(ConnectionState.DISCONNECTED, reason)

        self._trigger_reconnect(reason)

    # =========================================================================
    # Reconnection Logic (Internal)
    # =========================================================================

    def _trigger_reconnect(self, reason: str):
        """
        Coordinate reconnection attempt.

        Uses a lock to prevent multiple simultaneous reconnection attempts.
        Runs the actual reconnection in a background thread.

        Args:
            reason: Reason for reconnection
        """
        with self._reconnect_lock:
            if self._reconnect_in_progress:
                self.logger.debug("[RECONNECT] Already in progress, skipping")
                return
            if self._shutdown_event.is_set():
                self.logger.debug("[RECONNECT] Shutdown in progress, skipping")
                return
            self._reconnect_in_progress = True

        # Run reconnection in background thread
        thread = threading.Thread(
            target=self._reconnect_sequence,
            args=(reason,),
            daemon=True,
            name="ConnectionManager-Reconnect"
        )
        thread.start()
        self._reconnect_thread = thread

    def _reconnect_sequence(self, reason: str):
        """
        Execute reconnection with backoff.

        This runs in a background thread and handles:
        1. Calculating and waiting for backoff
        2. Checking internet connectivity
        3. Attempting reconnection
        4. Updating state based on result

        Args:
            reason: Initial reason for reconnection
        """
        try:
            self._set_state(ConnectionState.RECONNECTING, reason)

            # Calculate backoff wait time
            wait_time = self._calculate_backoff_wait()
            if wait_time > 0:
                self._set_state(ConnectionState.BACKOFF, f"Waiting {wait_time:.0f}s before retry")
                self.logger.debug(f"[BACKOFF] Waiting {wait_time:.0f}s (attempt #{self._consecutive_failures + 1})")

                # Interruptible sleep
                if self._shutdown_event.wait(wait_time):
                    self.logger.debug("[RECONNECT] Interrupted by shutdown")
                    return

            self._set_state(ConnectionState.RECONNECTING, "Attempting reconnection")
            self._last_attempt_time = time.time()

            # Check internet connectivity first
            if not self._check_internet():
                self._on_connect_failure("No internet connectivity")
                return

            # Attempt connection
            if self._try_connect():
                self._on_connect_success()
            else:
                self._on_connect_failure("Reconnection attempt failed")

        except Exception as e:
            self.logger.error(f"[RECONNECT] Unexpected error: {e}")
            self._on_connect_failure(f"Unexpected error: {e}")
        finally:
            with self._reconnect_lock:
                self._reconnect_in_progress = False

    def _try_connect(self) -> bool:
        """
        Execute actual connection via callback.

        Returns:
            True if connection succeeded, False otherwise.
        """
        if not self._connect_callback:
            self.logger.error("[CONNECT] No connect callback registered")
            return False

        try:
            result = self._connect_callback()
            if result:
                self.logger.debug("[CONNECT] Callback returned success")
            else:
                self.logger.warning("[CONNECT] Callback returned failure")
            return result
        except Exception as e:
            self.logger.error(f"[CONNECT] Callback raised exception: {e}")
            return False

    def _on_connect_success(self):
        """Handle successful connection."""
        self._consecutive_failures = 0
        self._current_backoff = self.BACKOFF_BASE
        self._circuit_open = False

        # Stamp for watchdog — a successful reconnect counts as "alive"
        self._last_success_time_mono = time.monotonic()
        self._last_success_time_wall = time.time()
        self._last_fatal_error_time_mono = None
        self._budget_exhausted_event_emitted = False

        self._set_state(ConnectionState.CONNECTED, "Connection established")

        # Only restart supervised threads if supervision is enabled
        # This prevents threads from starting before the service is ready
        if self._thread_supervision_enabled:
            self._restart_all_threads()
        else:
            self.logger.debug("[CONNECT] Thread supervision not yet enabled, skipping thread restart")

        # Call on_connected callback
        if self._on_connected_callback:
            try:
                self._on_connected_callback()
            except Exception as e:
                self.logger.error(f"[CONNECT] on_connected callback error: {e}")

    def _on_connect_failure(self, reason: str):
        """
        Handle failed connection attempt.

        Increments failure counter, updates backoff, checks circuit breaker,
        and schedules next attempt.

        Args:
            reason: Reason for the failure
        """
        self._consecutive_failures += 1
        self._current_backoff = min(
            self._current_backoff * 2,
            self.BACKOFF_MAX
        )

        # Check circuit breaker threshold
        if self._consecutive_failures >= self.FAILURE_THRESHOLD:
            if not self._circuit_open:
                self._circuit_open = True
                self._circuit_opened_at = time.time()
                self.logger.warning(
                    f"[CIRCUIT BREAKER] OPEN after {self._consecutive_failures} failures. "
                    f"Recovery test in {self.RECOVERY_TIMEOUT:.0f}s"
                )

        self._set_state(
            ConnectionState.DISCONNECTED,
            f"{reason} (attempt #{self._consecutive_failures})"
        )

        # Schedule next attempt (if not shutdown)
        if not self._shutdown_event.is_set():
            self._trigger_reconnect(f"Retry after failure #{self._consecutive_failures}")

    def _calculate_backoff_wait(self) -> float:
        """
        Calculate wait time with jitter.

        Uses exponential backoff with 50-100% jitter to prevent
        thundering herd when multiple agents reconnect simultaneously.

        Returns:
            Wait time in seconds (0 if no wait needed).
        """
        elapsed = time.time() - self._last_attempt_time
        base_wait = self._current_backoff - elapsed

        if base_wait <= 0:
            return 0

        # Add jitter: 50% to 100% of base wait
        jitter_factor = self.BACKOFF_JITTER + random.random() * self.BACKOFF_JITTER
        return base_wait * jitter_factor

    def _check_internet(self) -> bool:
        """
        Quick internet connectivity check.

        Tries multiple DNS servers to verify internet access.

        Returns:
            True if internet is available, False otherwise.
        """
        for host, port in self.CONNECTIVITY_HOSTS:
            try:
                with socket.create_connection(
                    (host, port),
                    timeout=self.CONNECTIVITY_TIMEOUT
                ) as sock:
                    pass
                self.logger.debug(f"[INTERNET] Connectivity confirmed via {host}")
                return True
            except OSError:
                continue

        self.logger.warning("[INTERNET] No connectivity detected")
        return False

    # =========================================================================
    # Fatal Error Handling
    # =========================================================================

    def _is_fatal_error(self, error: Exception) -> bool:
        """
        Check if error is unrecoverable.

        Fatal errors include:
        - Machine removed from site
        - Site not found
        - Permanent permission denied
        - Account disabled

        Args:
            error: The exception to check

        Returns:
            True if error is fatal, False otherwise.
        """
        error_str = str(error).lower()

        fatal_indicators = [
            "machine not found",
            "machine has been removed",
            "site not found",
            "permission denied",
            "not authorized",
            "account disabled",
            "credential revoked",
            "invalid_grant",  # OAuth token permanently invalid
        ]

        return any(indicator in error_str for indicator in fatal_indicators)

    def _handle_fatal_error(self, error: Exception):
        """
        Handle serious errors that may indicate configuration problems.

        Previously this would permanently disable reconnection, but now
        we ALWAYS keep trying (with longer backoff). The user/admin may
        need to re-register, but we won't give up automatically.

        Args:
            error: The serious exception
        """
        self.logger.warning(f"[SERIOUS ERROR] {error}")
        self.logger.warning("[SERIOUS ERROR] Will keep retrying every hour - may need re-registration")
        # NOTE: We do NOT set shutdown_event - always keep trying!

    # =========================================================================
    # Thread Supervision
    # =========================================================================

    def register_thread(
        self,
        name: str,
        factory: Callable[[], threading.Thread]
    ):
        """
        Register a thread to be supervised.

        The factory is called to create/restart the thread when needed.
        Threads are automatically restarted if they die while connected.

        Args:
            name: Unique name for the thread
            factory: Callable that creates and returns the thread (NOT started)
        """
        self._thread_factories[name] = factory
        self.logger.debug(f"[SUPERVISOR] Registered thread: {name}")

    def unregister_thread(self, name: str):
        """Remove a thread from supervision."""
        if name in self._thread_factories:
            del self._thread_factories[name]
        if name in self._supervised_threads:
            del self._supervised_threads[name]

    def _restart_all_threads(self):
        """Restart all supervised threads after successful connection."""
        for name, factory in self._thread_factories.items():
            self._restart_thread(name, factory)

    def _restart_thread(self, name: str, factory: Callable[[], threading.Thread]):
        """
        Restart a single supervised thread.

        Args:
            name: Thread name
            factory: Callable that creates the thread
        """
        # Check if thread is already running
        existing = self._supervised_threads.get(name)
        if existing and existing.is_alive():
            self.logger.debug(f"[SUPERVISOR] Thread {name} already running")
            return

        # Wait briefly for old thread to finish
        if existing:
            try:
                existing.join(timeout=1.0)
            except Exception:
                pass

        # Create and start new thread
        try:
            thread = factory()
            thread.name = f"Supervised-{name}"
            thread.daemon = True
            thread.start()
            self._supervised_threads[name] = thread
            self.logger.debug(f"[SUPERVISOR] Started thread: {name}")
        except Exception as e:
            self.logger.error(f"[SUPERVISOR] Failed to start thread {name}: {e}")

    def enable_thread_supervision(self):
        """
        Enable thread supervision.

        Call this after the service is ready to run threads.
        This must be called before start_watchdog() to ensure
        threads are started at the right time.
        """
        self._thread_supervision_enabled = True
        self.logger.debug("[SUPERVISOR] Thread supervision enabled")

        # If already connected, start threads now
        if self.state == ConnectionState.CONNECTED:
            self._restart_all_threads()

    def start_watchdog(self):
        """
        Start the thread supervision watchdog.

        The watchdog monitors supervised threads and triggers
        reconnection if any thread dies unexpectedly.

        Note: This automatically enables thread supervision.
        """
        # Enable thread supervision when watchdog starts
        if not self._thread_supervision_enabled:
            self.enable_thread_supervision()

        if self._watchdog_thread and self._watchdog_thread.is_alive():
            self.logger.debug("[WATCHDOG] Already running")
            return

        self._watchdog_thread = threading.Thread(
            target=self._watchdog_loop,
            daemon=True,
            name="ConnectionManager-Watchdog"
        )
        self._watchdog_thread.start()
        self.logger.debug("[WATCHDOG] Started")

    def _watchdog_loop(self):
        """
        Monitor supervised threads and restart if dead.

        Runs in a background thread, checking thread health
        at regular intervals.
        """
        self.logger.debug("[WATCHDOG] Loop started")

        while not self._shutdown_event.is_set():
            try:
                if self.state == ConnectionState.CONNECTED:
                    dead_threads = []

                    for name, thread in list(self._supervised_threads.items()):
                        if not thread.is_alive():
                            dead_threads.append(name)

                    if dead_threads:
                        self.logger.warning(
                            f"[WATCHDOG] Dead threads detected: {dead_threads}"
                        )
                        # Report as error to trigger reconnection
                        self.report_error(
                            Exception(f"Supervised threads died: {dead_threads}"),
                            context="Watchdog"
                        )

                # Self-restart check runs regardless of state — the whole point
                # is to catch cases where we're NOT reaching CONNECTED.
                self._check_self_restart()

            except Exception as e:
                self.logger.error(f"[WATCHDOG] Error: {e}")

            # Wait for next check (interruptible)
            self._shutdown_event.wait(self.WATCHDOG_INTERVAL)

        self.logger.debug("[WATCHDOG] Loop exited")

    # =========================================================================
    # Self-Restart Watchdog
    # =========================================================================

    def _read_watchdog_config(self) -> dict:
        """Read the watchdog config section, cached for 60s to cut lock churn."""
        now_mono = time.monotonic()
        if self._wd_config_cache is not None:
            cached_at, cached_cfg = self._wd_config_cache
            if now_mono - cached_at < _WATCHDOG_CONFIG_TTL_SECONDS:
                return cached_cfg
        try:
            raw = shared_utils.read_config(['watchdog']) or {}
        except Exception as e:
            self.logger.debug(f"[WATCHDOG] config read failed, using defaults: {e}")
            raw = {}
        merged = _merge_watchdog_config(raw if isinstance(raw, dict) else {})
        self._wd_config_cache = (now_mono, merged)
        return merged

    def _build_snapshot(self, reason_code: str) -> dict:
        """Assemble the diagnostic snapshot used for restart logging and
        deferred Firestore submission.
        """
        snap = self.get_status(diagnostic=True)
        snap["reason_code"] = reason_code
        snap["restart_id"] = str(uuid.uuid4())
        snap["agent_version"] = getattr(shared_utils, "APP_VERSION", "unknown")
        try:
            snap["pid"] = os.getpid()
        except Exception:
            snap["pid"] = None
        return snap

    def _check_self_restart(self):
        """Evaluate whether to fire a self-restart this cycle.

        Ordering is deliberate: cheap checks first (config, emergency kill
        switch, pure decision), then expensive checks (internet, reboot state,
        budget consume). All I/O is wrapped so a failure here never takes down
        the watchdog thread.
        """
        try:
            config = self._read_watchdog_config()
            if not config.get('enabled', True):
                return
            if _emergency_kill_active():
                return

            decision = _should_restart(
                now_mono=time.monotonic(),
                last_success_mono=self._last_success_time_mono,
                process_start_mono=self._process_start_time_mono,
                last_fatal_mono=self._last_fatal_error_time_mono,
                config=config,
            )
            if not decision.should_fire:
                return

            # Expensive precondition checks only after pure logic clears
            if config.get('preconditions', {}).get('require_internet', True):
                if not self._check_internet():
                    self.logger.info("[WATCHDOG] Fire condition met but internet unreachable; skipping")
                    return

            # Scheduled OS reboot overlap — don't inject a service restart
            # while the reboot scheduler is driving a shutdown.
            try:
                import reboot_state  # lazy import to avoid cycles
                if reboot_state.read_state().get('attempt'):
                    self.logger.info("[WATCHDOG] Fire condition met but scheduled reboot in progress; skipping")
                    return
            except Exception as e:
                self.logger.debug(f"[WATCHDOG] reboot_state check failed (non-fatal): {e}")

            # Budget check + atomic consume. Fail-closed on write error.
            if not watchdog_state.consume_budget(config.get('budget', {})):
                self._handle_budget_exhausted(decision)
                return

            if self._restart_callback is None:
                self.logger.warning(
                    "[WATCHDOG] Fire condition met but no restart callback registered; skipping"
                )
                return

            snapshot = self._build_snapshot(decision.reason_code)
            try:
                watchdog_state.append_history(snapshot)
            except Exception as e:
                self.logger.error(f"[WATCHDOG] history append failed (non-fatal): {e}")

            self.logger.error(
                f"[WATCHDOG] Self-restart authorized: {decision.detail} — "
                f"invoking restart callback with exit code 43"
            )
            self._restart_callback(43, snapshot)
        except Exception as e:
            self.logger.error(f"[WATCHDOG] _check_self_restart error (non-fatal): {e}")

    def _handle_budget_exhausted(self, decision: RestartDecision):
        """Log once per window instead of every 10s; emit a one-shot Firestore
        event so the dashboard can see the agent is in 'wedged but alive' state.
        """
        now_mono = time.monotonic()
        # Throttled log
        last_log = self._budget_exhausted_last_log_mono
        if last_log is None or (now_mono - last_log) > _BUDGET_EXHAUSTED_LOG_THROTTLE_SECONDS:
            self.logger.error(
                "[WATCHDOG] Self-restart budget exhausted — running in degraded mode. "
                f"Detail: {decision.detail}. Normal reconnect retries continue; "
                "operator may re-enable via config or clear tmp/watchdog_disabled."
            )
            self._budget_exhausted_last_log_mono = now_mono

        # One-shot pending event (flushed by owlette_service on next connect)
        if not self._budget_exhausted_event_emitted:
            try:
                snapshot = self._build_snapshot(decision.reason_code or REASON_CONNECTION_STUCK)
                snapshot["event_kind"] = "watchdog_budget_exhausted"
                watchdog_state.append_history(snapshot)
                self._budget_exhausted_event_emitted = True
            except Exception as e:
                self.logger.debug(f"[WATCHDOG] budget_exhausted event persist failed: {e}")

    def get_thread_status(self) -> Dict[str, bool]:
        """
        Get status of all supervised threads.

        Returns:
            Dict mapping thread name to alive status.
        """
        return {
            name: thread.is_alive()
            for name, thread in self._supervised_threads.items()
        }

    # =========================================================================
    # Lifecycle
    # =========================================================================

    def shutdown(self):
        """
        Graceful shutdown.

        Signals all threads to stop, calls disconnect callback,
        and transitions to DISCONNECTED state.
        """
        self.logger.info("[SHUTDOWN] ConnectionManager shutting down")

        # Signal all threads to stop
        self._shutdown_event.set()

        # Call disconnect callback
        if self._disconnect_callback:
            try:
                self._disconnect_callback()
            except Exception as e:
                self.logger.error(f"[SHUTDOWN] Disconnect callback error: {e}")

        # Wait for watchdog to stop
        if self._watchdog_thread and self._watchdog_thread.is_alive():
            self._watchdog_thread.join(timeout=5.0)

        # Wait for any in-flight reconnect attempt
        if self._reconnect_thread and self._reconnect_thread.is_alive():
            self._reconnect_thread.join(timeout=5.0)

        self._set_state(ConnectionState.DISCONNECTED, "Shutdown complete")
        self.logger.info("[SHUTDOWN] Complete")

    def reset(self):
        """
        Reset manager to initial state.

        Use this for testing or when re-registering the agent.
        """
        self.logger.info("[RESET] Resetting ConnectionManager")

        self._shutdown_event.clear()
        self._consecutive_failures = 0
        self._current_backoff = self.BACKOFF_BASE
        self._last_attempt_time = 0
        self._circuit_open = False
        self._circuit_opened_at = 0

        with self._reconnect_lock:
            self._reconnect_in_progress = False

        self._set_state(ConnectionState.DISCONNECTED, "Reset")

    # =========================================================================
    # Status / Debugging
    # =========================================================================

    def get_status(self, diagnostic: bool = False) -> Dict[str, Any]:
        """
        Get comprehensive status for debugging/monitoring.

        Args:
            diagnostic: When True, includes self-restart watchdog fields
                (seconds_since_last_success, internet_check_tcp, last_error,
                process_uptime_s, restart_count_in_window, timestamp_utc).
                Used when building the snapshot before a watchdog restart.

        Returns:
            Dict with current state, backoff info, thread status, etc.
        """
        status = {
            "state": self.state.name,
            "state_reason": self._state_reason,
            "consecutive_failures": self._consecutive_failures,
            "current_backoff": self._current_backoff,
            "circuit_open": self._circuit_open,
            "circuit_opened_at": self._circuit_opened_at,
            "reconnect_in_progress": self._reconnect_in_progress,
            "shutdown_requested": self._shutdown_event.is_set(),
            "threads": self.get_thread_status(),
        }
        if diagnostic:
            now_mono = time.monotonic()
            if self._last_success_time_mono is not None:
                status["seconds_since_last_success"] = int(now_mono - self._last_success_time_mono)
            else:
                status["seconds_since_last_success"] = None  # never connected
            status["last_error"] = self._last_error_message
            status["process_uptime_s"] = int(now_mono - self._process_start_time_mono)
            status["timestamp_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            # Internet check is cheap (<3s) and directly relevant to diagnosis
            try:
                status["internet_check_tcp"] = self._check_internet()
            except Exception as e:
                status["internet_check_tcp"] = None
                self.logger.debug(f"diagnostic internet_check failed: {e}")
            # Budget count reflects recent self-restart pressure
            try:
                budget = watchdog_state.read_budget()
                status["restart_count_in_window"] = len(budget.get('restarts', []))
            except Exception as e:
                status["restart_count_in_window"] = None
                self.logger.debug(f"diagnostic budget read failed: {e}")
        return status

    def __repr__(self) -> str:
        return (
            f"ConnectionManager(state={self.state.name}, "
            f"failures={self._consecutive_failures}, "
            f"circuit_open={self._circuit_open})"
        )
