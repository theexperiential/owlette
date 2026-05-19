"""
Watchdog state persistence — restart budget and history for the stuck-connection
self-restart feature (see connection_manager._check_self_restart).

Stored at:
  C:\\ProgramData\\Owlette\\tmp\\watchdog_budget.owlette_service.json
  C:\\ProgramData\\Owlette\\tmp\\watchdog_history.owlette_service.json

Two files, two concerns:

  budget  — rolling timestamp list for rate-limiting self-restarts. Prevents
            restart-loop pathologies when the underlying issue isn't
            environmental (e.g. revoked token, deleted project).

  history — append-only record of recent restart diagnostic snapshots, capped
            at 10 entries. Entries without a 'submitted_at' field are pending
            Firestore submission; owlette_service flushes them on next connect.

Both files are namespaced (.owlette_service.json suffix) so future multi-
instance deployments (Cortex MCP etc.) don't collide.

Depends only on shared_utils and stdlib — no firebase, no logging config
dependencies.
"""

import json
import logging
import os
import threading
import time
from typing import Optional

import shared_utils

BUDGET_PATH = shared_utils.get_data_path('tmp/watchdog_budget.owlette_service.json')
HISTORY_PATH = shared_utils.get_data_path('tmp/watchdog_history.owlette_service.json')

SCHEMA_VERSION = 1

# Sanitise timestamps on read: drop "clearly wrong" values caused by clock skew
# or NTP corrections. 300s into the future is absurd; 24h ago is past our
# longest meaningful window and any entry that old is noise.
_FUTURE_TS_TOLERANCE_SECONDS = 300
_ANCIENT_TS_HORIZON_SECONDS = 86400

# Hard cap on history entries — last N wins. Keeps the file bounded even if
# the budget allows more restarts than we can flush to Firestore.
_HISTORY_MAX_ENTRIES = 10

# Module-level lock serializes read-modify-write from the watchdog thread and
# the deferred-submission path in the main service loop.
_budget_lock = threading.Lock()
_history_lock = threading.Lock()


# =============================================================================
# Budget — rolling-window rate limiter for self-restarts
# =============================================================================

def read_budget() -> dict:
    """Read the current budget state. Sanitises the timestamp list on read."""
    with _budget_lock:
        return _read_budget_unlocked()


def consume_budget(config: dict) -> bool:
    """Attempt to consume one restart slot.

    Returns True if the restart is allowed (and records the timestamp),
    False if the budget is exhausted or the write failed.

    Fail-closed: if we can't persist the increment, we refuse the restart so
    we don't lose accounting and spiral into a restart loop.

    Args:
        config: {'max_per_window': int, 'window_seconds': int}
    """
    max_per_window = int(config.get('max_per_window', 3))
    window_seconds = int(config.get('window_seconds', 3600))

    with _budget_lock:
        state = _read_budget_unlocked()
        now = time.time()
        recent = _prune_window(state['restarts'], now, window_seconds)

        if len(recent) >= max_per_window:
            return False

        recent.append(now)
        state['restarts'] = recent
        return _write_budget_unlocked(state)


def _read_budget_unlocked() -> dict:
    state = _read_json_or_empty(BUDGET_PATH, {'schema': SCHEMA_VERSION, 'restarts': []})
    state = _migrate_budget(state)
    state['restarts'] = _sanitise_timestamps(state.get('restarts', []))
    return state


def _write_budget_unlocked(state: dict) -> bool:
    return _atomic_write(BUDGET_PATH, {
        'schema': SCHEMA_VERSION,
        'restarts': state.get('restarts', []),
    })


def _prune_window(timestamps: list, now: float, window_seconds: int) -> list:
    cutoff = now - window_seconds
    return [ts for ts in timestamps if ts > cutoff]


