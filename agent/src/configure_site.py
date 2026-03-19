"""
Owlette Site Configuration - OAuth Flow
Runs during installer to configure Firebase site_id via browser-based OAuth authentication.

This script:
1. Starts an HTTP server on localhost:8765
2. Opens the user's browser to dev.owlette.app/setup (or owlette.app/setup if --url specified)
3. Waits for callback with site_id and registration code
4. Exchanges registration code for OAuth tokens (access + refresh)
5. Stores tokens securely in encrypted file (C:\\ProgramData\\Owlette\\.tokens.enc, not config.json)
6. Writes minimal configuration to config.json (site_id, project_id, api_base)
7. Returns success/failure status

OAuth Flow:
- Registration code (from callback) → Access token + Refresh token (via API)
- Access token: Short-lived (1h), used for Firestore API calls
- Refresh token: Long-lived (30d), encrypted with machine-specific key, used to get new access tokens

Usage:
    python configure_site.py [--url URL]

    --url URL    Override the setup URL (default: https://owlette.app/setup)
                 Examples:
                   python configure_site.py --url https://dev.owlette.app/setup
                   python configure_site.py --url https://owlette.app/setup
"""

import http.server
import socketserver
import webbrowser
import json
import os
import sys
import time
import argparse
import subprocess
from urllib.parse import urlparse, parse_qs
from pathlib import Path


def open_browser_silent(url: str) -> bool:
    """
    Open browser without spawning visible console windows on Windows.

    Uses os.startfile() on Windows which doesn't create console windows,
    unlike webbrowser.open() which can spawn visible cmd.exe windows.
    """
    try:
        if sys.platform == 'win32':
            # os.startfile doesn't spawn console windows
            os.startfile(url)
            return True
        else:
            # Use webbrowser on other platforms
            return webbrowser.open(url)
    except Exception:
        # Fallback to webbrowser
        return webbrowser.open(url)

# Configuration
CALLBACK_PORT = 8765
DEFAULT_URL = "https://owlette.app/setup"
TIMEOUT_SECONDS = 300  # 5 minutes

# Import shared_utils to get ProgramData path
import shared_utils

# Use ProgramData for config (proper Windows location)
CONFIG_PATH = Path(shared_utils.get_data_path('config/config.json'))

# Global state
received_config = None
server_error = None
web_app_url = None  # Set in main(), used in save_config()


