"""
owlette site configuration — device code pairing flow.

Runs during install: requests a 3-word pairing phrase, shows it, polls until an
operator authorizes it on owlette.app/add or the dashboard, then stores the OAuth
tokens (C:\\ProgramData\\owlette\\.tokens.enc) and writes site_id / project_id /
api_base into config.json.

Usage:
    python configure_site.py [--url URL] [--add PHRASE] [--open-browser] [--no-browser]

    --url URL        Override the API base URL
    --add PHRASE     Pre-authorized pairing phrase (skips browser, polls immediately)
    --open-browser   Open the pairing page immediately instead of waiting on Enter
    --no-browser     Never offer a local browser; print the link and poll. For
                     kiosks/signage/media servers/headless/RDP, where you
                     authorize from another device. Also OWLETTE_NO_BROWSER=1.

Headless modes (the desktop app's bridge into the agent — see
`_run_headless_mode`). Each writes one JSON object per line to stdout and nothing
else, and never touches the console/clipboard UI above:

    --json-progress      Pair this machine, emitting phrase/status/authorized/error.
    --leave              Leave the current site (config, cache, service, machine doc).
    --report-issue FILE  Submit the feedback payload in FILE to `bug_reports`.
    --reboot-now         Record an owlette-initiated reboot and restart Windows.
    --dismiss-reboot     Clear the cloud rebootPending flag for this machine.
"""

import json
import logging
import os
import subprocess
import sys
import time
import argparse
from pathlib import Path
from typing import Optional, Callable

import shared_utils

CONFIG_PATH = Path(shared_utils.get_data_path('config/config.json'))

# Default timeout for polling (10 minutes, matching server-side expiry)
TIMEOUT_SECONDS = 600

# ANSI color codes (Windows 10+ supports these natively)
CYAN = '\033[96m'
GREEN = '\033[92m'
RED = '\033[91m'
DIM = '\033[2m'
BOLD = '\033[1m'
RESET = '\033[0m'


def _enable_ansi_colors():
    """Enable ANSI escape code processing on Windows."""
    if sys.platform == 'win32':
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            # Enable ENABLE_VIRTUAL_TERMINAL_PROCESSING
            kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
        except Exception:
            pass


def _open_browser(url: str) -> bool:
    """Open URL in browser without spawning visible console windows."""
    try:
        if sys.platform == 'win32':
            os.startfile(url)
            return True
        else:
            import webbrowser
            return webbrowser.open(url)
    except Exception:
        return False


def _prompt_open_browser_async(url: str) -> Callable[[], None]:
    """Open ``url`` if the operator presses Enter, without blocking polling."""
    if not url:
        return lambda: None

    import threading
    stop_event = threading.Event()

    def _wait_for_enter_key() -> bool:
        if sys.platform == 'win32':
            try:
                import msvcrt
                while not stop_event.is_set():
                    if msvcrt.kbhit():
                        ch = msvcrt.getwch()
                        if ch in ('\r', '\n'):
                            return True
                    time.sleep(0.05)
            except Exception:
                return False
            return False

        try:
            if not sys.stdin.isatty():
                return False
            import select
            while not stop_event.is_set():
                readable, _, _ = select.select([sys.stdin], [], [], 0.05)
                if readable:
                    sys.stdin.readline()
                    return True
        except Exception:
            return False
        return False

    def _wait_for_enter():
        if not _wait_for_enter_key() or stop_event.is_set():
            return

        opened = _open_browser(url)
        try:
            print()
            if opened:
                print(f"  {DIM}opened the pairing page in your browser - pick a site and authorize.{RESET}")
            else:
                print(f"  {DIM}could not open a browser; use the link above from any device.{RESET}")
        except Exception:
            pass

    threading.Thread(target=_wait_for_enter, daemon=True, name="OpenPairingPagePrompt").start()
    return stop_event.set


def _copy_to_clipboard(text: str) -> bool:
    """
    Best-effort copy of ``text`` to the Windows clipboard via win32clipboard
    (ships with pywin32 — no extra dependency). Returns True on success.

    Never raises: the clipboard can be transiently locked by another process,
    and a failed copy must never block pairing - the phrase is still shown on
    screen. Windows-only; a no-op elsewhere.
    """
    if sys.platform != 'win32':
        return False
    try:
        import win32clipboard
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
        finally:
            win32clipboard.CloseClipboard()
        return True
    except Exception as e:
        logging.debug(f"Clipboard copy failed (non-fatal): {e}")
        return False


