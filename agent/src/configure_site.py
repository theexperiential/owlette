"""
owlette Site Configuration - Device Code / QR Pairing Flow

Runs during installer to configure Firebase site_id via device code authentication.

This script:
1. Requests a pairing phrase from the server (3 random words, e.g., "silver-compass-drift")
2. Displays a QR code + the phrase in the console (or GUI)
3. User scans QR code with phone or enters phrase on owlette.app/add (or dashboard)
4. Agent polls for authorization until the user approves
5. Receives and stores OAuth tokens securely (C:\\ProgramData\\owlette\\.tokens.enc)
6. Writes minimal configuration to config.json (site_id, project_id, api_base)

Three authorization methods:
- QR Code: Scan with phone → owlette.app/add pre-filled → select site → authorize
- Manual: Visit owlette.app/add → enter phrase → select site → authorize
- Dashboard: Click "+" on dashboard → enter phrase → authorize

For silent/bulk deployment:
    python configure_site.py --add silver-compass-drift

Usage:
    python configure_site.py [--url URL] [--add PHRASE]

    --url URL        Override the API base URL
    --add PHRASE     Pre-authorized pairing phrase (skips QR display, polls immediately)
"""

import json
import logging
import os
import sys
import time
import argparse
from pathlib import Path

import shared_utils

# Use ProgramData for config (proper Windows location)
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


def _determine_environment(url_hint: str = '') -> tuple:
    """
    Determine environment (dev/prod) from URL hint or existing config.

    Returns:
        (environment, api_base, project_id)
    """
    # Check existing config first
    try:
        existing_env = shared_utils.get_environment()
        if existing_env == 'development':
            return ('development', 'https://dev.owlette.app/api', 'owlette-dev-3838a')
    except Exception:
        pass

    # Check URL hint
    if 'dev.owlette.app' in url_hint:
        return ('development', 'https://dev.owlette.app/api', 'owlette-dev-3838a')

    return ('production', 'https://owlette.app/api', 'owlette-prod-90a12')


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

    # Remove legacy token field if present
    if 'token' in config.get('firebase', {}):
        del config['firebase']['token']

    # Atomic write: write to temp file, then replace
    tmp_path = CONFIG_PATH.with_suffix('.tmp')
    with open(tmp_path, 'w') as f:
        json.dump(config, f, indent=2)
    os.replace(tmp_path, CONFIG_PATH)