class ConfigCallbackHandler(http.server.BaseHTTPRequestHandler):
    """Handles OAuth callback from owlette.app"""

    def do_GET(self):
        global received_config, server_error

        parsed = urlparse(self.path)

        if parsed.path == '/callback':
            params = parse_qs(parsed.query)
            site_id = params.get('site_id', [None])[0]
            registration_code = params.get('token', [None])[0]  # 'token' param contains registration code

            if site_id and registration_code:
                try:
                    # Exchange registration code for OAuth tokens and save configuration
                    self.save_config(site_id, registration_code)
                    received_config = {'site_id': site_id, 'registration_code': registration_code}

                    # Send success response
                    self.send_response(200)
                    self.send_header('Content-type', 'text/html')
                    self.end_headers()

                    success_html = """
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>Owlette Configuration Complete</title>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <style>
                            * {
                                margin: 0;
                                padding: 0;
                                box-sizing: border-box;
                            }
                            body {
                                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', sans-serif;
                                background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
                                color: #e2e8f0;
                                min-height: 100vh;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                padding: 20px;
                            }
                            .container {
                                text-align: center;
                                max-width: 500px;
                            }
                            .logo {
                                font-size: 120px;
                                margin-bottom: 30px;
                                filter: drop-shadow(0 10px 20px rgba(0, 0, 0, 0.3));
                                animation: fadeIn 0.6s ease-out;
                            }
                            h1 {
                                color: #10b981;
                                font-size: 2.5rem;
                                font-weight: 700;
                                margin-bottom: 20px;
                                animation: fadeIn 0.8s ease-out;
                            }
                            .message {
                                color: #cbd5e1;
                                font-size: 1.1rem;
                                line-height: 1.6;
                                margin-bottom: 15px;
                                animation: fadeIn 1s ease-out;
                            }
                            .checkmark {
                                display: inline-block;
                                width: 80px;
                                height: 80px;
                                border-radius: 50%;
                                background: #10b981;
                                position: relative;
                                margin: 20px auto 30px;
                                animation: scaleIn 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55);
                            }
                            .checkmark::after {
                                content: '✓';
                                position: absolute;
                                top: 50%;
                                left: 50%;
                                transform: translate(-50%, -50%);
                                color: white;
                                font-size: 48px;
                                font-weight: bold;
                            }
                            @keyframes fadeIn {
                                from {
                                    opacity: 0;
                                    transform: translateY(20px);
                                }
                                to {
                                    opacity: 1;
                                    transform: translateY(0);
                                }
                            }
                            @keyframes scaleIn {
                                from {
                                    opacity: 0;
                                    transform: scale(0);
                                }
                                to {
                                    opacity: 1;
                                    transform: scale(1);
                                }
                            }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="logo">🦉</div>
                            <div class="checkmark"></div>
                            <h1>Configuration Complete!</h1>
                            <p class="message">Your Owlette agent has been configured successfully.</p>
                            <p class="message">You can close this window and return to the installer.</p>
                        </div>
                    </body>
                    </html>
                    """
                    self.wfile.write(success_html.encode('utf-8'))

                except Exception as e:
                    server_error = str(e)
                    self.send_error(500, f"Configuration error: {e}")
            else:
                server_error = "Missing site_id or registration_code in callback"
                self.send_error(400, server_error)

        elif parsed.path == '/health':
            # Health check endpoint
            self.send_response(200)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'OK')
        else:
            self.send_error(404)

    def save_config(self, site_id, registration_code):
        """
        Exchange registration code for OAuth tokens and save configuration.

        Args:
            site_id: Site ID from OAuth callback
            registration_code: Registration code to exchange for tokens
        """
        debug_log = Path(shared_utils.get_data_path('logs/oauth_debug.log'))

        try:
            # Ensure config directory exists
            CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

            # Import auth_manager here to avoid import errors if not installed
            from auth_manager import AuthManager, AuthenticationError

            # Determine API base URL from setup URL
            # If using dev.owlette.app, use dev API. Otherwise production API.
            global web_app_url
            # Use the global web_app_url set in main(), or fall back to env var + default
            url_to_check = web_app_url or os.environ.get("OWLETTE_SETUP_URL", DEFAULT_URL)

            # Determine environment from URL
            if 'dev.owlette.app' in url_to_check:
                environment = 'development'
                api_base = "https://dev.owlette.app/api"
                project_id = "owlette-dev-3838a"
            else:
                environment = 'production'
                api_base = "https://owlette.app/api"
                project_id = "owlette-prod-90a12"

            print(f"  API Base: {api_base}")
            print(f"  Project ID: {project_id}")
            print()
            print("Exchanging registration code for OAuth tokens...")

            # Write debug info to file for troubleshooting (APPEND, don't overwrite)
            with open(debug_log, 'a') as f:
                f.write(f"\nOAuth Exchange Debug\n")
                f.write(f"====================\n")
                f.write(f"API Base: {api_base}\n")
                f.write(f"Project ID: {project_id}\n")
                f.write(f"Site ID: {site_id}\n")
                f.write(f"Registration Code: {registration_code[:20]}...\n\n")

            # Initialize auth manager
            auth_manager = AuthManager(api_base=api_base)

            try:
                # Exchange registration code for access + refresh tokens
                success = auth_manager.exchange_registration_code(registration_code)

                if not success:
                    raise Exception("Token exchange returned False")

                print("✓ OAuth tokens received and stored securely")
                print("  - Access token: Valid for 1 hour")
                print("  - Refresh token: Valid for 30 days (encrypted in C:\\ProgramData\\Owlette\\.tokens.enc)")

            except AuthenticationError as e:
                raise Exception(f"OAuth authentication failed: {e}")
            except Exception as e:
                raise Exception(f"Failed to exchange registration code: {e}")

            # Read existing config or create default
            if CONFIG_PATH.exists():
                with open(CONFIG_PATH, 'r') as f:
                    config = json.load(f)
            else:
                config = {
                    "_comment": "Owlette Configuration - Edit this file to add processes to monitor",
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

            # Update Firebase configuration
            if 'firebase' not in config:
                config['firebase'] = {}

            config['firebase']['enabled'] = True
            config['firebase']['site_id'] = site_id
            config['firebase']['project_id'] = project_id
            config['firebase']['api_base'] = api_base

            # Save environment setting (production or development)
            config['environment'] = environment

            # DO NOT store tokens in config.json - they are encrypted in C:\ProgramData\Owlette\.tokens.enc
            # Remove old token field if it exists (from previous versions)
            if 'token' in config['firebase']:
                del config['firebase']['token']

            # Write updated config
            with open(CONFIG_PATH, 'w') as f:
                json.dump(config, f, indent=2)

            with open(debug_log, 'a') as f:
                f.write(f"\nConfig Write Success\n")
                f.write(f"====================\n")
                f.write(f"Config path: {CONFIG_PATH}\n")
                f.write(f"Firebase enabled: True, Site: {site_id}\n\n")

            print()
            print(f"✓ Configuration saved to {CONFIG_PATH}")
            print(f"  Site ID: {site_id}")
            print(f"  Project ID: {project_id}")
            print(f"  API Base: {api_base}")

        except Exception as e:
            # Log the full error to debug file so failures are diagnosable
            import traceback
            try:
                with open(debug_log, 'a') as f:
                    f.write(f"\nSave Config FAILED\n")
                    f.write(f"==================\n")
                    f.write(f"Error: {e}\n")
                    f.write(f"Traceback:\n{traceback.format_exc()}\n")
            except Exception:
                pass  # Don't let debug logging mask the real error
            raise

    def log_message(self, format, *args):
        """Suppress HTTP server logs during normal operation"""
        # Only log errors
        if format.startswith('code 4') or format.startswith('code 5'):
            print(f"HTTP Error: {format % args}", file=sys.stderr)


def wait_for_callback(httpd, timeout_seconds):
    """Wait for callback with timeout"""
    global received_config, server_error

    start_time = time.time()

    while received_config is None and server_error is None:
        # Check timeout
        elapsed = time.time() - start_time
        if elapsed > timeout_seconds:
            return False, "Timeout waiting for configuration"

        # Handle one request (non-blocking with timeout)
        httpd.timeout = 1  # 1 second socket timeout
        httpd.handle_request()

    if server_error:
        return False, server_error

    return True, "Configuration received successfully"


def run_oauth_flow(setup_url=None, timeout_seconds=TIMEOUT_SECONDS, show_prompts=True):
    """
    Run OAuth flow to configure site authentication.

    This function can be called from:
    - Command line (configure_site.py main())
    - GUI Join Site button (owlette_gui.py)
    - Installer (Inno Setup)

    Args:
        setup_url: Setup URL (default: https://owlette.app/setup)
        timeout_seconds: How long to wait for callback (default: 300)
        show_prompts: Show console prompts (False for GUI usage)

    Returns:
        tuple: (success: bool, message: str, site_id: Optional[str])
            - success: True if OAuth completed successfully
            - message: Status message or error description
            - site_id: Site ID if successful, None otherwise
    """
    global received_config, server_error, web_app_url

    # Reset global state
    received_config = None
    server_error = None

    # Use provided URL or environment variable override
    if setup_url is None:
        setup_url = os.environ.get("OWLETTE_SETUP_URL", DEFAULT_URL)

    web_app_url = setup_url

    if show_prompts:
        print("=" * 60)
        print("Owlette Site Configuration")
        print("=" * 60)
        print(f"Setup URL: {web_app_url}")
        print()

    # Check if already configured (skip prompt if show_prompts=False)
    if show_prompts and CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, 'r') as f:
                config = json.load(f)
                if config.get('firebase', {}).get('enabled') and config.get('firebase', {}).get('site_id'):
                    print(f"⚠ Already configured with site: {config['firebase']['site_id']}")
                    print()
                    response = input("Reconfigure? (y/N): ").strip().lower()
                    if response != 'y':
                        return (False, "User cancelled reconfiguration", None)
        except Exception as e:
            if show_prompts:
                print(f"⚠ Warning: Could not read existing config: {e}")

    # Start HTTP server
    if show_prompts:
        print(f"Starting configuration server on http://localhost:{CALLBACK_PORT}...")

    try:
        # Enable socket reuse to avoid "Address already in use" errors
        socketserver.TCPServer.allow_reuse_address = True
        with socketserver.TCPServer(("localhost", CALLBACK_PORT), ConfigCallbackHandler) as httpd:
            if show_prompts:
                print(f"✓ Server started successfully")
                print()

            # Open browser
            callback_url = f"{web_app_url}?callback_port={CALLBACK_PORT}"

            if show_prompts:
                print(f"Opening browser to: {web_app_url}")
                print()
                print("Please complete the following steps in your browser:")
                print("1. Log in to your Owlette account")
                print("2. Select or create a site")
                print("3. Authorize this agent")
                print()

            if open_browser_silent(callback_url):
                if show_prompts:
                    print("Browser opened successfully")
            else:
                if show_prompts:
                    print("Could not open browser automatically")
                    print(f"  Please manually navigate to: {callback_url}")

            if show_prompts:
                print()
                print(f"Waiting for configuration (timeout: {timeout_seconds}s)...")
                print("Press Ctrl+C to cancel")
                print()

            # Wait for callback
            success, message = wait_for_callback(httpd, timeout_seconds)

            if success:
                site_id = received_config.get('site_id') if received_config else None
                if show_prompts:
                    print()
                    print("=" * 60)
                    print("✓ Configuration Complete!")
                    print("=" * 60)
                    print()
                    print(f"Site ID: {site_id}")
                    print(f"Config saved to: {CONFIG_PATH}")
                    print()
                return (True, "Configuration successful", site_id)
            else:
                if show_prompts:
                    print()
                    print("=" * 60)
                    print("✗ Configuration Failed")
                    print("=" * 60)
                    print()
                    print(f"Error: {message}")
                    print()
                return (False, message, None)

    except OSError as e:
        if "Address already in use" in str(e):
            error_msg = f"Port {CALLBACK_PORT} is already in use. Another configuration process may be running."
            if show_prompts:
                print(f"✗ Error: {error_msg}")
            return (False, error_msg, None)
        else:
            error_msg = f"Failed to start server: {e}"
            if show_prompts:
                print(f"✗ Error: {error_msg}")
            return (False, error_msg, None)

    except KeyboardInterrupt:
        if show_prompts:
            print()
            print("✗ Cancelled by user")
        return (False, "Cancelled by user", None)

    except Exception as e:
        error_msg = f"Unexpected error: {e}"
        if show_prompts:
            print(f"✗ Error: {error_msg}")
        return (False, error_msg, None)