def _determine_environment(url_hint: str = '') -> tuple:
    """
    Determine environment (dev/prod) from URL hint or existing config.

    An explicit URL hint (installer ``--url``, GUI server choice) is the operator
    deliberately selecting a server, so it MUST win over the existing config.
    Otherwise an agent already paired to one environment can never be switched to
    the other: a dev-paired agent re-running with ``--url https://owlette.app/api``
    used to be silently re-locked to dev (the dev->prod switch bug). The check
    was asymmetric — only an existing *development* config short-circuited — so
    prod->dev happened to work while dev->prod did not.

    Returns:
        (environment, api_base, project_id)
    """
    DEV = ('development', 'https://dev.owlette.app/api', 'owlette-dev-3838a')
    PROD = ('production', 'https://owlette.app/api', 'owlette-prod-90a12')

    # 1. An explicit URL hint wins — the operator is choosing the server.
    if url_hint:
        return DEV if 'dev.owlette.app' in url_hint else PROD

    # 2. No hint: honor the environment the existing config is bound to.
    try:
        if shared_utils.get_environment() == 'development':
            return DEV
    except Exception:
        pass

    # 3. Default to production.
    return PROD


def _save_config(site_id: str, environment: str, api_base: str, project_id: str):
    """Save site configuration to config.json (tokens stored separately in .tokens.enc)."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, 'r') as f:
                config = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logging.warning(f"Config file corrupted or unreadable ({e}), starting fresh")
            config = None
    else:
        config = None

    if config is None:
        config = {
            "_comment": "owlette Configuration - Edit this file to add processes to monitor",
            "version": shared_utils.CONFIG_VERSION,
            "processes": [],
            "logging": {
                "level": "INFO",
                "max_age_days": 90,
                "firebase_shipping": {
                    "enabled": False,
                    "ship_errors_only": True
                }
            },
            "firebase": {
                "_comment": "Cloud features: remote control, web dashboard, metrics",
                "enabled": False,
                "site_id": ""
            }
        }

    if 'firebase' not in config:
        config['firebase'] = {}

    config['firebase']['enabled'] = True
    config['firebase']['site_id'] = site_id
    config['firebase']['project_id'] = project_id
    config['firebase']['api_base'] = api_base
    config['environment'] = environment

    if 'token' in config.get('firebase', {}):
        del config['firebase']['token']

    # Atomic write: write to temp file, then replace
    tmp_path = CONFIG_PATH.with_suffix('.tmp')
    with open(tmp_path, 'w') as f:
        json.dump(config, f, indent=2)
    os.replace(tmp_path, CONFIG_PATH)


def run_pairing_flow(api_base: str = None, add_phrase: str = None,
                     timeout_seconds: int = TIMEOUT_SECONDS,
                     show_prompts: bool = True, open_browser: bool = False,
                     prompt_open_browser: bool = True,
                     on_phrase: Optional[Callable[[dict], None]] = None,
                     should_cancel: Optional[Callable[[], bool]] = None,
                     copy_clipboard: bool = True):
    """
    Run device code pairing flow to configure site authentication.

    This function can be called from:
    - Command line (configure_site.py main())
    - GUI Join Site button (owlette_gui.py)
    - Installer (Inno Setup)

    Args:
        api_base: API base URL (auto-detected if None)
        add_phrase: Pre-authorized pairing phrase (for /ADD= silent install)
        timeout_seconds: Max time to wait for authorization
        show_prompts: Show console output (False for GUI usage)
        open_browser: Open the pairing page immediately on this machine
            (interactive mode only). This is opt-in; polling starts immediately
            either way.
        prompt_open_browser: In console mode, show a non-blocking "press Enter
            to open" prompt. Set False (--no-browser) on kiosks/headless/RDP to
            avoid any local browser affordance.
        on_phrase: Optional callback invoked once in interactive mode with the
            device_data dict (pairPhrase, pairingUrl, verificationUri,
            expiresIn, ...) plus a 'clipboardCopied' bool, so a GUI caller can
            render its own phrase UI. Exceptions raised by it are swallowed.
        should_cancel: Optional predicate polled while waiting for
            authorization; when it returns True the wait is abandoned and the
            flow returns (False, "Cancelled by user", None). Lets the GUI
            Cancel button abort without waiting out the code's expiry.
        copy_clipboard: Copy the phrase to the Windows clipboard. True for the
            console/installer flow, where the operator has no other way to get
            it into owlette.app/add. The desktop app owns its own clipboard
            affordance and passes False so a background subprocess never steals
            the operator's clipboard.

    Returns:
        tuple: (success: bool, message: str, site_id: Optional[str])
    """
    from auth_manager import AuthManager, AuthenticationError

    environment, default_api_base, project_id = _determine_environment(api_base or '')
    api_base = api_base or default_api_base

    if show_prompts:
        _enable_ansi_colors()
        print(f"{DIM}{'=' * 60}{RESET}")
        print(f"{BOLD}owlette site configuration{RESET}")
        print(f"{DIM}{'=' * 60}{RESET}")
        print(f"  {DIM}api: {api_base}{RESET}")
        print()

    if show_prompts and not add_phrase and CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, 'r') as f:
                config = json.load(f)
                if config.get('firebase', {}).get('enabled') and config.get('firebase', {}).get('site_id'):
                    print(f"  already configured with site: {CYAN}{config['firebase']['site_id']}{RESET}")
                    print()
                    response = input("  reconfigure? (y/N): ").strip().lower()
                    if response != 'y':
                        return (False, "User cancelled reconfiguration", None)
        except Exception:
            pass

    auth_manager = AuthManager(api_base=api_base)

    try:
        if add_phrase:
            # Silent mode: phrase was pre-authorized on dashboard
            if show_prompts:
                print(f"Using pre-authorized phrase: {add_phrase}")
                print("Polling for authorization...")
                print()

            # /ADD= polls with the pairPhrase directly: the admin's phrase IS the
            # device_codes document id, so the agent needs no device code of its own.
            import requests as http_requests

            poll_url = f"{api_base}/agent/auth/device-code/poll"
            start_time = time.time()
            interval = 5

            while time.time() - start_time < timeout_seconds:
                try:
                    response = http_requests.post(
                        poll_url,
                        json={
                            'pairPhrase': add_phrase,
                            'machineId': auth_manager.machine_id,
                            'version': shared_utils.APP_VERSION,
                        },
                        timeout=15,
                    )

                    if response.status_code == 202:
                        if show_prompts:
                            elapsed = int(time.time() - start_time)
                            print(f"\r  Waiting for authorization... ({elapsed}s)", end='', flush=True)
                        time.sleep(interval)
                        continue

                    if response.status_code == 200:
                        data = response.json()
                        access_token = data.get('accessToken')
                        refresh_token = data.get('refreshToken')
                        expires_in = data.get('expiresIn', 3600)
                        site_id = data.get('siteId')

                        if not access_token or not refresh_token or not site_id:
                            return (False, "Invalid response from server (missing tokens)", None)

                        expiry_timestamp = time.time() + expires_in
                        auth_manager.storage.save_refresh_token(refresh_token)
                        auth_manager.storage.save_access_token(access_token, expiry_timestamp)
                        auth_manager.storage.save_site_id(site_id)

                        _save_config(site_id, environment, api_base, project_id)

                        if show_prompts:
                            print()
                            print()
                            print(f"{DIM}{'=' * 60}{RESET}")
                            print(f"  {GREEN}{BOLD}configuration complete!{RESET}")
                            print(f"{DIM}{'=' * 60}{RESET}")
                            print(f"  site: {CYAN}{site_id}{RESET}")
                            print(f"  {DIM}config: {CONFIG_PATH}{RESET}")
                            print()

                        return (True, "Configuration successful", site_id)

                    if response.status_code == 410:
                        return (False, "Pairing phrase expired. Generate a new one from the dashboard.", None)

                    if response.status_code == 404:
                        return (False, f"Pairing phrase not found: {add_phrase}", None)

                    error_msg = response.json().get('error', f"HTTP {response.status_code}")
                    return (False, f"Poll failed: {error_msg}", None)

                except http_requests.exceptions.RequestException as e:
                    if show_prompts:
                        print(f"\n  Network error (retrying): {e}")
                    time.sleep(interval)
                    continue

            return (False, "Timed out waiting for authorization", None)

        else:
            # Interactive mode: request device code and open pairing page
            if show_prompts:
                print(f"  {DIM}requesting pairing code from server...{RESET}")
                print()

            device_data = auth_manager.request_device_code()

            pair_phrase = device_data['pairPhrase']
            device_code = device_data['deviceCode']
            verification_uri = device_data['verificationUri']
            pairing_url = device_data.get('pairingUrl') or device_data.get('qrUrl', '')
            interval = device_data.get('interval', 5)
            expires_in = device_data.get('expiresIn', 600)

            # Copy the phrase so the operator can paste it into owlette.app/add.
            # Best-effort — a locked/unavailable clipboard never blocks pairing.
            phrase_copied = _copy_to_clipboard(pair_phrase) if copy_clipboard else False

            if show_prompts:
                print(f"{DIM}{'=' * 60}{RESET}")
                print()
                print(f"  pairing phrase:  {BOLD}{CYAN}{pair_phrase}{RESET}")
                if phrase_copied:
                    print(f"  {DIM}{GREEN}(copied to clipboard){RESET}")
                print()
                print(f"  {DIM}authorize this machine at:{RESET}")
                print(f"  {CYAN}{verification_uri}{RESET}")
                print()
                print(f"  {DIM}expires in {expires_in // 60} minutes{RESET}")
                print()
                print(f"{DIM}{'=' * 60}{RESET}")
                print()

            # Let an embedding caller (the GUI) render its own phrase UI. A failing
            # callback must never break pairing.
            if on_phrase:
                try:
                    on_phrase({**device_data, 'clipboardCopied': phrase_copied})
                except Exception as cb_err:
                    logging.warning(f"on_phrase callback failed: {cb_err}")

            # Opening the local browser is opt-in; the Enter prompt runs on a daemon
            # thread so polling starts immediately. The GUI uses on_phrase instead.
            browser_opened = _open_browser(pairing_url) if open_browser else False

            stop_open_prompt = None
            if show_prompts:
                if browser_opened:
                    print(f"  {DIM}opened the pairing page in your browser — pick a site and authorize.{RESET}")
                elif prompt_open_browser and pairing_url:
                    print(f"  {DIM}press Enter to open the pairing page in your browser.{RESET}")
                    print(f"  {DIM}or approve at the link above from any device.{RESET}")
                    stop_open_prompt = _prompt_open_browser_async(pairing_url)
                else:
                    print(f"  {DIM}approve at the link above from any device.{RESET}")
                print()
                print(f"  {BOLD}waiting for authorization...{RESET}")

            # Authorization from ANY device ends the wait; should_cancel lets a GUI
            # Cancel abort promptly.
            try:
                success = auth_manager.poll_device_code(
                    device_code=device_code,
                    interval=interval,
                    timeout=expires_in,
                    should_cancel=should_cancel,
                )
            finally:
                if stop_open_prompt:
                    stop_open_prompt()

            if success:
                site_id = auth_manager._site_id

                _save_config(site_id, environment, api_base, project_id)

                if show_prompts:
                    print()
                    print(f"{DIM}{'=' * 60}{RESET}")
                    print(f"  {GREEN}{BOLD}configuration complete!{RESET}")
                    print(f"{DIM}{'=' * 60}{RESET}")
                    print(f"  site: {CYAN}{site_id}{RESET}")
                    print(f"  {DIM}config: {CONFIG_PATH}{RESET}")
                    print()

                return (True, "Configuration successful", site_id)
            else:
                # False only on cancellation; failure/expiry raises AuthenticationError.
                if should_cancel and should_cancel():
                    return (False, "Cancelled by user", None)
                return (False, "Authorization failed", None)

    except AuthenticationError as e:
        error_msg = str(e)
        if show_prompts:
            print()
            print(f"{DIM}{'=' * 60}{RESET}")
            print(f"  {RED}{BOLD}configuration failed{RESET}")
            print(f"{DIM}{'=' * 60}{RESET}")
            print(f"  {RED}{error_msg}{RESET}")
            print()
        return (False, error_msg, None)

    except KeyboardInterrupt:
        if show_prompts:
            print()
            print(f"  {DIM}cancelled by user{RESET}")
        return (False, "Cancelled by user", None)

    except Exception as e:
        error_msg = f"Unexpected error: {e}"
        if show_prompts:
            print(f"Error: {error_msg}")

        import traceback
        try:
            debug_log = Path(shared_utils.get_data_path('logs/pairing_debug.log'))
            debug_log.parent.mkdir(parents=True, exist_ok=True)
            with open(debug_log, 'a') as f:
                f.write(f"\nPairing Flow Error\n")
                f.write(f"==================\n")
                f.write(f"Error: {e}\n")
                f.write(f"Traceback:\n{traceback.format_exc()}\n")
        except Exception:
            pass

        return (False, error_msg, None)


# Keep backward compatibility: run_oauth_flow calls run_pairing_flow
def run_oauth_flow(setup_url=None, timeout_seconds=TIMEOUT_SECONDS, show_prompts=True,
                   open_browser=False, prompt_open_browser=True,
                   on_phrase=None, should_cancel=None):
    """Backward-compatible wrapper. Calls run_pairing_flow()."""
    api_base = None
    if setup_url:
        if 'dev.owlette.app' in setup_url:
            api_base = 'https://dev.owlette.app/api'
        else:
            api_base = 'https://owlette.app/api'
    return run_pairing_flow(api_base=api_base, timeout_seconds=timeout_seconds,
                            show_prompts=show_prompts, open_browser=open_browser,
                            prompt_open_browser=prompt_open_browser,
                            on_phrase=on_phrase, should_cancel=should_cancel)


# Headless modes — the desktop app's bridge into the agent.
#
# The desktop app owns no cloud client and no token crypto; both stay here behind
# the bundled interpreter. It spawns `configure_site.py <mode>` and reads stdout,
# so every mode speaks one protocol: one JSON object per line,
# `{"event": ..., "value": ...}`, flushed as it happens.
#
#   phrase      pairing phrase and its URLs, once              (--json-progress)
#   status      human-readable progress, safe to show verbatim      (all modes)
#   authorized  pairing completed; value carries `siteId`     (--json-progress)
#   done        a non-pairing mode completed; value carries its outcome
#   error       the mode failed; value is the message to show
#
# Exactly one terminal event (authorized/done/error) per run, and the exit code
# agrees: 0 success, 1 failure. Only `_emit` writes to stdout.

# Cadence of the --json-progress "waiting" status; the desktop app renders a live
# elapsed time from it.
_STATUS_HEARTBEAT_SECONDS = 15

# Settle margin around service stop/start — now only for Firestore to catch up
# with the leave write (`owlette-host stop`/`start` are synchronous, unlike nssm).
_SERVICE_STOP_SETTLE = 3
_SERVICE_START_SETTLE = 2

# Feedback categories the web API accepts (`web/app/api/bug-report/route.ts`).
_REPORT_CATEGORIES = ('bug', 'feature_request', 'other', 'compliment', 'rant')

# Legacy dialog labels (`report_issue.ReportIssueApp.CATEGORY_MAP`), still
# accepted so a payload written by either UI resolves the same way.
_REPORT_CATEGORY_ALIASES = {
    'feature request': 'feature_request',
    'feedback': 'other',
}


def _emit(event: str, value=None) -> None:
    """Write one progress line to stdout and flush it.

    Deliberately not exception-guarded: the only realistic failure is the parent
    closing the pipe, and in that case this process must die rather than keep
    polling for ten minutes with nobody listening.
    """
    sys.stdout.write(json.dumps({'event': event, 'value': value}) + '\n')
    sys.stdout.flush()


def _host_path() -> str:
    """`<install>\\tools\\owlette-host.exe` — three directories up from this file."""
    src_dir = os.path.dirname(os.path.abspath(__file__))
    install_root = os.path.dirname(os.path.dirname(src_dir))
    return os.path.join(install_root, 'tools', 'owlette-host.exe')


def _host_service(action: str, timeout: int = 60) -> bool:
    """Run `owlette-host <action>`. True only when the host reported success.

    Replaced `nssm <action> OwletteService` in 3.0.0, when the service host
    became ours. Two differences the callers rely on:

    * `stop` is synchronous — it waits for the service to reach STOPPED, which
      is the window the agent uses to flush `online: false` and log
      agent_stopped. `nssm stop` returned while its child was still alive.
    * A service that is already in the requested state is a success, because
      what the caller wants is the state, not the transition.

    Never raises: leaving a site must complete even on a machine where the
    service cannot be controlled from this session (the host binary missing, or
    no rights — a standard user is not granted SERVICE_STOP), exactly as the GUI
    teardown behaved. The return value lets the caller tell the operator which
    half happened.
    """
    host = _host_path()
    if not os.path.exists(host):
        logging.warning(f"Service host not found at {host}; skipping service {action}")
        return False
    try:
        completed = subprocess.run(
            [host, action],
            check=False,
            capture_output=True,
            timeout=timeout,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        if completed.returncode != 0:
            logging.warning(f"owlette-host {action} returned {completed.returncode}")
        return completed.returncode == 0
    except Exception as e:
        logging.warning(f"owlette-host {action} failed: {e}")
        return False


def _machine_document(project_id: str, api_base: str, site_id: str):
    """Resolve `sites/{site_id}/machines/{hostname}` through the agent's client.

    Returns (client, document_ref). The caller closes the client. Raises
    RuntimeError when this machine has no usable credentials — the desktop app
    never sees the token store, so the message is what it shows the operator.
    """
    from auth_manager import AuthManager
    from firestore_rest_client import FirestoreRestClient

    if not project_id:
        raise RuntimeError('no firebase project is configured for this machine')
    if not site_id:
        raise RuntimeError('this machine is not paired with a site')

    auth_manager = AuthManager(api_base=api_base)
    if not auth_manager.is_authenticated():
        raise RuntimeError('owlette is not authenticated with the cloud')

    client = FirestoreRestClient(project_id=project_id, auth_manager=auth_manager)
    document = client.collection('sites').document(site_id) \
        .collection('machines').document(shared_utils.get_hostname())
    return client, document


def run_json_progress(api_base: str = None, timeout_seconds: int = TIMEOUT_SECONDS) -> int:
    """Pair this machine, reporting progress as JSON lines.

    The same `run_pairing_flow` the installer runs, with the console and
    clipboard affordances switched off: the desktop app renders the phrase
    itself and owns the clipboard. Cancellation is the caller killing this
    process — the device code simply expires server-side.
    """
    _emit('status', 'requesting a pairing phrase')

    last_heartbeat = [time.monotonic()]

    def heartbeat() -> bool:
        # Polled every ~0.25 s by `AuthManager.poll_device_code`; keeps the status
        # line alive. Never cancels.
        now = time.monotonic()
        if now - last_heartbeat[0] >= _STATUS_HEARTBEAT_SECONDS:
            last_heartbeat[0] = now
            _emit('status', 'waiting for authorization')
        return False

    def on_phrase(device_data: dict) -> None:
        _emit('phrase', {
            'pairPhrase': device_data.get('pairPhrase', ''),
            'pairingUrl': (device_data.get('pairingUrl')
                           or device_data.get('qrUrl')
                           or device_data.get('verificationUri', '')),
            'verificationUri': device_data.get('verificationUri', ''),
            'expiresIn': device_data.get('expiresIn', 600),
        })
        _emit('status', 'waiting for authorization')

    success, message, site_id = run_pairing_flow(
        api_base=api_base,
        timeout_seconds=timeout_seconds,
        show_prompts=False,
        open_browser=False,
        prompt_open_browser=False,
        copy_clipboard=False,
        on_phrase=on_phrase,
        should_cancel=heartbeat,
    )

    if not success:
        _emit('error', message)
        return 1

    # The service reads `firebase.site_id` once at startup, so it must restart
    # before this machine appears on the dashboard. Stopping OwletteService needs
    # SERVICE_STOP, which a standard user lacks — so the outcome is reported to
    # the caller rather than only logged.
    _emit('status', 'restarting the service')
    stopped = _host_service('stop')
    time.sleep(_SERVICE_STOP_SETTLE)
    started = _host_service('start')
    time.sleep(_SERVICE_START_SETTLE)

    _emit('authorized', {'siteId': site_id, 'serviceRestarted': stopped and started})
    return 0


def run_leave_site() -> int:
    """Remove this machine from its site.

    Ported from `owlette_gui.on_leave_site_click` (:1968-2092), in the same
    order and for the same reasons: the config is disabled *first* so the
    service cannot recreate the machine document, the cached cloud config goes
    with it, and the service is stopped before the document is deleted.

    One deliberate fix: the GUI read `site_id` back out of the config it had
    just blanked, so its delete addressed `sites//machines/{host}` and never
    removed anything. The site is captured up front here.
    """
    config = shared_utils.load_config()
    firebase_cfg = config.get('firebase') or {}
    site_id = firebase_cfg.get('site_id', '')
    project_id = firebase_cfg.get('project_id', '')
    api_base = firebase_cfg.get('api_base') or shared_utils.get_api_base_url()

    if not site_id:
        _emit('error', 'this machine is not paired with a site')
        return 1

    _emit('status', 'disabling cloud sync')
    if 'firebase' not in config:
        config['firebase'] = {}
    config['firebase']['enabled'] = False
    config['firebase']['site_id'] = ''
    shared_utils.save_config(config)
    logging.info("Firebase disabled and site_id cleared in config")

    # The service prefers the cached cloud config; leaving it would hand the next
    # start a stale site.
    try:
        cache_path = shared_utils.get_data_path('cache/firebase_cache.json')
        if os.path.exists(cache_path):
            os.remove(cache_path)
            logging.info("Deleted cached Firebase config")
    except Exception as e:
        logging.warning(f"Failed to delete cached config (non-critical): {e}")

    _emit('status', 'stopping the service')
    service_stopped = _host_service('stop')
    if service_stopped:
        time.sleep(_SERVICE_STOP_SETTLE)

    _emit('status', 'deregistering this machine')
    deregistered = False
    client = None
    try:
        client, document = _machine_document(project_id, api_base, site_id)
        document.delete()
        deregistered = True
        logging.info("Machine document deleted from Firestore")
    except Exception as e:
        # Non-fatal as in the GUI: already detached locally, and an admin can
        # remove the dashboard row.
        logging.warning(f"Failed to delete machine from Firestore (non-critical): {e}")
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass

    _emit('status', 'restarting the service')
    _host_service('start')
    time.sleep(_SERVICE_START_SETTLE)

    _emit('done', {
        'siteId': site_id,
        'deregistered': deregistered,
        'serviceStopped': service_stopped,
    })
    return 0


def _normalize_report_category(raw) -> str:
    """Map a payload's category onto one the web API accepts."""
    value = str(raw or '').strip().lower()
    value = _REPORT_CATEGORY_ALIASES.get(value, value)
    return value if value in _REPORT_CATEGORIES else 'other'


