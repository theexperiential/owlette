"""
Startup Health Probe for owlette Agent

Runs a series of pre-flight checks at service startup to detect common
failure modes before any network or Firebase initialization is attempted.

Design constraints:
- Stdlib imports ONLY (no circular deps, no pywin32, no psutil)
- SecureStorage import is deferred and guarded with try/except
- Stops at first failure, returns partial results
- Never throws — always returns a HealthState

Checks performed (in order):
1. Config file readable and contains 'firebase' section
2. Secure token store accessible and has a refresh token
3. Network reachable (TCP connection to api_base host on port 443)

Also exposes wait_for_network() — the bounded network-ready gate the service
hosts run before constructing AuthManager / FirebaseClient.
"""

import json
import logging
import os
import socket
import time
from dataclasses import dataclass, field
from typing import Optional, Dict, Tuple


# Health status codes
STATUS_OK = 'ok'
STATUS_CONFIG_ERROR = 'config_error'
STATUS_AUTH_ERROR = 'auth_error'
STATUS_NETWORK_ERROR = 'network_error'

# TCP probe settings. Check 3 and wait_for_network() share one connect
# implementation so both agree on what "reachable" means.
NETWORK_PROBE_PORT = 443
NETWORK_PROBE_TIMEOUT = 5.0

# wait_for_network() retry cadence. The first gaps ramp quickly (a NIC that is
# nearly up is usually up within a few seconds), then settle at a flat 5s so a
# 90s budget costs a bounded number of probes.
NETWORK_GATE_MAX_WAIT = 90.0
_NETWORK_GATE_RAMP_DELAYS = (1.0, 2.0, 5.0)
_NETWORK_GATE_INTERVAL = 5.0


def extract_host(api_base: str) -> Optional[str]:
    """Extract the host (with port, if present) from a URL like https://owlette.app/api."""
    try:
        # Simple extraction without urllib to stay stdlib-light
        stripped = api_base.replace('https://', '').replace('http://', '')
        host = stripped.split('/')[0]
        return host if host else None
    except Exception:
        return None


def _tcp_connect(host: str,
                 port: int = NETWORK_PROBE_PORT,
                 timeout: float = NETWORK_PROBE_TIMEOUT) -> Tuple[bool, Optional[BaseException]]:
    """
    Attempt a TCP connection. Does NOT make an HTTP request — just tests that
    the socket can connect. Never raises.

    Returns:
        (ok, error) — error is the caught exception when ok is False.
    """
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
        sock.close()
        return True, None
    except Exception as e:
        return False, e


@dataclass
class HealthState:
    """Result of a startup health probe."""
    status: str                          # STATUS_* constant
    error_code: Optional[str]            # Same as status when not ok, else None
    error_message: Optional[str]         # Human-readable message for UI
    checked_at: int                      # Unix timestamp
    probe_results: Dict[str, Optional[bool]] = field(default_factory=dict)

    def is_ok(self) -> bool:
        return self.status == STATUS_OK

    def to_dict(self) -> dict:
        return {
            'status': self.status,
            'error_code': self.error_code,
            'error_message': self.error_message,
            'checked_at': self.checked_at,
            'probe_results': self.probe_results,
        }


class HealthProbe:
    """Runs startup health checks and returns a HealthState."""

    def __init__(self, config_path: str, api_base: str):
        self._config_path = config_path
        self._api_base = api_base.rstrip('/')

    def run(self) -> HealthState:
        """
        Run all startup checks in order. Stops at first failure.

        Returns:
            HealthState with status and per-check results.
        """
        probe_results: Dict[str, Optional[bool]] = {
            'config_readable': None,
            'firebase_section_present': None,
            'token_store_accessible': None,
            'network_reachable': None,
        }
        now = int(time.time())

        # --- Check 1: Config file ---
        config_ok, firebase_section_ok, config_msg = self._check_config()
        probe_results['config_readable'] = config_ok
        probe_results['firebase_section_present'] = firebase_section_ok

        if not config_ok:
            return HealthState(
                status=STATUS_CONFIG_ERROR,
                error_code=STATUS_CONFIG_ERROR,
                error_message=config_msg,
                checked_at=now,
                probe_results=probe_results,
            )

        if not firebase_section_ok:
            return HealthState(
                status=STATUS_CONFIG_ERROR,
                error_code=STATUS_CONFIG_ERROR,
                error_message=config_msg,
                checked_at=now,
                probe_results=probe_results,
            )

        # --- Check 2: Token store ---
        token_ok, token_msg = self._check_token_store()
        probe_results['token_store_accessible'] = token_ok

        if not token_ok:
            return HealthState(
                status=STATUS_AUTH_ERROR,
                error_code=STATUS_AUTH_ERROR,
                error_message=token_msg,
                checked_at=now,
                probe_results=probe_results,
            )

        # --- Check 3: Network ---
        network_ok, network_msg = self._check_network()
        probe_results['network_reachable'] = network_ok

        if not network_ok:
            return HealthState(
                status=STATUS_NETWORK_ERROR,
                error_code=STATUS_NETWORK_ERROR,
                error_message=network_msg,
                checked_at=now,
                probe_results=probe_results,
            )

        # All checks passed
        return HealthState(
            status=STATUS_OK,
            error_code=None,
            error_message=None,
            checked_at=now,
            probe_results=probe_results,
        )

    def _check_config(self):
        """
        Check that config.json exists, is valid JSON, and has a 'firebase' section.

        Returns:
            (config_ok: bool, firebase_section_ok: bool, message: str)
        """
        try:
            if not os.path.exists(self._config_path):
                return False, False, f"Config file not found: {self._config_path}"

            with open(self._config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)

        except json.JSONDecodeError as e:
            return False, False, f"Config file corrupted (invalid JSON): {e}"
        except PermissionError:
            return False, False, "Config file permission denied"
        except Exception as e:
            return False, False, f"Config file unreadable: {e}"

        if not isinstance(config, dict) or 'firebase' not in config:
            return True, False, (
                "Config missing 'firebase' section — agent is not registered. "
                "Please run the owlette installer again."
            )

        firebase = config.get('firebase', {})
        if not firebase.get('enabled') or not firebase.get('site_id'):
            # Firebase section present but disabled/no site — not an error per se,
            # but auth_error will be caught by the token check
            return True, True, ""

        return True, True, ""

    def _check_token_store(self):
        """
        Check that the secure token store is accessible and holds a refresh token.

        Imports SecureStorage inside try/except so a missing pywin32 (e.g. in
        test environments) gracefully returns False instead of crashing the probe.

        Returns:
            (ok: bool, message: str)
        """
        try:
            from secure_storage import get_storage
            storage = get_storage()
            has_token = storage.has_refresh_token()
        except ImportError:
            # pywin32 not available (test env) — skip check
            return True, ""
        except Exception as e:
            return False, f"Token store inaccessible: {e}"

        if not has_token:
            return False, (
                "No authentication token found. Agent is not registered with a site. "
                "Please run the owlette installer again."
            )

        return True, ""

    def _check_network(self):
        """
        Check network reachability via a TCP connection to the API host on port 443.
        Does NOT make an HTTP request — just tests that the socket can connect.

        Returns:
            (ok: bool, message: str)
        """
        host = self._extract_host(self._api_base)
        if not host:
            # Can't parse host — skip network check rather than false-fail
            return True, ""

        ok, error = _tcp_connect(host, NETWORK_PROBE_PORT, NETWORK_PROBE_TIMEOUT)
        if ok:
            return True, ""

        if not isinstance(error, OSError):
            # Unexpected error — don't block startup for a network probe failure
            return True, ""

        return False, (
            f"Network not reachable at startup (host: {host}). "
            f"Check internet connection. Error: {error}"
        )

    def _extract_host(self, api_base: str) -> Optional[str]:
        """Extract hostname from a URL like https://owlette.app/api."""
        return extract_host(api_base)