def main():
    """Start HTTP server and open browser for OAuth flow (command-line entry point)"""
    # Parse command-line arguments
    parser = argparse.ArgumentParser(description='Owlette Site Configuration')
    parser.add_argument('--url', type=str, default=DEFAULT_URL,
                       help='Setup URL (default: https://owlette.app/setup)')
    args = parser.parse_args()

    # Use provided URL or environment variable override
    setup_url = os.environ.get("OWLETTE_SETUP_URL", args.url)

    # Write command line args to debug log
    debug_log = Path(shared_utils.get_data_path('logs/oauth_debug.log'))
    Path(shared_utils.get_data_path('logs')).mkdir(parents=True, exist_ok=True)
    with open(debug_log, 'w') as f:
        f.write(f"Command Line Debug\n")
        f.write(f"==================\n")
        f.write(f"DEFAULT_URL constant: {DEFAULT_URL}\n")
        f.write(f"--url argument received: {args.url}\n")
        f.write(f"OWLETTE_SETUP_URL env var: {os.environ.get('OWLETTE_SETUP_URL', 'NOT SET')}\n")
        f.write(f"Final setup_url: {setup_url}\n\n")

    # Run OAuth flow with console prompts
    success, message, site_id = run_oauth_flow(setup_url=setup_url, show_prompts=True)

    if success:
        print("The Owlette service will now be installed and started.")
        return 0
    else:
        print("Please try running the installer again.")
        return 1


if __name__ == '__main__':
    sys.exit(main())