def _format_system_info(info: dict) -> str:
    """Format a system-info dict into readable lines."""
    return '\n'.join(f"  {key.replace('_', ' ')}: {value}" for key, value in info.items())


def build_report_data(category: str, description: str) -> dict:
    """Gather system info and recent logs for a feedback submission.

    Ported from `report_issue.build_report_data`; GPU probing is skipped because
    `nvidia-smi` flashes a console window on the operator's desktop.
    """
    config = shared_utils.read_config()
    firebase_cfg = config.get('firebase', {})

    system_info = {}
    try:
        system_info = shared_utils.get_system_metrics(skip_gpu=True)
    except Exception as e:
        logging.warning(f"Failed to gather system info: {e}")

    import platform
    import socket

    return {
        'category': category,
        'title': 'agent feedback',
        'description': description,
        'hostname': socket.gethostname(),
        'siteId': firebase_cfg.get('site_id', ''),
        'os': platform.platform(),
        'systemInfo': system_info,
        'logTail': shared_utils.get_log_tail('service', 100),
    }


def submit_report(data: dict) -> None:
    """POST a feedback report to `/api/bug-report`.

    Ported from `report_issue.submit_report`. The agent's own access token is
    the credential; the endpoint accepts it as a bearer token and files the
    report under `bug_reports` with `source: 'agent'`.
    """
    import requests as http_requests
    from auth_manager import AuthManager

    config = shared_utils.read_config()
    api_base = config.get('firebase', {}).get('api_base') or shared_utils.get_api_base_url()

    auth_manager = AuthManager(api_base=api_base)
    if not auth_manager.is_authenticated():
        raise RuntimeError('owlette is not connected to a site — pair this machine first.')

    token = auth_manager.get_valid_token()
    if not token:
        raise RuntimeError('failed to obtain a valid auth token.')

    web_base = api_base.rstrip('/')
    if web_base.endswith('/api'):
        web_base = web_base[:-len('/api')]

    description = data.get('description', '')
    system_info = data.get('systemInfo', {})
    log_tail = data.get('logTail', '')
    if system_info:
        description += f"\n\n--- system info ---\n{_format_system_info(system_info)}"
    if log_tail:
        description += f"\n\n--- recent logs (last ~100 lines) ---\n{log_tail}"

    # The API rejects anything over 50 000 characters; trim the log tail rather
    # than lose the report.
    if len(description) > 50000:
        description = description[:49950] + '\n\n[truncated]'

    response = http_requests.post(
        f"{web_base}/api/bug-report",
        json={
            'title': data.get('title', 'agent feedback'),
            'category': data.get('category', 'other'),
            'description': description,
            'browserUA': f"Owlette Agent v{shared_utils.APP_VERSION} / {data.get('os', '')}",
            'pageUrl': f"agent://{data.get('hostname', 'unknown')}",
        },
        headers={'Authorization': f'Bearer {token}'},
        timeout=15,
    )

    if response.status_code != 200:
        try:
            error_msg = response.json().get('error', response.text)
        except Exception:
            error_msg = response.text
        raise RuntimeError(f"the server rejected the report ({response.status_code}): {error_msg}")

    try:
        report_id = response.json().get('id', 'unknown')
    except Exception:
        report_id = 'unknown'
    logging.info(f"Bug report submitted via API: {report_id}")