def reprobe_if_network_error(state: Optional[HealthState],
                             config_path: str,
                             api_base: str) -> Optional[HealthState]:
    """
    Re-run the startup probe after wait_for_network() reports the host reachable.

    The startup probe runs before the network gate, so on a cold boot it
    routinely records network_error moments before the NIC comes up — a
    snapshot the desktop surfaces then render for the rest of the uptime.
    Only a network_error verdict (or a missing state, when the probe itself
    crashed) is refreshed; config_error / auth_error / ok say something the
    gate's success cannot contradict, so those are returned unchanged.
    """
    if state is not None and state.status != STATUS_NETWORK_ERROR:
        return state
    return HealthProbe(config_path=config_path, api_base=api_base).run()


def wait_for_network(api_base: str,
                     max_wait: float = NETWORK_GATE_MAX_WAIT,
                     connect_timeout: float = NETWORK_PROBE_TIMEOUT) -> bool:
    """
    Block until the API host accepts a TCP connection on port 443, or the budget expires.

    Cold-booted machines routinely reach service start before the NIC has a
    usable route (DHCP lease, 802.1X, domain logon, Wi-Fi association). Building
    AuthManager / FirebaseClient in that window burns the first token refresh
    and arms a retry backoff for no reason, so the hosts spend the wait here —
    in one cheap TCP probe loop — instead.

    Retries at 1s, 2s, 5s, then every 5s until max_wait is exhausted. Total wall
    time can exceed max_wait by up to one connect_timeout: the in-flight probe
    is always allowed to finish.

    Args:
        api_base: API base URL, e.g. https://owlette.app/api
        max_wait: Total seconds to spend waiting before giving up
        connect_timeout: Per-attempt socket timeout

    Returns:
        True if the host became reachable, or if no host could be parsed (there
        is nothing to gate on). False if the budget expired. Callers proceed
        either way — this gate never blocks startup indefinitely.
    """
    host = extract_host(api_base)
    if not host:
        logging.info(f"[NET-GATE] No host in api_base ({api_base!r}) — skipping network gate")
        return True

    started = time.monotonic()
    deadline = started + max(0.0, max_wait)
    attempt = 0

    while True:
        attempt += 1
        ok, error = _tcp_connect(host, NETWORK_PROBE_PORT, connect_timeout)
        waited = round(time.monotonic() - started, 2)

        if ok:
            logging.info(
                f"[NET-GATE] {host}:{NETWORK_PROBE_PORT} reachable after {waited}s "
                f"({attempt} attempt{'s' if attempt != 1 else ''})"
            )
            return True

        if attempt <= len(_NETWORK_GATE_RAMP_DELAYS):
            delay = _NETWORK_GATE_RAMP_DELAYS[attempt - 1]
        else:
            delay = _NETWORK_GATE_INTERVAL

        if time.monotonic() + delay >= deadline:
            logging.warning(
                f"[NET-GATE] {host}:{NETWORK_PROBE_PORT} still unreachable after {waited}s "
                f"({attempt} attempt{'s' if attempt != 1 else ''}) — proceeding anyway. "
                f"Last error: {error}"
            )
            return False

        logging.info(
            f"[NET-GATE] {host}:{NETWORK_PROBE_PORT} unreachable ({error}) — retrying in {delay}s"
        )
        time.sleep(delay)