def run_pairing_flow(api_base: str = None, add_phrase: str = None,
                     timeout_seconds: int = TIMEOUT_SECONDS,
                     show_prompts: bool = True):
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

    Returns:
        tuple: (success: bool, message: str, site_id: Optional[str])
    """
    from auth_manager import AuthManager, AuthenticationError

    # Determine environment
    environment, default_api_base, project_id = _determine_environment(api_base or '')
    api_base = api_base or default_api_base

    if show_prompts:
        _enable_ansi_colors()
        print(f"{DIM}{'=' * 60}{RESET}")
        print(f"{BOLD}owlette site configuration{RESET}")
        print(f"{DIM}{'=' * 60}{RESET}")
        print(f"  {DIM}api: {api_base}{RESET}")
        print()

    # Check if already configured
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

            # We need the device code to poll. For pre-authorized phrases,
            # the agent still needs to request a device code first, then poll.
            # But in the /ADD= flow, the admin already generated the phrase
            # from the dashboard. The agent needs to look up this phrase.
            # The server returns a deviceCode when generating the phrase.
            # For /ADD=, we call the device-code endpoint which returns
            # both the phrase and deviceCode. But we already have the phrase.
            # Solution: request a new device code, but the server will see
            # the phrase is already authorized and the poll will return immediately.
            #
            # Actually, for /ADD= the flow is:
            # 1. Admin generates phrase on dashboard (calls device-code endpoint)
            # 2. Admin authorizes it immediately for their site
            # 3. Admin gives phrase to deployment tech
            # 4. Agent calls device-code endpoint with the phrase... but the
            #    phrase is the document ID, not something the agent sends.
            #
            # Better approach: the /ADD= phrase IS the deviceCode-equivalent.
            # The agent calls the poll endpoint with a special "pairPhrase" field
            # instead of deviceCode. But that changes the API contract.
            #
            # Simplest approach: Agent requests its own device code, but passes
            # the pre-authorized phrase. If the phrase was already authorized,
            # the server can return tokens immediately. But the agent doesn't
            # control the phrase...
            #
            # Cleanest approach for /ADD=: Add a dedicated exchange endpoint
            # that takes a pairPhrase directly and returns tokens if authorized.
            # For now, we'll use a workaround: request our own device code,
            # then have the installer tech also manually authorize via dashboard.
            #
            # WAIT - rethinking this. The /ADD= flow should work like this:
            # 1. Admin clicks "Generate Code" on dashboard
            # 2. Server creates device_codes/{phrase} with status: 'pending'
            # 3. Admin clicks "Authorize" on dashboard for that phrase
            # 4. Server updates status to 'authorized' and generates tokens
            # 5. Agent runs with /ADD=phrase, requests device-code endpoint
            #    BUT this creates a NEW phrase, not the admin's phrase.
            #
            # The RIGHT approach: Agent needs to poll using the admin's phrase.
            # The poll endpoint should accept either deviceCode OR pairPhrase.
            # Let's modify the poll to also accept pairPhrase as a lookup key.
            #
            # For now: the agent will poll using the pairPhrase directly
            # (the poll endpoint looks up by deviceCodeHash, but we can also
            # look up the document directly by phrase since phrase = document ID).
            import requests as http_requests

            poll_url = f"{api_base}/agent/auth/device-code/poll"
            start_time = time.time()
            interval = 5

            while time.time() - start_time < timeout_seconds:
                try:
                    response = http_requests.post(
                        poll_url,
                        json={'pairPhrase': add_phrase},
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

                        # Store tokens
                        expiry_timestamp = time.time() + expires_in
                        auth_manager.storage.save_refresh_token(refresh_token)
                        auth_manager.storage.save_access_token(access_token, expiry_timestamp)
                        auth_manager.storage.save_site_id(site_id)

                        # Save config
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
            # Interactive mode: request device code and display QR
            if show_prompts:
                print(f"  {DIM}requesting pairing code from server...{RESET}")
                print()

            device_data = auth_manager.request_device_code()

            pair_phrase = device_data['pairPhrase']
            device_code = device_data['deviceCode']
            verification_uri = device_data['verificationUri']
            qr_url = device_data['qrUrl']
            interval = device_data.get('interval', 5)
            expires_in = device_data.get('expiresIn', 600)

            if show_prompts:
                print(f"{DIM}{'=' * 60}{RESET}")
                print()
                print(f"  pairing phrase:  {BOLD}{CYAN}{pair_phrase}{RESET}")
                print()
                print(f"  {DIM}authorize this machine at:{RESET}")
                print(f"  {CYAN}{verification_uri}{RESET}")
                print()
                print(f"  {DIM}expires in {expires_in // 60} minutes{RESET}")
                print()
                print(f"{DIM}{'=' * 60}{RESET}")
                print()

                # Auto-open browser with phrase pre-filled
                if _open_browser(qr_url):
                    print(f"  {DIM}browser opened — select a site and authorize{RESET}")
                else:
                    print(f"  {DIM}couldn't open browser — visit the url above manually{RESET}")
                print()
                print(f"  waiting for authorization...")

            # Poll for authorization
            success = auth_manager.poll_device_code(
                device_code=device_code,
                interval=interval,
                timeout=expires_in,
            )

            if success:
                site_id = auth_manager._site_id

                # Save config
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

        # Log to debug file
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
def run_oauth_flow(setup_url=None, timeout_seconds=TIMEOUT_SECONDS, show_prompts=True):
    """Backward-compatible wrapper. Calls run_pairing_flow()."""
    api_base = None
    if setup_url:
        if 'dev.owlette.app' in setup_url:
            api_base = 'https://dev.owlette.app/api'
        else:
            api_base = 'https://owlette.app/api'
    return run_pairing_flow(api_base=api_base, timeout_seconds=timeout_seconds, show_prompts=show_prompts)


def main():
    """Entry point for device code pairing flow."""
    parser = argparse.ArgumentParser(description='owlette Site Configuration')
    parser.add_argument('--url', type=str, default=None,
                        help='API base URL (auto-detected if not specified)')
    parser.add_argument('--add', type=str, default=None,
                        help='Pre-authorized pairing phrase for silent install')
    args = parser.parse_args()

    # Determine API base
    api_base = args.url
    if not api_base:
        env_url = os.environ.get("OWLETTE_SETUP_URL", "")
        if 'dev.owlette.app' in env_url:
            api_base = 'https://dev.owlette.app/api'

    # Write debug log
    debug_log = Path(shared_utils.get_data_path('logs/pairing_debug.log'))
    Path(shared_utils.get_data_path('logs')).mkdir(parents=True, exist_ok=True)
    with open(debug_log, 'w') as f:
        f.write(f"Pairing Flow Debug\n")
        f.write(f"==================\n")
        f.write(f"--url: {args.url}\n")
        f.write(f"--add: {args.add}\n")
        f.write(f"Resolved api_base: {api_base}\n")
        f.write(f"OWLETTE_SETUP_URL: {os.environ.get('OWLETTE_SETUP_URL', 'NOT SET')}\n\n")

    success, message, site_id = run_pairing_flow(
        api_base=api_base,
        add_phrase=args.add,
        show_prompts=True,
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