def run_report_issue(payload_path: str) -> int:
    """Submit the feedback payload written by the desktop app.

    The payload is `{"category": ..., "description": ...}` in a file under the
    owlette tree; it is deleted as soon as it has been read so an operator's
    description is not left lying on disk.
    """
    try:
        with open(payload_path, 'r', encoding='utf-8') as f:
            payload = json.load(f)
    except (OSError, ValueError) as e:
        _emit('error', f"could not read the feedback payload: {e}")
        return 1
    finally:
        try:
            os.remove(payload_path)
        except OSError:
            pass

    description = str(payload.get('description') or '').strip()
    if not description:
        _emit('error', 'please describe the issue before submitting.')
        return 1

    category = _normalize_report_category(payload.get('category'))

    _emit('status', 'collecting system info and recent logs')
    try:
        report = build_report_data(category, description)
    except Exception as e:
        _emit('error', f"could not collect diagnostics: {e}")
        return 1

    _emit('status', 'submitting')
    try:
        submit_report(report)
    except Exception as e:
        _emit('error', str(e) or repr(e))
        return 1

    _emit('done', {'category': category})
    return 0


def run_reboot_now() -> int:
    """Restart Windows, recorded as an owlette-initiated reboot.

    Ported from `prompt_restart.PromptRestart.restart_now`: the intent is
    written *before* the shutdown call so the next startup classifier treats the
    reboot as planned and stays silent, and survives even if the call hangs.
    """
    try:
        import session_state
        session_state.set_intent('owlette_reboot')
    except Exception as e:
        # A missing intent only costs a spurious "unexpected reboot" warning; it
        # must never stop the reboot the operator asked for.
        logging.warning(f"session_state.set_intent failed before reboot: {e}")

    _emit('status', 'restarting windows')
    try:
        subprocess.run(
            ['shutdown', '/r', '/t', '1'],
            check=False,
            capture_output=True,
            timeout=10,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    except Exception as e:
        _emit('error', f"could not restart windows: {e}")
        return 1

    _emit('done', {'rebooting': True})
    return 0


def run_dismiss_reboot() -> int:
    """Clear this machine's cloud `rebootPending` flag.

    The local half of the dashboard's `dismiss_reboot_pending` command: it
    writes the same document shape `FirebaseClient.clear_reboot_pending` writes,
    so a countdown dismissed on the machine stops showing as pending on the
    dashboard. The service's own in-memory prompt gate is not touched — it
    expires on its own (`owlette_service.RESTART_PROMPT_ACTIVE_SECONDS`).
    """
    config = shared_utils.read_config()
    firebase_cfg = config.get('firebase', {})
    site_id = firebase_cfg.get('site_id', '')
    project_id = firebase_cfg.get('project_id', '')
    api_base = firebase_cfg.get('api_base') or shared_utils.get_api_base_url()

    if not site_id:
        # Nothing to clear on an unpaired machine; never fail the dismissal over it.
        _emit('done', {'cleared': False, 'reason': 'not paired'})
        return 0

    client = None
    try:
        client, document = _machine_document(project_id, api_base, site_id)
        document.set({
            'rebootPending': {
                'active': False,
                'processName': None,
                'reason': None,
                'timestamp': None,
            }
        }, merge=True)
    except Exception as e:
        _emit('error', f"could not clear the pending reboot: {e}")
        return 1
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass

    _emit('done', {'cleared': True})
    return 0


def _run_headless_mode(args) -> Optional[int]:
    """Dispatch a headless mode, or None when this is an interactive run.

    Returning None is what keeps the installer path untouched: `main` only
    consults this before any of its own work, and every branch below is
    additive.
    """
    selected = [
        name for name, chosen in (
            ('--json-progress', args.json_progress),
            ('--leave', args.leave),
            ('--report-issue', args.report_issue is not None),
            ('--reboot-now', args.reboot_now),
            ('--dismiss-reboot', args.dismiss_reboot),
        ) if chosen
    ]
    if not selected:
        return None
    if len(selected) > 1:
        _emit('error', f"pick one mode, not {' and '.join(selected)}")
        return 2

    try:
        if args.json_progress:
            api_base = args.url
            if not api_base and 'dev.owlette.app' in os.environ.get('OWLETTE_SETUP_URL', ''):
                api_base = 'https://dev.owlette.app/api'
            return run_json_progress(api_base=api_base)
        if args.leave:
            return run_leave_site()
        if args.report_issue is not None:
            return run_report_issue(args.report_issue)
        if args.reboot_now:
            return run_reboot_now()
        return run_dismiss_reboot()
    except Exception as e:
        logging.exception("Headless mode failed")
        _emit('error', str(e) or repr(e))
        return 1


def main():
    """Entry point for device code pairing flow."""
    parser = argparse.ArgumentParser(description='owlette Site Configuration')
    parser.add_argument('--url', type=str, default=None,
                        help='API base URL (auto-detected if not specified)')
    parser.add_argument('--add', type=str, default=None,
                        help='Pre-authorized pairing phrase for silent install')
    parser.add_argument('--open-browser', action='store_true',
                        help='Open the pairing page immediately. By default the '
                             'console asks you to press Enter before opening a browser.')
    parser.add_argument('--no-browser', action='store_true',
                        help="Do not offer to open a browser on this machine; just print "
                             "the pairing link and poll (kiosks/headless/RDP — "
                             "authorize from any device). Also: OWLETTE_NO_BROWSER=1")

    # Headless modes for the desktop app. Mutually exclusive with each other;
    # any one of them replaces the interactive flow entirely.
    parser.add_argument('--json-progress', action='store_true',
                        help='Pair headlessly, emitting JSON progress lines on stdout.')
    parser.add_argument('--leave', action='store_true',
                        help='Leave the current site and deregister this machine.')
    parser.add_argument('--report-issue', type=str, default=None, metavar='PAYLOAD',
                        help='Submit the feedback payload in PAYLOAD (JSON file, deleted after read).')
    parser.add_argument('--reboot-now', action='store_true',
                        help='Record an owlette-initiated reboot and restart Windows.')
    parser.add_argument('--dismiss-reboot', action='store_true',
                        help="Clear this machine's cloud rebootPending flag.")

    args = parser.parse_args()

    headless_exit_code = _run_headless_mode(args)
    if headless_exit_code is not None:
        return headless_exit_code

    api_base = args.url
    if not api_base:
        env_url = os.environ.get("OWLETTE_SETUP_URL", "")
        if 'dev.owlette.app' in env_url:
            api_base = 'https://dev.owlette.app/api'

    # Browser prompt suppressed by flag or env var (kiosks/headless/remote).
    no_browser = args.no_browser or os.environ.get('OWLETTE_NO_BROWSER', '').strip().lower() in ('1', 'true', 'yes')

    debug_log = Path(shared_utils.get_data_path('logs/pairing_debug.log'))
    Path(shared_utils.get_data_path('logs')).mkdir(parents=True, exist_ok=True)
    with open(debug_log, 'w') as f:
        f.write(f"Pairing Flow Debug\n")
        f.write(f"==================\n")
        f.write(f"--url: {args.url}\n")
        f.write(f"--add: {args.add}\n")
        f.write(f"--open-browser: {args.open_browser}\n")
        f.write(f"--no-browser: {no_browser}\n")
        f.write(f"Resolved api_base: {api_base}\n")
        f.write(f"OWLETTE_SETUP_URL: {os.environ.get('OWLETTE_SETUP_URL', 'NOT SET')}\n\n")

    success, message, site_id = run_pairing_flow(
        api_base=api_base,
        add_phrase=args.add,
        show_prompts=True,
        open_browser=args.open_browser and not no_browser,
        prompt_open_browser=(not no_browser) and (not args.open_browser),
    )

    if success:
        print("The owlette service will now be installed and started.")
        return 0
    else:
        print("Please try running the installer again.")
        # Pause so the user can read the error before the window closes
        if not args.add:  # Don't pause in silent /ADD= mode
            try:
                input("Press Enter to continue...")
            except (EOFError, KeyboardInterrupt):
                pass
        return 1


if __name__ == '__main__':
    sys.exit(main())