def _sanitise_timestamps(timestamps: list) -> list:
    """Drop clearly wrong timestamps (future or ancient) caused by clock skew."""
    now = time.time()
    future_cutoff = now + _FUTURE_TS_TOLERANCE_SECONDS
    ancient_cutoff = now - _ANCIENT_TS_HORIZON_SECONDS
    sane = []
    dropped = 0
    for ts in timestamps:
        if not isinstance(ts, (int, float)):
            dropped += 1
            continue
        if ts > future_cutoff or ts < ancient_cutoff:
            dropped += 1
            continue
        sane.append(float(ts))
    if dropped:
        logging.warning(f"watchdog_state: dropped {dropped} out-of-range timestamp(s) from budget (clock skew?)")
    return sane


def _migrate_budget(state: dict) -> dict:
    """Schema migration helper — explicit branching for future versions."""
    version = state.get('schema', 1)
    if version == 1:
        return state
    logging.warning(f"watchdog_state: unknown budget schema v{version}; resetting")
    return {'schema': SCHEMA_VERSION, 'restarts': []}


# =============================================================================
# History — append-only snapshot log for deferred Firestore submission
# =============================================================================

def append_history(snapshot: dict) -> bool:
    """Append a restart snapshot to history. Caps at _HISTORY_MAX_ENTRIES.

    Snapshot should include a 'restart_id' field for correlation with
    Firestore submission. Returns True on successful write.
    """
    with _history_lock:
        state = _read_history_unlocked()
        entries = state.get('entries', [])
        entries.append(snapshot)
        # Keep the last N; drop oldest.
        if len(entries) > _HISTORY_MAX_ENTRIES:
            entries = entries[-_HISTORY_MAX_ENTRIES:]
        state['entries'] = entries
        return _write_history_unlocked(state)


def read_pending_history() -> list:
    """Return snapshot entries that haven't been submitted to Firestore yet."""
    with _history_lock:
        state = _read_history_unlocked()
        return [e for e in state.get('entries', []) if not e.get('submitted_at')]


def mark_submitted(restart_id: str, log_id: Optional[str] = None) -> bool:
    """Mark a history entry as submitted. Idempotent — safe to call twice."""
    with _history_lock:
        state = _read_history_unlocked()
        entries = state.get('entries', [])
        changed = False
        for entry in entries:
            if entry.get('restart_id') == restart_id and not entry.get('submitted_at'):
                entry['submitted_at'] = int(time.time())
                if log_id:
                    entry['log_id'] = log_id
                changed = True
        if not changed:
            return True
        state['entries'] = entries
        return _write_history_unlocked(state)


def _read_history_unlocked() -> dict:
    state = _read_json_or_empty(HISTORY_PATH, {'schema': SCHEMA_VERSION, 'entries': []})
    state = _migrate_history(state)
    return state


def _write_history_unlocked(state: dict) -> bool:
    return _atomic_write(HISTORY_PATH, {
        'schema': SCHEMA_VERSION,
        'entries': state.get('entries', []),
    })


def _migrate_history(state: dict) -> dict:
    version = state.get('schema', 1)
    if version == 1:
        return state
    logging.warning(f"watchdog_state: unknown history schema v{version}; resetting")
    return {'schema': SCHEMA_VERSION, 'entries': []}


# =============================================================================
# Shared file-I/O helpers (private)
# =============================================================================

def _read_json_or_empty(path: str, empty: dict) -> dict:
    if not os.path.exists(path):
        return dict(empty)
    try:
        with open(path, 'r') as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError(f"{os.path.basename(path)} is not an object")
        return data
    except (json.JSONDecodeError, ValueError, OSError) as e:
        logging.warning(f"{os.path.basename(path)} is corrupt ({e}); resetting")
        try:
            os.remove(path)
        except OSError:
            pass
        return dict(empty)


def _atomic_write(path: str, state: dict) -> bool:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp_path = path + '.tmp'
        with open(tmp_path, 'w') as f:
            json.dump(state, f, indent=2)
        os.replace(tmp_path, path)
        return True
    except OSError as e:
        logging.error(f"Failed to write {os.path.basename(path)}: {e}")
        return False
