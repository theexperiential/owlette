"""
Session state persistence — tracks the agent's "alive heartbeat" and intended
shutdown reason across service restarts and OS reboots.

Stored at: C:\\ProgramData\\Owlette\\tmp\\session_state.json (alongside the
other agent runtime state files: app_states.json, reboot_state.json).

Used by the startup classifier in owlette_service.py to distinguish:
  - Owlette-initiated reboots/shutdowns         -> silent
  - External clean shutdowns                    -> external_reboot warning
                                                   (operator restart, Windows Update, etc.)
  - No-signal restarts                          -> unexpected_reboot warning
                                                   (BSOD, power loss, hard reset)
  - Service-only restarts without intent        -> unexpected_service_restart warning
                                                   (NSSM auto-restart after crash, kill, OOM)

Designed to be importable from any agent context (service main loop, metrics
thread, signal handler, prompt_restart user-space dialog) — depends only on
shared_utils and stdlib. No firebase, no logging config dependencies.
"""

import json
import logging
import os
import threading
import time
from typing import Optional

import shared_utils

STATE_PATH = shared_utils.get_data_path('tmp/session_state.json')

SCHEMA_VERSION = 1

# Module-level lock serializes read-modify-write across the metrics thread,
# the main service loop, and the Windows console signal handler thread.
_lock = threading.Lock()


def read_state() -> Optional[dict]:
    """Read session state from disk.

    Returns the parsed dict, or None if the file is missing or corrupt
    (corrupt files are deleted so subsequent writes start clean).
    """
    with _lock:
        return _read_state_unlocked()


def _read_state_unlocked() -> Optional[dict]:
    if not os.path.exists(STATE_PATH):
        return None
    try:
        with open(STATE_PATH, 'r') as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError('session_state.json is not an object')
        return data
    except (json.JSONDecodeError, ValueError, OSError) as e:
        logging.warning(f"session_state.json is corrupt ({e}); resetting")
        try:
            os.remove(STATE_PATH)
        except OSError:
            pass
        return None


def _write_state_unlocked(state: dict) -> bool:
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        # Write to a temp file then rename — atomic on Windows for same-volume renames.
        tmp_path = STATE_PATH + '.tmp'
        with open(tmp_path, 'w') as f:
            json.dump(state, f, indent=2)
        os.replace(tmp_path, STATE_PATH)
        return True
    except OSError as e:
        logging.error(f"Failed to write session_state.json: {e}")
        return False


def init_session(version: str, boot_time: int) -> bool:
    """Write a fresh session record for the current boot. Called once at startup."""
    state = {
        'schema': SCHEMA_VERSION,
        'boot_time': int(boot_time),
        'last_alive': int(time.time()),
        'version': version,
        'shutdown_intent': None,
    }
    with _lock:
        return _write_state_unlocked(state)


def update_alive() -> None:
    """Refresh the last_alive timestamp. Called from periodic heartbeat hooks.

    No-op if the state file is missing — init_session must be called first.
    """
    with _lock:
        state = _read_state_unlocked()
        if state is None:
            return
        state['last_alive'] = int(time.time())
        _write_state_unlocked(state)


def set_intent(intent: Optional[str]) -> None:
    """Set shutdown_intent. Called by reboot/shutdown handlers BEFORE issuing
    OS commands so the intent is durable even if the shutdown call hangs.

    Pass None to clear the intent (used by cancel-reboot when the OS cancel
    succeeded — see _handle_cancel_reboot).
    """
    with _lock:
        state = _read_state_unlocked()
        if state is None:
            return
        state['shutdown_intent'] = intent
        _write_state_unlocked(state)


def set_intent_if_none(intent: str) -> None:
    """Compare-and-set: only writes if shutdown_intent is currently None.

    Used by the Windows console control signal handler so that an Owlette
    intent set moments earlier by a reboot/shutdown handler is not clobbered
    by the signal handler firing during the OS shutdown countdown.
    """
    with _lock:
        state = _read_state_unlocked()
        if state is None:
            return
        if state.get('shutdown_intent') is not None:
            return
        state['shutdown_intent'] = intent
        _write_state_unlocked(state)
