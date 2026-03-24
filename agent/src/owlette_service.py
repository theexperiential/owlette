import os
import sys
import threading
import socket
import requests

# Add the src directory to Python path so imports work when running as service
src_dir = os.path.dirname(os.path.abspath(__file__))
if src_dir not in sys.path:
    sys.path.insert(0, src_dir)

import shared_utils
import installer_utils
import project_utils
import registry_utils
import win32serviceutil
import win32service
import win32event
import win32process
import win32profile
import win32ts
import win32con
import win32gui
import win32security
import servicemanager
import logging
import psutil
import time
import json
import datetime
import atexit
import shlex
import subprocess
import tempfile

# Firebase integration
FIREBASE_IMPORT_ERROR = None
try:
    from firebase_client import FirebaseClient
    FIREBASE_AVAILABLE = True
except ImportError as e:
    FIREBASE_AVAILABLE = False
    FIREBASE_IMPORT_ERROR = str(e)
    # Note: logging not initialized yet, so we can't log here

# Health probe (stdlib-only module, safe to import unconditionally)
from health_probe import HealthProbe, HealthState, STATUS_OK


def _handle_unhandled_exception(exc_type, exc_value, exc_tb):
    """Log unhandled exceptions before NSSM restarts the service."""
    if issubclass(exc_type, KeyboardInterrupt):
        sys.__excepthook__(exc_type, exc_value, exc_tb)
        return
    logging.critical(
        "UNHANDLED EXCEPTION — service will be restarted by NSSM:",
        exc_info=(exc_type, exc_value, exc_tb)
    )


def _handle_thread_exception(args):
    """Log unhandled exceptions from non-main threads."""
    logging.critical(
        f"UNHANDLED THREAD EXCEPTION in {args.thread!r}:",
        exc_info=(args.exc_type, args.exc_value, args.exc_traceback)
    )


"""
To install/run this as a service,
switch to the current working directory in
an Administrator Command Prompt & run:
python owlette_service.py install | start | stop | remove
"""

# Constants
LOG_FILE_PATH = shared_utils.get_data_path('logs/service.log')
MAX_RELAUNCH_ATTEMPTS = 3
SLEEP_INTERVAL = 5
TIME_TO_INIT = 60

# Utility functions
class Util:

    # Initialize results file
    @staticmethod
    def initialize_results_file():
        with open(shared_utils.RESULT_FILE_PATH, 'w') as f:
            json.dump({}, f)

    # Check if a Process ID (PID) is running
    @staticmethod
    def is_pid_running(pid):
        try:
            process = psutil.Process(pid)
            return True
        except psutil.NoSuchProcess:
            return False

    @staticmethod
    def get_process_name(process):
        return process.get('name', 'Error retrieving process name')


# Main Owlette Windows Service logic
class OwletteService(win32serviceutil.ServiceFramework):
    _svc_name_ = 'OwletteService'
    _svc_display_name_ = 'Owlette Service'

    def __init__(self, args):
        win32serviceutil.ServiceFramework.__init__(self, args)

        # Initialize logging and shared resources with configurable log level
        log_level = shared_utils.get_log_level_from_config()
        shared_utils.initialize_logging("service", level=log_level)

        # Wire global exception hooks (after logging is configured)
        sys.excepthook = _handle_unhandled_exception
        threading.excepthook = _handle_thread_exception

        # Only initialize results file if it doesn't exist (don't clear existing PIDs!)
        if not os.path.exists(shared_utils.RESULT_FILE_PATH):
            Util.initialize_results_file()
            logging.info("Initialized new app_states.json file")

        # Upgrade JSON config to latest version
        logging.debug(f"Config path: {shared_utils.CONFIG_PATH}")
        shared_utils.upgrade_config()

        # --- STARTUP HEALTH PROBE ---
        api_base = shared_utils.read_config(['firebase', 'api_base']) or shared_utils.get_api_base_url()
        self._health_state: HealthState = HealthProbe(
            config_path=shared_utils.CONFIG_PATH,
            api_base=api_base
        ).run()
        logging.debug(f"Startup health probe: status={self._health_state.status}, results={self._health_state.probe_results}")
        if not self._health_state.is_ok():
            logging.error(f"Health probe failed: {self._health_state.error_code} — {self._health_state.error_message}")

        # Store auth manager and api_base for use in _update_health_state
        self._auth_manager = None
        self._api_base = api_base

        # Write early status so tray can show health alerts before Firebase init
        self._write_service_status_early()

        self.hWaitStop = win32event.CreateEvent(None, 0, 0, None)
        self.is_alive = True
        self._restart_exit_code = 0
        self.tray_icon_pid = None
        self.cortex_pid = None
        self.relaunch_attempts = {} # Restart attempts for each process
        self.first_start = True # First start of this service
        self.last_started = {} # Last time a process was started
        self.results = {} # App process response esults
        self.current_time = datetime.datetime.now()
        self.active_installations = {} # Track active installer processes for cancellation
        self.manual_overrides = {} # Processes manually started outside their schedule window
        self._cached_site_timezone = None  # Cached from firebase_client

        # Initialize Firebase client
        self.firebase_client = None
        logging.debug(f"Firebase check - Available: {FIREBASE_AVAILABLE}")

        if not FIREBASE_AVAILABLE and FIREBASE_IMPORT_ERROR:
            logging.warning(f"Firebase client not available - Import error: {FIREBASE_IMPORT_ERROR}")
            logging.warning("Running in local-only mode")

        if FIREBASE_AVAILABLE:
            firebase_enabled = shared_utils.read_config(['firebase', 'enabled'])
            logging.debug(f"Firebase config - enabled: {firebase_enabled}")

            if firebase_enabled:
                try:
                    # Get configuration
                    site_id = shared_utils.read_config(['firebase', 'site_id'])
                    project_id = shared_utils.read_config(['firebase', 'project_id']) or "owlette-dev-3838a"
                    api_base = shared_utils.read_config(['firebase', 'api_base']) or shared_utils.get_api_base_url()
                    cache_path = shared_utils.get_data_path('cache/firebase_cache.json')

                    logging.debug(f"Firebase config - site: {site_id}, project: {project_id}")

                    # Initialize OAuth authentication manager
                    from auth_manager import AuthManager
                    auth_manager = AuthManager(api_base=api_base)
                    self._auth_manager = auth_manager  # Store for health alerting

                    # Check if authenticated
                    if not auth_manager.is_authenticated():
                        logging.error("Agent not authenticated - no refresh token found")
                        logging.error("Please run the installer or re-authenticate via web dashboard")
                        self.firebase_client = None
                    else:
                        # Initialize Firebase client with OAuth
                        self.firebase_client = FirebaseClient(
                            auth_manager=auth_manager,
                            project_id=project_id,
                            site_id=site_id,
                            config_cache_path=cache_path
                        )
                        logging.info(f"Firebase client initialized for site: {site_id}")

                except Exception as e:
                    logging.error(f"Failed to initialize Firebase client: {e}")
                    logging.exception("Firebase initialization error details:")
                    self.firebase_client = None

    def _initialize_or_restart_firebase_client(self):
        """
        Initialize or reinitialize Firebase client based on current config.
        Called during startup and when Firebase is re-enabled after being disabled.

        Returns:
            bool: True if Firebase client is successfully initialized/restarted, False otherwise
        """
        try:
            # Check if Firebase is available and enabled
            if not FIREBASE_AVAILABLE:
                logging.warning("Firebase module not available - cannot initialize client")
                return False

            firebase_enabled = shared_utils.read_config(['firebase', 'enabled'])
            if not firebase_enabled:
                logging.info("Firebase is disabled in config - skipping initialization")
                return False

            # Get Firebase configuration
            site_id = shared_utils.read_config(['firebase', 'site_id'])
            if not site_id:
                logging.warning("No site_id configured - cannot initialize Firebase client")
                return False

            project_id = shared_utils.read_config(['firebase', 'project_id']) or "owlette-dev-3838a"
            api_base = shared_utils.read_config(['firebase', 'api_base']) or shared_utils.get_api_base_url()
            cache_path = shared_utils.get_data_path('cache/firebase_cache.json')

            logging.info(f"Initializing Firebase client - site: {site_id}, project: {project_id}")

            # Initialize OAuth authentication manager
            from auth_manager import AuthManager
            auth_manager = AuthManager(api_base=api_base)

            # Check if authenticated
            if not auth_manager.is_authenticated():
                logging.error("Agent not authenticated - no refresh token found")
                logging.error("Please run the installer or re-authenticate via web dashboard")
                return False

            # Stop existing Firebase client if running
            if self.firebase_client:
                logging.debug("Stopping existing Firebase client before reinitialization...")
                try:
                    self.firebase_client.stop()
                    logging.debug("Existing Firebase client stopped")
                except Exception as e:
                    logging.warning(f"Error stopping existing Firebase client: {e}")

            # Initialize new Firebase client
            self.firebase_client = FirebaseClient(
                auth_manager=auth_manager,
                project_id=project_id,
                site_id=site_id,
                config_cache_path=cache_path
            )

            # Register callbacks
            self.firebase_client.register_command_callback(self.handle_firebase_command)
            self.firebase_client.register_config_update_callback(self.handle_config_update)

            # Sync config: pull from Firestore (source of truth), or seed if new machine
            sync_result = self.firebase_client.sync_config_on_startup()
            logging.info(f"Config sync on reinit: {sync_result}")

            # Wire state listener BEFORE start() so the CONNECTED event
            # writes the status file immediately (tray polls every 1s)
            def _on_connection_change(event):
                try:
                    self._write_service_status()
                except Exception:
                    pass
            self.firebase_client.connection_manager.add_state_listener(_on_connection_change)

            # Wire health callback so connection failures update health state + alert
            self.firebase_client.connection_manager.set_health_callback(
                lambda code, msg: self._update_health_state('connection_failure', code, msg)
            )

            # Start Firebase client background threads
            self.firebase_client.start()
            logging.info(f"[OK] Firebase client initialized and started for site: {site_id}")

            # Cache site timezone for schedule evaluation
            self._cached_site_timezone = self.firebase_client.site_timezone

            # Clear any stale health errors (e.g. config_error from startup before site was joined)
            self._update_health_state('ok', 'ok', 'Firebase connected successfully')

            return True

        except Exception as e:
            logging.error(f"Failed to initialize Firebase client: {e}")
            logging.exception("Firebase initialization error details:")
            self.firebase_client = None
            return False

    def _health_section(self) -> dict:
        """Build the health section for service_status.json from current _health_state."""
        h = getattr(self, '_health_state', None)
        if h is None:
            return {'status': 'unknown', 'checked_at': 0, 'error_code': None, 'error_message': None, 'probe_results': {}}
        return h.to_dict()

    def _write_service_status_early(self, running=True):
        """
        Write service + health sections to service_status.json immediately after
        the startup health probe, before Firebase is initialized.
        This lets the tray icon show health alerts right away.
        """
        try:
            status_path = shared_utils.get_data_path('tmp/service_status.json')
            os.makedirs(os.path.dirname(status_path), exist_ok=True)

            status = {
                'service': {
                    'running': running,
                    'last_update': int(time.time()),
                    'version': shared_utils.APP_VERSION
                },
                'firebase': {
                    'enabled': False,
                    'connected': False,
                    'site_id': '',
                    'last_heartbeat': 0
                },
                'health': self._health_section()
            }

            temp_path = status_path + '.tmp'
            with open(temp_path, 'w') as f:
                json.dump(status, f, indent=2)
            if os.path.exists(status_path):
                os.remove(status_path)
            os.rename(temp_path, status_path)

        except Exception as e:
            logging.debug(f"Failed to write early service status: {e}")

    def _write_service_status(self, running=True):
        """
        Write current service status to file for tray icon to read.

        Creates/updates C:\\ProgramData\\Owlette\\tmp\\service_status.json with:
        - Service running state
        - Firebase enabled/connected state
        - Site ID
        - Last heartbeat timestamp
        - Service version
        - Health probe results

        This provides real-time IPC from service → tray icon without log parsing.

        Args:
            running: Whether service is currently running (False when stopping)
        """
        try:
            status_path = shared_utils.get_data_path('tmp/service_status.json')

            # Ensure tmp directory exists
            os.makedirs(os.path.dirname(status_path), exist_ok=True)

            # Build status dict
            firebase_enabled = shared_utils.read_config(['firebase', 'enabled']) or False
            firebase_connected = False
            site_id = ''
            last_heartbeat = 0

            if self.firebase_client:
                try:
                    firebase_connected = self.firebase_client.is_connected()
                    site_id = self.firebase_client.site_id or ''
                    # Get last heartbeat time if available
                    if hasattr(self.firebase_client, '_last_heartbeat_time'):
                        last_heartbeat = int(self.firebase_client._last_heartbeat_time)
                except Exception:
                    pass  # Ignore errors getting Firebase state

            status = {
                'service': {
                    'running': running,
                    'last_update': int(time.time()),
                    'version': shared_utils.APP_VERSION
                },
                'firebase': {
                    'enabled': firebase_enabled,
                    'connected': firebase_connected,
                    'site_id': site_id,
                    'last_heartbeat': last_heartbeat
                },
                'health': self._health_section()
            }

            # Write atomically (write to temp file, then replace)
            temp_path = status_path + '.tmp'
            with open(temp_path, 'w') as f:
                json.dump(status, f, indent=2)

            # os.replace() is atomic on Windows (no gap where file is missing)
            os.replace(temp_path, status_path)

        except Exception as e:
            logging.debug(f"Failed to write service status: {e}")

    def _update_health_state(self, status: str, error_code: str, message: str):
        """
        Update health state and propagate to IPC file, Firestore (if connected),
        and web API alert endpoint (if auth available and connection failed).

        Called by the ConnectionManager health callback and internal error handlers.
        Never raises — failures are logged at DEBUG level.
        """
        try:
            from health_probe import HealthState
            import time as _time
            if self._health_state is None:
                self._health_state = HealthState(
                    status=status,
                    error_code=error_code,
                    error_message=message,
                    checked_at=int(_time.time())
                )
            else:
                self._health_state.status = status
                self._health_state.error_code = error_code
                self._health_state.error_message = message

            self._write_service_status()
            logging.warning(f"[HEALTH] Status updated: {status} — {error_code}: {message}")

        except Exception as e:
            logging.debug(f"_update_health_state write failed: {e}")

        # Write health fields to Firestore if connected
        try:
            if self.firebase_client and self.firebase_client.is_connected():
                self.firebase_client.write_health_to_firestore(status, error_code, message)
        except Exception as e:
            logging.debug(f"_update_health_state Firestore write failed: {e}")

        # Send alert to web API in a daemon thread when connection fails but auth is OK
        if status == 'connection_failure' and self._auth_manager:
            def _send_alert():
                try:
                    token = self._auth_manager.get_valid_token()
                    site_id = self._auth_manager.get_site_id() or ''
                    machine_id = socket.gethostname()
                    api_base = self._api_base or shared_utils.get_api_base_url()
                    requests.post(
                        f"{api_base}/agent/alert",
                        json={
                            'siteId': site_id,
                            'machineId': machine_id,
                            'errorCode': error_code,
                            'errorMessage': message,
                            'agentVersion': shared_utils.APP_VERSION,
                        },
                        headers={'Authorization': f'Bearer {token}'},
                        timeout=10
                    )
                    logging.info(f"[HEALTH] Alert sent to web API: {error_code}")
                except Exception as e:
                    logging.debug(f"[HEALTH] Web API alert failed (non-critical): {e}")

            t = threading.Thread(target=_send_alert, daemon=True)
            t.start()

    # On service stop
    def SvcStop(self):
        # Try to report service status (may fail when running under NSSM)
        try:
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        except AttributeError:
            # Running under NSSM - service control handler not fully initialized
            logging.info("SvcStop called under NSSM mode (service control handler not available)")

        # Log service stop with stack trace info to identify caller
        import inspect
        caller_frame = inspect.currentframe().f_back
        caller_info = f"{caller_frame.f_code.co_filename}:{caller_frame.f_lineno}" if caller_frame else "unknown"
        logging.warning(f"=== SERVICE STOP REQUESTED === (called from {caller_info})")
        logging.info("Service stop requested - setting machine offline in Firebase...")
        self.is_alive = False

        # Log Agent Stopped event to Firestore BEFORE stopping client
        firebase_connected = self.firebase_client and self.firebase_client.is_connected()
        logging.info(f"SvcStop - Firebase client available: {self.firebase_client is not None}, connected: {firebase_connected}")

        if firebase_connected:
            try:
                # Note: agent_stopped is logged by signal handler in owlette_runner.py
                # (most reliable - always executes even if service is killed quickly)
                # No need to log here to avoid duplicate events
                logging.info("SvcStop - agent_stopped will be logged by signal handler")
                # Give Firebase a moment to flush any pending writes
                time.sleep(0.5)
            except Exception as log_err:
                logging.error(f"SvcStop - Failed to log agent_stopped event: {log_err}")
                logging.exception("Full traceback:")
        else:
            logging.warning("SvcStop - Firebase client not available - cannot log agent_stopped event")

        # Stop Firebase client (this sets machine offline)
        if self.firebase_client:
            try:
                self.firebase_client.stop()
                logging.info("[OK] Firebase client stopped and machine set to offline")
            except Exception as e:
                logging.error(f"[ERROR] Error stopping Firebase client: {e}")

        # Close any open Owlette windows (GUI, prompts, etc.)
        self.close_owlette_windows()

        self.terminate_tray_icon()
        self.terminate_cortex()

        # Write final status (service stopped) for tray icon
        self._write_service_status(running=False)

        win32event.SetEvent(self.hWaitStop)

        logging.info("=== SERVICE STOP COMPLETE ===")

    # While service runs
    def SvcDoRun(self):
        try:
            servicemanager.LogMsg(servicemanager.EVENTLOG_INFORMATION_TYPE,
                  servicemanager.PYS_SERVICE_STARTED,
                  (self._svc_name_, ''))
            self.main()
        except Exception as e:
            logging.error(f"An unhandled exception occurred: {e}")

    # Close all Owlette windows
    def close_owlette_windows(self):
        """Close all Owlette GUI windows (config, prompts, etc.) when service stops."""
        try:
            for key, window_title in shared_utils.WINDOW_TITLES.items():
                try:
                    # Try to find the window
                    hwnd = win32gui.FindWindow(None, window_title)
                    if hwnd:
                        # Close the window
                        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
                        logging.info(f"Closed window: {window_title}")
                except Exception as e:
                    logging.debug(f"Could not close window '{window_title}': {e}")
        except Exception as e:
            logging.error(f"Error closing Owlette windows: {e}")

    # Recover PIDs from previous session
    def recover_running_processes(self):
        """
        On service restart, check if processes from previous session are still running.
        If they are, adopt them instead of launching new instances.
        Also cleans up dead PIDs to prevent unbounded file growth.
        """
        try:
            # Read the persisted state
            app_states = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)

            if not app_states:
                logging.info("No previous app states found (file empty or doesn't exist)")
                return

            logging.debug(f"Found {len(app_states)} PID(s) in app_states.json")

            # Clean up dead PIDs immediately to prevent unbounded growth
            cleaned_states = {}
            dead_pid_count = 0

            # Get current config
            config = shared_utils.read_config()
            if not config:
                logging.warning("Could not load config for process recovery")
                return

            processes = config.get('processes', [])
            logging.debug(f"Checking {len(processes)} configured process(es) for recovery")

            # Check each PID in the state file
            recovered_count = 0
            for pid_str, state_info in app_states.items():
                try:
                    # Skip invalid PID entries (e.g. "None" from failed launches)
                    if pid_str in ('None', 'null', ''):
                        dead_pid_count += 1
                        logging.debug(f"Removing invalid PID entry: '{pid_str}'")
                        continue
                    pid = int(pid_str)
                    process_id = state_info.get('id')

                    logging.debug(f"Checking PID {pid} (process ID: {process_id})")

                    # Validate PID atomically — get process info in one shot to avoid TOCTOU race
                    # (PID could be reused between an is_running check and exe() call)
                    if process_id:
                        process = next((p for p in processes if p.get('id') == process_id), None)

                        if process:
                            try:
                                actual_process = psutil.Process(pid)
                                actual_exe = actual_process.exe().lower()
                                expected_exe = process.get('exe_path', '').replace('/', '\\').lower()
                                logging.debug(f"PID {pid} is still running")

                                # Check if the executable matches
                                # Match by exe filename (basename) to handle version/path differences
                                # e.g. file association may launch a different version than configured
                                expected_basename = os.path.basename(expected_exe)
                                actual_basename = os.path.basename(actual_exe)
                                if expected_exe and (expected_exe in actual_exe or expected_basename == actual_basename):
                                    # Valid process - keep in cleaned state
                                    cleaned_states[pid_str] = state_info

                                    # Only recover if launch_mode is active
                                    mode = process.get('launch_mode', 'always' if process.get('autolaunch', False) else 'off')
                                    if mode == 'always' or (mode == 'scheduled' and shared_utils.is_within_schedule(process.get('schedules'), self._cached_site_timezone)):
                                        # Adopt this process
                                        self.last_started[process_id] = {
                                            'time': datetime.datetime.now(),
                                            'pid': pid
                                        }
                                        recovered_count += 1
                                        logging.info(f"[OK] Recovered process '{process.get('name')}' with PID {pid}")
                                    else:
                                        logging.info(f"Skipping recovery of '{process.get('name')}' (PID {pid}) - launch_mode is '{mode}'")
                                else:
                                    # PID reused for different process - don't recover
                                    dead_pid_count += 1
                                    logging.warning(f"PID {pid} is running but executable mismatch (expected: {expected_exe}, actual: {actual_exe}) - likely PID reuse, not recovering")
                            except psutil.NoSuchProcess:
                                # Process no longer running
                                dead_pid_count += 1
                                logging.debug(f"PID {pid} is no longer running")
                            except Exception as e:
                                # On validation error, keep the PID to be safe
                                cleaned_states[pid_str] = state_info
                                logging.warning(f"Could not validate PID {pid}: {e} - keeping in state")
                        else:
                            # Process ID not found in config - keep in state but don't recover
                            cleaned_states[pid_str] = state_info
                            logging.warning(f"PID {pid} is running but process ID {process_id} not found in config")
                    elif Util.is_pid_running(pid):
                        # No process ID in state - keep but warn
                        cleaned_states[pid_str] = state_info
                        logging.warning(f"PID {pid} has no process ID in state file")
                    else:
                        # PID is no longer running - don't add to cleaned_states
                        dead_pid_count += 1
                        logging.debug(f"PID {pid_str} is no longer running (will be removed from state file)")
                except Exception as e:
                    logging.error(f"Error checking PID {pid_str}: {e}")
                    # On error, keep the PID to be safe
                    cleaned_states[pid_str] = state_info

            # Write cleaned state back to file (removes dead PIDs)
            if dead_pid_count > 0:
                shared_utils.write_json_to_file(cleaned_states, shared_utils.RESULT_FILE_PATH)
                logging.info(f"[OK] Cleaned up {dead_pid_count} dead PID(s) from state file")

            if recovered_count > 0:
                logging.info(f"[OK] Successfully recovered {recovered_count} running process(es) from previous session")
            else:
                logging.debug("No running processes to recover from previous session")

        except Exception as e:
            logging.error(f"Error recovering processes from previous session: {e}")
            logging.exception("Full traceback:")

    # Log errors
    def log_and_notify(self, process, reason):
        process_name = Util.get_process_name(process)

        # Logging
        logging.error(reason)

        # Note: Gmail and Slack notifications removed - use Firebase for centralized monitoring
    
    # Terminate the tray icon process if it exists
    def terminate_tray_icon(self):
        if self.tray_icon_pid:
            try:
                psutil.Process(self.tray_icon_pid).terminate()
            except psutil.NoSuchProcess:
                logging.error("No such process to terminate.")
            except psutil.AccessDenied:
                logging.error("Access denied while trying to terminate the process.")
            except Exception as e:
                logging.error(f"An unexpected error occurred while terminating the process: {e}")

    def _is_tray_alive(self):
        """Check if the tray icon process is still running using tracked PID.
        Falls back to a process scan only if we don't have a PID."""
        # Fast path: check tracked PID
        if self.tray_icon_pid:
            try:
                proc = psutil.Process(self.tray_icon_pid)
                if proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE:
                    return True
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            # PID is stale — clear it
            self.tray_icon_pid = None

        # Slow path: the tray may have been launched by the Startup shortcut (not by us),
        # so we don't have its PID.  Do a process scan, but this is rare.
        if shared_utils.is_script_running('owlette_tray.py'):
            return True

        return False

    def _try_launch_tray(self):
        """Launch the tray icon with cooldown to avoid thrashing.
        Returns True if launched (or already running), False if skipped/failed."""
        tray_script = 'owlette_tray.py'

        # Already running?
        if self._is_tray_alive():
            return True

        # Cooldown — don't spam launches if the tray keeps crashing
        now = time.time()
        elapsed = now - self._tray_last_launch_time
        if elapsed < self._tray_launch_cooldown:
            return False

        # Try to launch
        if self.launch_python_script_as_user(tray_script):
            self._tray_last_launch_time = now
            logging.info("Tray icon launched")
            return True
        else:
            logging.debug("Could not launch tray icon (no user session?)")
            return False

    # ─── Cortex Process Management ──────────────────────────────────────

    def _is_cortex_alive(self):
        """Check if the Cortex process is still running using tracked PID."""
        if self.cortex_pid:
            try:
                proc = psutil.Process(self.cortex_pid)
                if proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE:
                    return True
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            self.cortex_pid = None

        # Fallback: check PID file written by Cortex itself
        pid_path = shared_utils.CORTEX_PID_PATH
        if os.path.exists(pid_path):
            try:
                with open(pid_path, 'r') as f:
                    pid = int(f.read().strip())
                proc = psutil.Process(pid)
                if proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE:
                    self.cortex_pid = pid
                    return True
            except (ValueError, psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                pass

        return False

    def _try_launch_cortex(self):
        """Launch the Cortex process with cooldown. Mirrors _try_launch_tray() pattern.
        Returns True if launched (or already running), False if skipped/failed."""
        # Check if enabled in config
        if not shared_utils.is_cortex_enabled():
            return False

        # Already running?
        if self._is_cortex_alive():
            return True

        # Cooldown
        now = time.time()
        elapsed = now - self._cortex_last_launch_time
        if elapsed < self._cortex_launch_cooldown:
            return False

        # Try to launch
        if self.launch_python_script_as_user('owlette_cortex.py'):
            self._cortex_last_launch_time = now
            logging.info("Cortex process launched")
            return True
        else:
            logging.debug("Could not launch Cortex (no user session?)")
            return False

    def terminate_cortex(self):
        """Terminate the Cortex process if running."""
        if self.cortex_pid:
            try:
                psutil.Process(self.cortex_pid).terminate()
                logging.info(f"Cortex process terminated (PID {self.cortex_pid})")
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            except Exception as e:
                logging.error(f"Error terminating Cortex: {e}")
            self.cortex_pid = None

    def _process_cortex_ipc_commands(self):
        """Process IPC command files from Cortex (Tier 2 tools).

        Scans ipc/cortex_commands/ for JSON files, executes the tool,
        writes result to ipc/cortex_results/.
        """
        cmd_dir = shared_utils.CORTEX_IPC_CMD_DIR
        result_dir = shared_utils.CORTEX_IPC_RESULT_DIR

        if not os.path.isdir(cmd_dir):
            return

        try:
            files = [f for f in os.listdir(cmd_dir) if f.endswith('.json')]
        except OSError:
            return

        for filename in files:
            cmd_path = os.path.join(cmd_dir, filename)
            try:
                with open(cmd_path, 'r', encoding='utf-8') as f:
                    cmd = json.load(f)

                cmd_id = cmd.get('id', filename.replace('.json', ''))
                tool_name = cmd.get('tool_name', '')
                tool_params = cmd.get('tool_params', {})

                logging.debug(f"Processing Cortex IPC command: {cmd_id} ({tool_name})")

                # Execute the tool via the existing command system
                result = self._execute_cortex_command(tool_name, tool_params)

                # Write result
                os.makedirs(result_dir, exist_ok=True)
                result_path = os.path.join(result_dir, f"{cmd_id}.json")
                tmp_path = result_path + '.tmp'
                with open(tmp_path, 'w', encoding='utf-8') as f:
                    json.dump({'id': cmd_id, 'result': result}, f)
                os.replace(tmp_path, result_path)

                # Remove processed command
                os.remove(cmd_path)
                logging.debug(f"Cortex IPC command completed: {cmd_id}")

            except Exception as e:
                logging.error(f"Error processing Cortex IPC command {filename}: {e}")
                # Remove corrupt command to prevent infinite retry
                try:
                    os.remove(cmd_path)
                except OSError:
                    pass

    def _execute_cortex_command(self, tool_name, tool_params):
        """Execute a Cortex IPC tool command using existing service logic.

        Maps Tier 2 tool names to the service's existing command handlers.
        """
        process_name = tool_params.get('process_name', '')

        if tool_name == 'restart_process':
            return self._handle_cortex_process_command('restart_process', process_name)
        elif tool_name == 'kill_process':
            return self._handle_cortex_process_command('kill_process', process_name)
        elif tool_name == 'start_process':
            return self._handle_cortex_process_command('restart_process', process_name)
        elif tool_name == 'set_launch_mode':
            mode = tool_params.get('mode', 'off')
            schedules = tool_params.get('schedules')
            return self._handle_cortex_set_launch_mode(process_name, mode, schedules)
        else:
            return {'error': f'Unknown Cortex IPC tool: {tool_name}'}

    def _handle_cortex_process_command(self, command_type, process_name):
        """Handle a process restart/kill/start command from Cortex IPC."""
        config = shared_utils.read_config()
        processes = config.get('processes', [])

        # Find the process
        target = None
        for proc in processes:
            if proc.get('name', '').lower() == process_name.lower():
                target = proc
                break

        if not target:
            return {'error': f'Process not found: {process_name}'}

        try:
            if command_type == 'kill_process':
                shared_utils.graceful_terminate(target)
                return {'status': 'completed', 'result': f'Process {process_name} terminated'}
            else:
                # restart_process (also used for start)
                shared_utils.graceful_terminate(target)
                time.sleep(1)
                # The main loop will re-launch the process if autolaunch/launch_mode is set
                return {'status': 'completed', 'result': f'Process {process_name} restarted'}
        except Exception as e:
            return {'status': 'failed', 'error': str(e)}

    def _handle_cortex_set_launch_mode(self, process_name, mode, schedules=None):
        """Handle a set_launch_mode command from Cortex IPC."""
        config = shared_utils.read_config()
        processes = config.get('processes', [])

        for proc in processes:
            if proc.get('name', '').lower() == process_name.lower():
                proc['launch_mode'] = mode
                if mode == 'scheduled' and schedules:
                    proc['schedules'] = schedules
                shared_utils.write_config(config)
                return {'status': 'completed', 'result': f'Launch mode set to {mode} for {process_name}'}

        return {'error': f'Process not found: {process_name}'}

    def _write_cortex_event(self, process_name, error_message, event_type):
        """Write an IPC event file for Cortex autonomous investigation.

        Args:
            process_name: Name of the affected process.
            error_message: Description of what happened.
            event_type: 'process_crash' or 'process_start_failed'.
        """
        if not shared_utils.is_cortex_enabled():
            return

        events_dir = shared_utils.CORTEX_IPC_EVENTS_DIR
        os.makedirs(events_dir, exist_ok=True)

        event_id = f"evt_{int(time.time()*1000)}_{process_name}"
        event_path = os.path.join(events_dir, f"{event_id}.json")

        event = {
            'id': event_id,
            'processName': process_name,
            'errorMessage': error_message,
            'eventType': event_type,
            'machineId': socket.gethostname(),
            'machineName': socket.gethostname(),
            'timestamp': time.time(),
        }

        try:
            tmp_path = event_path + '.tmp'
            with open(tmp_path, 'w', encoding='utf-8') as f:
                json.dump(event, f)
            os.replace(tmp_path, event_path)
            logging.info(f"Cortex event written: {event_id} ({event_type}: {process_name})")
        except Exception as e:
            logging.error(f"Failed to write Cortex event: {e}")

    # ─── End Cortex ───────────────────────────────────────────────────────

    def _find_running_process_by_exe(self, exe_path, file_path=None):
        """Find a running process by its executable path.

        Used during startup to detect processes that survived a service restart
        (thanks to AppKillProcessTree=0), so we adopt them instead of launching duplicates.
        Matches by exe filename (basename) to handle version/path differences when
        file association launches a different version than configured.

        When file_path is provided, also checks the command line to distinguish
        between multiple instances of the same exe (e.g. different .toe files).
        """
        try:
            exe_lower = exe_path.replace('/', '\\').lower()
            exe_basename = os.path.basename(exe_lower)
            file_path_lower = file_path.replace('/', '\\').lower() if file_path else None
            for proc in psutil.process_iter(['pid', 'exe']):
                try:
                    if proc.info['exe']:
                        proc_exe = proc.info['exe'].lower()
                        if proc_exe == exe_lower or os.path.basename(proc_exe) == exe_basename:
                            # If file_path specified, check command line to distinguish instances
                            if file_path_lower:
                                try:
                                    cmdline = ' '.join(proc.cmdline()).lower()
                                    if file_path_lower not in cmdline:
                                        continue  # Wrong instance, keep looking
                                except (psutil.NoSuchProcess, psutil.AccessDenied):
                                    continue  # Can't verify cmdline, skip to avoid false match
                            return proc.info['pid']
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
        except Exception:
            pass
        return None

    def _enable_privileges(self):
        """Enable critical privileges in the service process token.

        LocalSystem has SE_TCB_PRIVILEGE assigned but it may not be enabled
        in the inherited token (e.g. when NSSM spawns the Python child process).
        WTSQueryUserToken requires it to be enabled. We also enable
        SeAssignPrimaryTokenPrivilege and SeIncreaseQuotaPrivilege which
        CreateProcessAsUser needs.
        """
        privileges_to_enable = [
            'SeTcbPrivilege',               # Required by WTSQueryUserToken
            'SeAssignPrimaryTokenPrivilege', # Required by CreateProcessAsUser
            'SeIncreaseQuotaPrivilege',      # Required by CreateProcessAsUser
        ]

        try:
            import ctypes
            process_token = win32security.OpenProcessToken(
                win32process.GetCurrentProcess(),
                win32security.TOKEN_ADJUST_PRIVILEGES | win32security.TOKEN_QUERY
            )

            enabled = []
            failed = []
            for priv_name in privileges_to_enable:
                try:
                    luid = win32security.LookupPrivilegeValue('', priv_name)
                    win32security.AdjustTokenPrivileges(
                        process_token, False,
                        [(luid, win32security.SE_PRIVILEGE_ENABLED)]
                    )
                    # AdjustTokenPrivileges returns success even if privilege not held —
                    # must check GetLastError for ERROR_NOT_ALL_ASSIGNED (1300)
                    if ctypes.windll.kernel32.GetLastError() == 1300:
                        failed.append(priv_name)
                    else:
                        enabled.append(priv_name)
                except Exception as e:
                    failed.append(f"{priv_name} ({e})")

            process_token.Close()

            if enabled:
                logging.info(f"Privileges enabled: {', '.join(enabled)}")
            if failed:
                logging.warning(f"Privileges NOT available (will use fallback): {', '.join(failed)}")

        except Exception as e:
            logging.warning(f"Could not adjust process privileges: {e}")

    def _get_token_from_user_process(self, session_id):
        """Obtain a user token by duplicating from a process in the target session.

        Fallback for when WTSQueryUserToken fails (error 1314). Opens an
        existing user-session process (explorer.exe preferred), duplicates
        its token as a primary token, and returns it with the environment block.

        This does NOT require SE_TCB_PRIVILEGE — LocalSystem can open any
        process token via PROCESS_QUERY_INFORMATION.

        Returns:
            (token, environment) on success, (None, None) on failure.
        """
        import ctypes

        PROCESS_QUERY_INFORMATION = 0x0400

        # Candidates in order of preference — explorer.exe has the richest
        # desktop context; dwm.exe runs even on locked/minimal sessions.
        candidates = ['explorer.exe', 'sihost.exe', 'taskhostw.exe', 'dwm.exe']

        for candidate_name in candidates:
            for proc in psutil.process_iter(['pid', 'name']):
                try:
                    if not proc.info['name'] or proc.info['name'].lower() != candidate_name:
                        continue

                    pid = proc.info['pid']

                    # Check if this process is in the target session
                    proc_session_id = ctypes.c_ulong(0)
                    if not ctypes.windll.kernel32.ProcessIdToSessionId(
                        pid, ctypes.byref(proc_session_id)
                    ):
                        continue
                    if proc_session_id.value != session_id:
                        continue

                    # Open the process
                    proc_handle = ctypes.windll.kernel32.OpenProcess(
                        PROCESS_QUERY_INFORMATION, False, pid
                    )
                    if not proc_handle:
                        continue

                    try:
                        # Open the process token
                        token = win32security.OpenProcessToken(
                            proc_handle,
                            win32security.TOKEN_DUPLICATE | win32security.TOKEN_QUERY
                        )

                        # Duplicate as primary token for CreateProcessAsUser
                        dup_token = win32security.DuplicateTokenEx(
                            token,
                            win32security.TOKEN_ALL_ACCESS,
                            None,  # SECURITY_ATTRIBUTES
                            win32security.SecurityImpersonation,
                            win32security.TokenPrimary
                        )
                        token.Close()

                        # Create environment block from the duplicated token
                        environment = win32profile.CreateEnvironmentBlock(dup_token, False)

                        logging.info(
                            f"Obtained user token from {candidate_name} "
                            f"(PID {pid}, session {session_id})"
                        )
                        return dup_token, environment

                    finally:
                        ctypes.windll.kernel32.CloseHandle(proc_handle)

                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
                except Exception as e:
                    logging.debug(
                        f"Failed to get token from {candidate_name} "
                        f"PID {proc.info.get('pid', '?')}: {e}"
                    )
                    continue

        logging.warning(f"Could not obtain token from any user process in session {session_id}")
        return None, None

    def _refresh_user_token(self):
        """Re-obtain the console user token, session ID, and environment block.

        Uses a three-tier approach:
        1. WTSQueryUserToken (standard API, requires SE_TCB_PRIVILEGE)
        2. Token cloning from explorer.exe (fallback, no SE_TCB needed)
        3. Cached token from previous successful call (last resort)
        """
        try:
            session_id = win32ts.WTSGetActiveConsoleSessionId()
            if session_id == 0xFFFFFFFF:
                logging.warning("No active console session (headless/locked machine)")
                self.console_session_id = None
                self.console_user_token = None
                self.environment = None
                return False

            # Tier 1: WTSQueryUserToken (standard path)
            token = None
            environment = None
            try:
                token = win32ts.WTSQueryUserToken(session_id)
                environment = win32profile.CreateEnvironmentBlock(token, False)
            except Exception as e:
                error_code = getattr(e, 'winerror', 0)
                if error_code == 1314:
                    logging.debug("WTSQueryUserToken failed (error 1314) — trying token cloning")
                else:
                    logging.debug(f"WTSQueryUserToken failed: {e} — trying token cloning")
                token = None
                environment = None

            # Tier 2: Clone token from explorer.exe (fallback)
            if token is None:
                token, environment = self._get_token_from_user_process(session_id)

            # Tier 3: Use cached token (last resort)
            if token is None:
                if self.console_user_token:
                    logging.debug("Falling back to cached user token")
                    return True
                self.console_session_id = None
                self.console_user_token = None
                self.environment = None
                return False

            # Success — update cached token
            if self.console_user_token and self.console_user_token != token:
                try:
                    self.console_user_token.Close()
                except Exception as e:
                    logging.debug(f"Could not close old user token: {e}")

            self.console_session_id = session_id
            self.console_user_token = token
            self.environment = environment

            if session_id != getattr(self, '_last_logged_session_id', None):
                logging.info(f"User token refreshed for console session {session_id}")
                self._last_logged_session_id = session_id

            return True

        except Exception as e:
            logging.warning(f"Could not obtain console user token: {e}")
            if self.console_user_token:
                logging.debug("Falling back to cached user token")
                return True
            self.console_session_id = None
            self.console_user_token = None
            self.environment = None
            return False

    # Start a python script as a user
    def launch_python_script_as_user(self, script_name, args=None):
        try:
            # Get full path to Python interpreter (handles bundled Python installations)
            try:
                python_exe = shared_utils.get_python_exe_path()
            except FileNotFoundError as e:
                logging.error(f"Cannot launch script {script_name}: {e}")
                return False

            # Refresh token to handle session changes since service startup
            self._refresh_user_token()
            if not self.console_user_token:
                logging.error(f"Cannot launch script {script_name}: no interactive user session")
                return False

            # Use a fresh STARTUPINFO with the interactive desktop so the tray icon
            # (and any other UI script) can access the notification area / create windows.
            # Without lpDesktop, the process inherits the service's hidden desktop.
            si = win32process.STARTUPINFO()
            si.dwFlags = win32process.STARTF_USESHOWWINDOW
            si.wShowWindow = win32con.SW_HIDE
            si.lpDesktop = "WinSta0\\Default"

            command_line = f'"{python_exe}" "{shared_utils.get_path(script_name)}" {args}' if args else f'"{python_exe}" "{shared_utils.get_path(script_name)}"'
            _, _, pid, _ = win32process.CreateProcessAsUser(self.console_user_token,
                None,  # Application Name
                command_line,  # Command Line
                None,
                None,
                0,
                win32con.NORMAL_PRIORITY_CLASS,
                self.environment,
                None,
                si)
            if 'owlette_tray.py' in script_name:
                self.tray_icon_pid = pid
            elif 'owlette_cortex.py' in script_name:
                self.cortex_pid = pid
            return True
        except Exception as e:
            logging.error(f"Failed to start process: {e}")
            return False

    def execute_in_user_session(self, job_type, code, timeout=30):
        """Execute code in the interactive user's desktop session.

        Launches session_exec.py via CreateProcessAsUser, which runs
        Python/cmd/PowerShell in the user's session and writes the result
        to an IPC file.

        Args:
            job_type: 'python', 'cmd', or 'powershell'
            code: The code or command string to execute
            timeout: Max execution time in seconds (default 30, max 120)

        Returns:
            dict with keys: stdout, stderr, exitCode, error, durationMs, files
            On failure returns dict with 'error' key.
        """
        import uuid
        import json as _json

        request_id = str(uuid.uuid4())
        ipc_dir = shared_utils.get_data_path('ipc')
        output_dir = os.path.join(ipc_dir, 'results', request_id)
        job_path = os.path.join(ipc_dir, 'jobs', f'{request_id}.json')
        result_path = os.path.join(output_dir, 'result.json')

        os.makedirs(os.path.join(ipc_dir, 'jobs'), exist_ok=True)
        os.makedirs(output_dir, exist_ok=True)

        # Write job file
        job = {
            'type': job_type,
            'code': code,
            'timeout': min(timeout, 120),
            'outputDir': output_dir,
        }
        with open(job_path, 'w') as f:
            _json.dump(job, f)

        try:
            # Launch session_exec.py in the user's session
            success = self.launch_python_script_as_user(
                'session_exec.py', f'"{job_path}"'
            )
            if not success:
                return {'error': 'Failed to launch in user session — no interactive session available'}

            # Poll for result (timeout + 5s grace period for startup)
            poll_timeout = timeout + 5
            start = time.time()
            while time.time() - start < poll_timeout:
                if os.path.exists(result_path):
                    # Wait briefly for file to be fully written
                    time.sleep(0.2)
                    try:
                        with open(result_path, 'r') as f:
                            result = _json.load(f)
                        return result
                    except (_json.JSONDecodeError, IOError):
                        time.sleep(0.3)
                        continue
                time.sleep(0.5)

            return {'error': f'Execution timed out after {timeout}s'}

        finally:
            # Cleanup job file (result dir cleaned up by caller if needed)
            try:
                os.remove(job_path)
            except OSError:
                pass

    def get_session_output_path(self, request_id, filename):
        """Get the path to an output file from a user session execution."""
        return os.path.join(
            shared_utils.get_data_path('ipc'), 'results', request_id, filename
        )

    @staticmethod
    def _validate_path(path, label="Path"):
        """Validate a file/directory path for security.
        Rejects UNC paths (remote shares) and symbolic links to prevent
        path-based attacks from Firestore-sourced configuration.
        """
        if not path:
            return path
        # Reject UNC paths (\\server\share) to prevent remote share attacks
        if path.startswith('\\\\') or path.startswith('//'):
            raise ValueError(f"{label} cannot be a UNC/network path: {path}")
        # Normalize to absolute path to prevent traversal
        resolved = os.path.abspath(path)
        # Reject symbolic links
        if os.path.islink(resolved):
            raise ValueError(f"{label} cannot be a symbolic link: {path}")
        return resolved

    # Start a Windows process as a user
    def launch_process_as_user(self, process):
        # Get visibility, default is shown
        visibility = process.get('visibility', 'Show')

        # Map process priority, default is normal
        priority = process.get('priority', 'Normal')

        # Fetch and verify executable path
        exe_path = process.get('exe_path', '')
        # Convert forward slashes to backslashes for Windows
        exe_path = exe_path.replace('/', '\\')
        try:
            exe_path = self._validate_path(exe_path, "Executable path")
            if not os.path.isfile(exe_path):
                raise FileNotFoundError('Executable path not found!')
        except (ValueError, FileNotFoundError) as e:
            logging.error(f'Error: {e}')
            return None

        # Fetch file path
        file_path = process.get('file_path', '')
        if file_path:
            # Convert forward slashes to backslashes for Windows
            file_path = file_path.replace('/', '\\')
            try:
                file_path = self._validate_path(file_path, "File path")
            except ValueError as e:
                logging.error(f'Error: {e}')
                return None
        # If file path exists, leave as-is (could be file or cmd args)
        file_path = f"{file_path}" if os.path.isfile(file_path) else file_path
        logging.info(f"Starting {exe_path}{' ' if file_path else ''}{file_path}...")

        # Fetch working directory (convert empty string to None)
        cwd = process.get('cwd', None)
        if cwd == '':
            cwd = None
        if cwd:
            try:
                cwd = self._validate_path(cwd, "Working directory")
            except ValueError as e:
                logging.error(f'Error: {e}')
                return None
        if cwd and not os.path.isdir(cwd):
            logging.error(f"Working directory {cwd} does not exist.")
            return None

        # Launch the process as the logged-in user via CreateProcessAsUser.
        # Token is refreshed before each launch to handle session changes.

        # Normalize visibility (backward compatible with Show/Hide)
        if visibility == 'Show':
            visibility = 'Normal'
        elif visibility == 'Hide':
            visibility = 'Hidden'

        if cwd:
            logging.info(f"Command will run in directory: {cwd}")

        logging.info(f"Launching: {exe_path}{' ' + file_path if file_path else ''} "
                     f"(visibility={visibility}, priority={priority})")

        pid = None

        # Refresh user token to handle session changes (logout/login, RDP, user switch)
        self._refresh_user_token()

        if not self.console_user_token:
            logging.error("No interactive user session available - cannot launch process")
            return None

        # Launch via process_launcher.py helper in the user's session.
        #
        # The helper is launched via CreateProcessAsUser into the user's session,
        # then uses ShellExecuteEx (ctypes) to launch the target with full
        # desktop/GPU context. The PID is returned immediately from the process handle.
        import json as json_module

        tmp_dir = shared_utils.get_data_path('tmp')
        pid_file = os.path.join(tmp_dir, f'pid_{int(time.time())}_{os.getpid()}.txt')
        args_file = os.path.join(tmp_dir, f'launch_{int(time.time())}_{os.getpid()}.json')

        try:
            launch_args = {
                'exe_path': exe_path,
                'file_path': file_path,
                'cwd': cwd,
                'visibility': visibility,
                'priority': priority,
                'pid_file': pid_file
            }
            with open(args_file, 'w') as f:
                json_module.dump(launch_args, f)

            python_exe = shared_utils.get_python_exe_path()
            launcher_script = shared_utils.get_path('process_launcher.py')
            helper_cmd = f'"{python_exe}" "{launcher_script}" "{args_file}"'

            startup_info = win32process.STARTUPINFO()
            startup_info.lpDesktop = "WinSta0\\Default"

            # DETACHED_PROCESS: no console for the helper. It only makes COM
            # calls — it doesn't need GUI access. The target gets GUI context
            # via Task Scheduler + cmd /c start.
            DETACHED_PROCESS = 0x00000008
            _, _, helper_pid, _ = win32process.CreateProcessAsUser(
                self.console_user_token,
                None,
                helper_cmd,
                None, None, 0,
                win32con.NORMAL_PRIORITY_CLASS | DETACHED_PROCESS,
                self.environment,
                None,
                startup_info
            )
            logging.debug(f"Launcher helper started with PID {helper_pid}")

            # Wait for the helper to write the PID file.
            # The helper uses ShellExecuteEx which returns the PID immediately,
            # so the PID file should appear within 1-2 seconds. The 5s timeout
            # is generous to account for file association launches that need
            # a moment to resolve the real app PID.
            for _ in range(50):  # 5 second timeout
                if os.path.exists(pid_file):
                    time.sleep(0.3)
                    break
                time.sleep(0.1)

            if os.path.exists(pid_file):
                with open(pid_file, 'r') as f:
                    pid_content = f.read().strip()

                try:
                    result = json_module.loads(pid_content)
                except (json_module.JSONDecodeError, ValueError):
                    if pid_content.startswith('ERROR:'):
                        logging.error(f"Launcher helper failed: {pid_content}")
                        return None
                    result = {'pid': int(pid_content)}

                if 'error' in result:
                    logging.error(f"Launcher helper failed: {result['error']}")
                    return None

                pid = result['pid']
                if result.get('adopted'):
                    logging.info(f"Adopted existing process with PID {pid} (single-instance app)")
                else:
                    logging.info(f"Process launched with PID {pid}")
            else:
                logging.error("Launcher helper did not produce a PID file within timeout")
                # Fallback: process may have launched but psutil couldn't see it in time.
                # Scan by exe before giving up — prevents spurious failed=True and double-launches.
                found_pid = self._find_running_process_by_exe(exe_path, file_path)
                if found_pid:
                    logging.info(f"Fallback scan found process (PID {found_pid}) after PID file timeout")
                    return found_pid
                return None

        except Exception as e:
            logging.error(f"Process launch failed: {e}")
            logging.exception("Full traceback:")
            return None
        finally:
            for f in [args_file, pid_file]:
                try:
                    if os.path.exists(f):
                        os.unlink(f)
                except Exception as e:
                    logging.debug(f"Could not clean up temp file {f}: {e}")

        # Get the current Unix timestamp
        self.current_timestamp = int(time.time())

        # Read existing results from the output file
        # read_json_from_file now always returns {} instead of None, so no need for try-except
        self.results = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)

        # Defensive programming: ensure self.results is never None
        if self.results is None:
            logging.warning("read_json_from_file returned None (should not happen), using empty dict")
            self.results = {}

        # Initialize the entry for the PID if it doesn't exist
        if str(pid) not in self.results:
            self.results[str(pid)] = {}

        # Record the timestamp for the newly started process
        self.results[str(pid)]['timestamp'] = self.current_timestamp

        # Add process list ID
        self.results[str(pid)]['id'] = process['id']

        # Update status
        self.results[str(pid)]['status'] = 'LAUNCHING'

        # Write the updated results back to the output file
        try:
            shared_utils.write_json_to_file(self.results, shared_utils.RESULT_FILE_PATH)
        except Exception as e:
            logging.error(f'JSON write error: {e}')

        # Process launched - status will sync via centralized metrics loop
        # (removed direct upload to eliminate duplicates and reduce Firebase writes)
        logging.info(f"[OK] Process launched: PID {pid} -> Will sync on next metrics interval")

        return pid

    # Check if process has been restarted more than n times already
    def reached_max_relaunch_attempts(self, process):
        process_name = Util.get_process_name(process)
        try:
            attempts = self.relaunch_attempts.get(process_name, 0 if self.first_start else 1)

            process_list_id = shared_utils.fetch_process_id_by_name(process_name, shared_utils.read_config())
            relaunches_to_attempt = int(shared_utils.read_config(keys=['relaunch_attempts'], process_list_id=process_list_id))
            if not relaunches_to_attempt:
                relaunches_to_attempt = MAX_RELAUNCH_ATTEMPTS

            # Check if restart prompt is running
            if not shared_utils.is_script_running('prompt_restart.py'):
                # If attempts are less than or equal to the relaunch attempts, log it
                if 0 < attempts <= relaunches_to_attempt:
                    self.log_and_notify(
                        process,
                        f'Process relaunch attempt: {attempts} of {relaunches_to_attempt}'
                    )
                # If this is more than the maximum number of attempts allowed
                if attempts > relaunches_to_attempt and relaunches_to_attempt != 0:
                    # Write reboot_pending to Firestore so dashboard can approve/dismiss remotely
                    if self.firebase_client and self.firebase_client.is_connected():
                        self.firebase_client.set_reboot_pending(
                            process_name=process_name,
                            reason=f'{process_name} crashed {relaunches_to_attempt} times',
                            timestamp=time.time()
                        )

                    # If a restart prompt isn't already running, open one (local fallback)
                    started_restart_prompt = self.launch_python_script_as_user(
                        shared_utils.get_path('prompt_restart.py'),
                        None
                    )
                    if started_restart_prompt:
                        self.log_and_notify(
                            process,
                            f'Terminated {process_name} {relaunches_to_attempt} times. System reboot imminent'
                        )
                        # Reset the counter for this process
                        del self.relaunch_attempts[process_name]
                        return True
                    else:
                        logging.info('Failed to open restart prompt.')
            else:
                return True # If it's running, we've already reached the max attempts

            self.relaunch_attempts[process_name] = attempts + 1
            return False

        except Exception as e:
            logging.info(e)

    # Kill and restart a process
    def kill_and_relaunch_process(self, pid, process):
        # Ensure process has not exceeded maximum relaunch attempts
        process_name = Util.get_process_name(process)
        if not self.reached_max_relaunch_attempts(process):
            try:
                # Gracefully terminate (WM_CLOSE then hard kill)
                shared_utils.graceful_terminate(pid)

                # Log process kill event
                if self.firebase_client and self.firebase_client.is_connected():
                    self.firebase_client.log_event(
                        action='process_killed',
                        level='warning',
                        process_name=process_name,
                        details=f'Terminated PID {pid} for restart'
                    )

                # Launch new process
                new_pid = self.launch_process_as_user(process)

                if new_pid is None:
                    logging.error(f"Relaunch of {process_name} failed - no PID returned")
                    return None

                self.log_and_notify(
                    process,
                    f'Terminated PID {pid} and restarted with new PID {new_pid}'
                )
                # Status message - sync to Firebase immediately
                shared_utils.update_process_status_in_json(new_pid, 'LAUNCHING', self.firebase_client, process_id=process.get('id'))

                return new_pid

            except Exception as e:
                self.log_and_notify(
                    process,
                    f"Could not kill and restart process {pid}. Error: {e}"
                )
                # Log process crash/failure
                if self.firebase_client and self.firebase_client.is_connected():
                    self.firebase_client.log_event(
                        action='process_crash',
                        level='error',
                        process_name=process_name,
                        details=f'Failed to kill and restart PID {pid}: {str(e)}'
                    )
                    self.firebase_client.send_process_alert(
                        process_name, f'Failed to kill and restart PID {pid}: {str(e)}', 'process_crash'
                    )
                self._write_cortex_event(process_name, f'Failed to kill and restart PID {pid}: {str(e)}', 'process_crash')
                return None

    # Attempt to launch the process if not running
    def handle_process_launch(self, process):
        # Validate executable path before attempting launch
        exe_path = process.get('exe_path', '').strip()
        if not exe_path:
            process_name = Util.get_process_name(process)
            logging.error(f"Cannot launch '{process_name}': Executable path is not set. Please configure a valid exe_path and set launch mode to Always On or Scheduled.")
            self.last_started[process.get('id', '')] = {'time': datetime.datetime.now(), 'pid': None, 'failed': True}
            return None

        if not os.path.isfile(exe_path):
            process_name = Util.get_process_name(process)
            logging.error(f"Cannot launch '{process_name}': Executable path does not exist: {exe_path}")
            self.last_started[process.get('id', '')] = {'time': datetime.datetime.now(), 'pid': None, 'failed': True}
            return None

        # Ensure process has not exceeded maximum relaunch attempts
        if not self.reached_max_relaunch_attempts(process):
            process_list_id = process['id']
            delay = float(process.get('time_delay', 0))

            # Fetch the time to init (how long to give the app to initialize itself / start up)
            time_to_init = float(shared_utils.read_config(keys=['time_to_init'], process_list_id=process_list_id))

            # Give the app time to launch (if it's launching for the first time)
            last_info = self.last_started.get(process_list_id, {})
            last_time = last_info.get('time')

            if last_time is None or (last_time is not None and (self.current_time - last_time).total_seconds() >= (time_to_init or TIME_TO_INIT)):
                # Delay starting of the app (if applicable)
                time.sleep(delay)

                # Attempt to start the process
                try:
                    pid = self.launch_process_as_user(process)
                except Exception as e:
                    logging.error(f"Could not start process {Util.get_process_name(process)}.\n {e}")
                    # Log process start failure
                    if self.firebase_client and self.firebase_client.is_connected():
                        self.firebase_client.log_event(
                            action='process_start_failed',
                            level='error',
                            process_name=Util.get_process_name(process),
                            details=str(e)
                        )
                        self.firebase_client.send_process_alert(
                            Util.get_process_name(process), str(e), 'process_start_failed'
                        )
                    self._write_cortex_event(Util.get_process_name(process), str(e), 'process_start_failed')
                    return None

                # Only update tracking if we got a valid PID
                if pid is None:
                    logging.error(f"Launch returned no PID for {Util.get_process_name(process)} - will not track or retry this cycle")
                    # Store a launch-failed marker with timestamp so we don't retry immediately.
                    # The 'failed' flag tells handle_process to wait before retrying.
                    # Use datetime.now() (not self.current_time) so the cooldown starts from
                    # the actual failure time, not the start of the loop iteration — otherwise
                    # blocking launches cause the cooldown to expire too early on the next cycle.
                    self.last_started[process_list_id] = {'time': datetime.datetime.now(), 'pid': None, 'failed': True}
                    return None

                # Update the last started time and PID (use real time, not loop-start time)
                self.last_started[process_list_id] = {'time': datetime.datetime.now(), 'pid': pid}
                logging.info(f"PID {pid} started")

                # Log process start event
                if self.firebase_client and self.firebase_client.is_connected():
                    self.firebase_client.log_event(
                        action='process_started',
                        level='info',
                        process_name=Util.get_process_name(process),
                        details=f'PID {pid}'
                    )

                return pid  # Return the new PID

            return None  # Return None if the process was not started

    # If process not responding, attempt to kill and relaunch
    # Uses confirmation-based detection: process must be hung for HANG_CONFIRM_SECONDS before killing
    HANG_CONFIRM_SECONDS = 15  # Require ~3 consecutive checks (at 5s intervals) before killing

    def handle_unresponsive_process(self, pid, process):
        # Check if hang detection is disabled for this process
        if not process.get('check_responsive', True):
            return None

        # Check JSON for process response status
        process_name = Util.get_process_name(process)
        try:
            process_results = self.results.get(str(pid), {})
            responsive = process_results.get('responsive', True)
            hung_since = process_results.get('hung_since', None)
        except json.JSONDecodeError:
            logging.error("Failed to decode JSON from result file")
            responsive = True
            hung_since = None
        except Exception:
            logging.error("An unexpected error occurred")
            responsive = True
            hung_since = None

        # Check if process is unresponsive
        if not responsive and hung_since:
            current_time = int(time.time())
            hung_duration = current_time - hung_since

            # Log when first detected as hung (hung_duration will be small on first detection)
            if hung_duration < 10:  # First detection (within first check cycle)
                logging.warning(f"Process {process_name} (PID {pid}) appears to be not responding, monitoring...")
                # Set status to STALLED but don't kill yet
                shared_utils.update_process_status_in_json(pid, 'STALLED', self.firebase_client, process_id=process.get('id'))
                return None  # Don't kill yet, wait for confirmation

            # Only kill after confirmed hang (multiple checks)
            if hung_duration >= self.HANG_CONFIRM_SECONDS:
                self.log_and_notify(
                    process,
                    f"Process {process_name} (PID {pid}) not responding for {hung_duration}s, restarting"
                )
                time.sleep(1)
                new_pid = self.kill_and_relaunch_process(pid, process)
                return new_pid
            else:
                # Still waiting for confirmation
                logging.debug(f"Process {process_name} (PID {pid}) hung for {hung_duration}s, waiting for confirmation ({self.HANG_CONFIRM_SECONDS}s threshold)")
                return None

        return None

    # Main process handler
    def handle_process(self, process):
        process_list_id = process['id']
        last_info = self.last_started.get(process_list_id, {})
        last_pid = last_info.get('pid')

        # Launch process if this is the first startup
        if self.first_start:
            # Check if we've already recovered this process from a previous session
            if not last_pid:
                # Before launching, check if process is already running
                # (e.g., survived a service restart due to AppKillProcessTree=0)
                exe_path = process.get('exe_path', '')
                file_path = process.get('file_path', '')
                existing_pid = self._find_running_process_by_exe(exe_path, file_path) if exe_path else None
                if existing_pid:
                    self.last_started[process_list_id] = {
                        'time': datetime.datetime.now(),
                        'pid': existing_pid
                    }
                    shared_utils.update_process_status_in_json(existing_pid, 'RUNNING', self.firebase_client, process_id=process_list_id)
                    logging.info(f"[OK] Adopted already-running '{process.get('name')}' (PID {existing_pid})")
                    new_pid = None
                else:
                    new_pid = self.handle_process_launch(process)
            else:
                # Process was recovered from previous session, just use it - sync to Firebase immediately
                shared_utils.update_process_status_in_json(last_pid, 'RUNNING', self.firebase_client, process_id=process_list_id)
                logging.debug(f"Using recovered process '{process.get('name')}' with PID {last_pid}")
                new_pid = None  # Don't update last_started since it's already set

        else:
            # If previous launch failed (PID detection failed), try to find the process
            # by exe+cmdline scan before attempting another launch
            if last_info.get('failed'):
                exe_path = process.get('exe_path', '')
                file_path = process.get('file_path', '')
                found_pid = self._find_running_process_by_exe(exe_path, file_path) if exe_path else None
                if found_pid:
                    self.last_started[process_list_id] = {
                        'time': datetime.datetime.now(),
                        'pid': found_pid
                    }
                    shared_utils.update_process_status_in_json(found_pid, 'RUNNING', self.firebase_client, process_id=process_list_id)
                    logging.info(f"[OK] Adopted '{Util.get_process_name(process)}' after failed PID detection (PID {found_pid})")
                    return
                # Cooldown: don't retry launch until max(time_to_init, 60s) has elapsed.
                # The 60s minimum prevents double-launching slow apps (e.g. Sublime, TouchDesigner)
                # that take a long time to appear in psutil after a Task Scheduler launch.
                last_time = last_info.get('time')
                if last_time:
                    time_to_init = max(float(process.get('time_to_init', 0) or TIME_TO_INIT), 60.0)
                    elapsed = (self.current_time - last_time).total_seconds()
                    if elapsed < time_to_init:
                        return  # Still cooling down, skip this cycle

            # Check if process is running
            if last_pid and Util.is_pid_running(last_pid):
                # Grace period: skip responsiveness check while process is still initializing
                last_time = last_info.get('time')
                time_to_init = float(process.get('time_to_init', 0) or TIME_TO_INIT)
                if last_time and (self.current_time - last_time).total_seconds() < time_to_init:
                    # Still within init grace period - mark as LAUNCHING, skip responsiveness check
                    shared_utils.update_process_status_in_json(last_pid, 'LAUNCHING', self.firebase_client, process_id=process_list_id)
                    new_pid = None
                else:
                    # Launch scout to check if process is responsive
                    self.launch_python_script_as_user(
                        shared_utils.get_path('owlette_scout.py'),
                        str(last_pid)
                    )
                    new_pid = self.handle_unresponsive_process(last_pid, process)

                #  Everything is fine, keep calm and carry on - sync to Firebase immediately
                if not new_pid:
                    shared_utils.update_process_status_in_json(last_pid, 'RUNNING', self.firebase_client, process_id=process_list_id)

            else:
                # Process crashed or was manually closed
                if last_pid:
                    # Check if process was manually killed (don't log crash if it was)
                    try:
                        results = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)
                        # Defensive programming: ensure results is never None
                        if results is None:
                            results = {}
                        process_status = results.get(str(last_pid), {}).get('status', '')
                        was_manually_killed = (process_status == 'KILLED')
                    except Exception as e:
                        logging.warning(f"Error checking manual kill status: {e}")
                        was_manually_killed = False

                    # Only log crash if it wasn't manually killed
                    if not was_manually_killed:
                        process_name = Util.get_process_name(process)
                        if self.firebase_client and self.firebase_client.is_connected():
                            self.firebase_client.log_event(
                                action='process_crash',
                                level='error',
                                process_name=process_name,
                                details=f'Process stopped unexpectedly (PID {last_pid} no longer running)'
                            )
                            self.firebase_client.send_process_alert(
                                process_name, f'Process stopped unexpectedly (PID {last_pid} no longer running)', 'process_crash'
                            )
                        self._write_cortex_event(process_name, f'Process stopped unexpectedly (PID {last_pid} no longer running)', 'process_crash')
                    else:
                        logging.debug(f"Process {last_pid} was manually killed - skipping crash log")

                # Re-read config to get the latest launch_mode state
                # (config may have changed via GUI/Firestore since the main loop started)
                fresh_config = shared_utils.read_config()
                fresh_processes = fresh_config.get('processes', []) if fresh_config else []
                fresh_process = next((p for p in fresh_processes if p.get('id') == process_list_id), None)
                fresh_mode = fresh_process.get('launch_mode', 'always' if fresh_process.get('autolaunch', False) else 'off') if fresh_process else 'off'
                if fresh_mode == 'off' or (fresh_mode == 'scheduled' and not shared_utils.is_within_schedule(fresh_process.get('schedules') if fresh_process else None, self._cached_site_timezone)):
                    logging.debug(f"Skipping relaunch of '{Util.get_process_name(process)}' - launch_mode is '{fresh_mode}' (not active)")
                    # Clear last_started so we don't keep detecting it as crashed
                    if process_list_id in self.last_started:
                        del self.last_started[process_list_id]
                    new_pid = None
                else:
                    # Before launching, check if process is already running
                    # (handles case where previous launch succeeded but PID detection failed)
                    exe_path = process.get('exe_path', '')
                    file_path = process.get('file_path', '')
                    existing_pid = self._find_running_process_by_exe(exe_path, file_path) if exe_path else None
                    if existing_pid:
                        self.last_started[process_list_id] = {
                            'time': datetime.datetime.now(),
                            'pid': existing_pid
                        }
                        shared_utils.update_process_status_in_json(existing_pid, 'RUNNING', self.firebase_client, process_id=process_list_id)
                        logging.info(f"[OK] Adopted already-running '{Util.get_process_name(process)}' (PID {existing_pid})")
                        new_pid = None
                    else:
                        # Launch the process again if it isn't running
                        new_pid = self.handle_process_launch(process)
        
        # Update last started info (for handling process startup timing)
        # Use real time so cooldowns measure from actual launch, not loop-start
        if new_pid:
            self.last_started[process_list_id] = {'time': datetime.datetime.now(), 'pid': new_pid}

    # Clean up stale entries in tracking dictionaries
    def cleanup_stale_tracking_data(self):
        """
        Remove entries from tracking dictionaries for processes that no longer exist in config.
        Prevents memory leaks from accumulation over time.
        """
        try:
            # Get current process IDs from config
            config = shared_utils.read_config()
            if not config:
                return

            current_process_ids = {p.get('id') for p in config.get('processes', []) if p.get('id')}

            # Clean up last_started dictionary
            stale_ids = [pid for pid in self.last_started.keys() if pid not in current_process_ids]
            if stale_ids:
                for pid in stale_ids:
                    del self.last_started[pid]
                logging.info(f"[OK] Cleaned up {len(stale_ids)} stale entries from last_started tracking")

            # Clean up relaunch_attempts dictionary (uses process names, need to map)
            current_process_names = {p.get('name') for p in config.get('processes', []) if p.get('name')}
            stale_names = [name for name in self.relaunch_attempts.keys() if name not in current_process_names]
            if stale_names:
                for name in stale_names:
                    del self.relaunch_attempts[name]
                logging.info(f"[OK] Cleaned up {len(stale_names)} stale entries from relaunch_attempts tracking")

        except Exception as e:
            logging.error(f"Error cleaning up stale tracking data: {e}")

    # Handle config updates from Firebase
    def handle_config_update(self, new_config):
        """
        Handle configuration updates from Firebase.
        Performs intelligent diffing to terminate removed processes and respect autolaunch changes.

        Args:
            new_config: New configuration dict from Firestore
        """
        try:
            logging.info("Applying config update from Firestore")

            # Read old config before overwriting (for diffing)
            old_config = shared_utils.read_config()

            # CRITICAL: Preserve local firebase authentication config
            # The firebase section contains local authentication settings (site_id, OAuth tokens, api_base)
            # and should NEVER be overwritten by Firestore config updates
            if old_config and 'firebase' in old_config:
                new_config['firebase'] = old_config['firebase']
                logging.debug("Preserved local firebase authentication config during Firestore sync")
            else:
                # SAFETY CHECK: If we somehow failed to read the old config or it's missing firebase section,
                # DO NOT proceed with the write - this would wipe out authentication
                if old_config is None:
                    logging.error("CRITICAL: Cannot read old config - aborting Firestore config sync to prevent data loss")
                    return
                else:
                    logging.warning("Old config exists but has no firebase section - proceeding with Firestore sync")

            # Merge launch_mode/schedules: if Firestore processes don't have launch_mode,
            # preserve the local values (GUI may have set them before Firestore caught up)
            merged_launch_mode = False
            if old_config:
                old_processes = {p.get('id'): p for p in old_config.get('processes', []) if p.get('id')}
                for process in new_config.get('processes', []):
                    pid = process.get('id')
                    if pid and pid in old_processes:
                        old_proc = old_processes[pid]
                        if 'launch_mode' not in process and 'launch_mode' in old_proc:
                            process['launch_mode'] = old_proc['launch_mode']
                            merged_launch_mode = True
                        if 'schedules' not in process and 'schedules' in old_proc:
                            process['schedules'] = old_proc['schedules']
                    # Always derive autolaunch from launch_mode for consistency
                    if 'launch_mode' in process:
                        process['autolaunch'] = process['launch_mode'] != 'off'

            # Write the updated config to local config.json
            shared_utils.write_json_to_file(new_config, shared_utils.CONFIG_PATH)

            logging.info("Local config.json updated from Firestore")

            # If we had to merge launch_mode from local, push back to Firestore
            # so the Firestore config document gets launch_mode too (stops the sync cycle)
            if merged_launch_mode and self.firebase_client and self.firebase_client.is_connected():
                try:
                    upload_config = {k: v for k, v in new_config.items() if k != 'firebase'}
                    self.firebase_client.upload_config(upload_config)
                    logging.info("Pushed launch_mode back to Firestore config (one-time sync)")
                except Exception as e:
                    logging.error(f"Failed to push launch_mode to Firestore: {e}")

            # Check for Firebase enable/disable changes (site rejoining detection)
            if old_config:
                old_firebase_config = old_config.get('firebase', {})
                new_firebase_config = new_config.get('firebase', {})

                old_firebase_enabled = old_firebase_config.get('enabled', False)
                new_firebase_enabled = new_firebase_config.get('enabled', False)
                old_site_id = old_firebase_config.get('site_id')
                new_site_id = new_firebase_config.get('site_id')

                # Detect if Firebase was disabled and is now re-enabled, or site_id changed
                if not old_firebase_enabled and new_firebase_enabled:
                    logging.debug("=" * 60)
                    logging.info("Firebase has been RE-ENABLED - reinitializing Firebase client")
                    logging.debug(f"Site ID: {new_site_id}")
                    logging.debug("=" * 60)

                    # Reinitialize Firebase client
                    success = self._initialize_or_restart_firebase_client()
                    if success:
                        logging.info("[OK] Firebase client restarted successfully after being re-enabled")
                    else:
                        logging.error("[ERROR] Failed to restart Firebase client after being re-enabled")

                elif old_firebase_enabled and new_firebase_enabled and old_site_id != new_site_id:
                    logging.debug("=" * 60)
                    logging.info(f"Site ID CHANGED: {old_site_id} -> {new_site_id}")
                    logging.debug("Reinitializing Firebase client for new site")
                    logging.debug("=" * 60)

                    # Reinitialize Firebase client for new site
                    success = self._initialize_or_restart_firebase_client()
                    if success:
                        logging.info("[OK] Firebase client restarted successfully for new site")
                    else:
                        logging.error("[ERROR] Failed to restart Firebase client for new site")

            # Perform config diffing if old config exists
            if old_config:
                old_processes = old_config.get('processes', [])
                new_processes = new_config.get('processes', [])

                # Create lookup maps
                old_process_map = {p.get('id'): p for p in old_processes if p.get('id')}
                new_process_map = {p.get('id'): p for p in new_processes if p.get('id')}

                # Find removed processes
                removed_process_ids = set(old_process_map.keys()) - set(new_process_map.keys())

                # Terminate removed processes
                for removed_id in removed_process_ids:
                    removed_proc = old_process_map[removed_id]
                    logging.info(f"Process removed from config: {removed_proc.get('name')}")

                    # Find and terminate the running process
                    if removed_id in self.last_started:
                        pid_info = self.last_started[removed_id]
                        pid = pid_info.get('pid')

                        if pid and Util.is_pid_running(pid):
                            try:
                                shared_utils.graceful_terminate(pid)
                                # Update status and sync to Firebase immediately
                                shared_utils.update_process_status_in_json(pid, 'STOPPED', self.firebase_client, process_id=removed_id)
                                logging.info(f"[OK] Terminated removed process: {removed_proc.get('name')} (PID {pid})")
                            except Exception as e:
                                logging.error(f"Failed to terminate removed process PID {pid}: {e}")

                        # Clean up tracking
                        del self.last_started[removed_id]

                # Check for launch_mode changes
                for process_id, new_proc in new_process_map.items():
                    if process_id in old_process_map:
                        old_proc = old_process_map[process_id]
                        old_mode = old_proc.get('launch_mode', 'always' if old_proc.get('autolaunch', False) else 'off')
                        new_mode = new_proc.get('launch_mode', 'always' if new_proc.get('autolaunch', False) else 'off')

                        if old_mode != new_mode:
                            logging.info(f"Launch mode changed for {new_proc.get('name')}: {old_mode} -> {new_mode}")

                        if new_mode == 'off' and old_mode != 'off':
                            # Mode set to off - stop monitoring but keep process running
                            logging.info(f"Launch mode set to off for {new_proc.get('name')} - stopping monitoring (process stays running)")
                            self.manual_overrides.pop(process_id, None)
                        elif new_mode in ('always', 'scheduled') and old_mode == 'off':
                            # Mode enabled - clear any cooldown, launch immediately if appropriate
                            should_launch = new_mode == 'always' or shared_utils.is_within_schedule(new_proc.get('schedules'), self._cached_site_timezone)
                            if should_launch:
                                logging.info(f"Launch mode set to {new_mode} for {new_proc.get('name')} - launching now")
                                self.last_started.pop(new_proc.get('id'), None)
                                try:
                                    self.handle_process(new_proc)
                                except Exception as e:
                                    logging.error(f"Failed to immediately launch {new_proc.get('name')}: {e}")
                            else:
                                logging.info(f"Launch mode set to {new_mode} for {new_proc.get('name')} - outside schedule, will launch when window opens")

                # Log summary
                logging.info(f"Config update complete - Processes: {len(old_processes)} -> {len(new_processes)}, Removed: {len(removed_process_ids)}")


            # Upload metrics immediately so web dashboard sees config changes quickly
            # This is different from GUI-initiated changes (which already upload immediately)
            if self.firebase_client and self.firebase_client.is_connected():
                try:
                    metrics = shared_utils.get_system_metrics()
                    self.firebase_client._upload_metrics(metrics)
                    logging.info("Config change synced to Firestore immediately (for web dashboard responsiveness)")
                except Exception as e:
                    logging.error(f"Failed to immediately sync config change: {e}")
                    logging.info("Config will sync on next metrics interval")

        except Exception as e:
            logging.error(f"Error handling config update: {e}")

    # Handle commands from Firebase
    # Command rate limiting: tracks last execution time per command type
    _command_rate_limits = {}
    # Minimum seconds between commands of the same type
    COMMAND_RATE_LIMIT_SECONDS = 5

    def handle_firebase_command(self, cmd_id, cmd_data):
        """
        Handle commands received from Firebase web portal.

        Args:
            cmd_id: Command ID
            cmd_data: Command data dict with 'type' and parameters

        Returns:
            Result message string
        """
        try:
            cmd_type = cmd_data.get('type')
            logging.info(f"Received Firebase command: {cmd_type} (ID: {cmd_id})")

            # Rate limit: prevent rapid-fire commands of the same type
            now = time.time()
            last_time = self._command_rate_limits.get(cmd_type, 0)
            if now - last_time < self.COMMAND_RATE_LIMIT_SECONDS:
                logging.warning(f"Command rate-limited: {cmd_type} (last executed {now - last_time:.1f}s ago)")
                return f"Rate limited: {cmd_type} executed too recently, try again in a few seconds"
            self._command_rate_limits[cmd_type] = now

            if cmd_type == 'restart_process':
                # Restart a specific process by name
                process_name = cmd_data.get('process_name')
                processes = shared_utils.read_config(['processes'])
                for process in processes:
                    if process.get('name') == process_name:
                        process_list_id = process['id']
                        # Track manual override for scheduled processes started outside window
                        mode = process.get('launch_mode', 'always' if process.get('autolaunch', False) else 'off')
                        if mode == 'scheduled' and not shared_utils.is_within_schedule(process.get('schedules'), self._cached_site_timezone):
                            self.manual_overrides[process_list_id] = True
                            logging.info(f"Manual override set for '{process_name}' (started outside schedule window)")
                        last_info = self.last_started.get(process_list_id, {})
                        last_pid = last_info.get('pid')
                        if last_pid and Util.is_pid_running(last_pid):
                            new_pid = self.kill_and_relaunch_process(last_pid, process)
                            # Log command execution
                            if self.firebase_client and self.firebase_client.is_connected():
                                self.firebase_client.log_event(
                                    action='command_executed',
                                    level='info',
                                    process_name=process_name,
                                    details=f'Restart process command - Old PID: {last_pid}, New PID: {new_pid}'
                                )
                            return f"Process {process_name} restarted with new PID {new_pid}"
                        else:
                            new_pid = self.handle_process_launch(process)
                            # Log command execution
                            if self.firebase_client and self.firebase_client.is_connected():
                                self.firebase_client.log_event(
                                    action='command_executed',
                                    level='info',
                                    process_name=process_name,
                                    details=f'Start process command - PID: {new_pid}'
                                )
                            return f"Process {process_name} started with PID {new_pid}"
                return f"Process {process_name} not found in configuration"

            elif cmd_type == 'kill_process':
                # Kill a specific process by name
                process_name = cmd_data.get('process_name')
                processes = shared_utils.read_config(['processes'])
                for process in processes:
                    if process.get('name') == process_name:
                        process_list_id = process['id']
                        last_info = self.last_started.get(process_list_id, {})
                        last_pid = last_info.get('pid')
                        if last_pid and Util.is_pid_running(last_pid):
                            shared_utils.graceful_terminate(last_pid)
                            # Update status and sync to Firebase immediately
                            shared_utils.update_process_status_in_json(last_pid, 'STOPPED', self.firebase_client, process_id=process_list_id)
                            # Log process kill event (manual kill from dashboard)
                            if self.firebase_client and self.firebase_client.is_connected():
                                self.firebase_client.log_event(
                                    action='process_killed',
                                    level='warning',
                                    process_name=process_name,
                                    details=f'Manual kill via dashboard - PID: {last_pid}'
                                )
                            return f"Process {process_name} (PID {last_pid}) terminated"
                        else:
                            return f"Process {process_name} is not running"
                return f"Process {process_name} not found in configuration"

            elif cmd_type in ('toggle_autolaunch', 'set_launch_mode'):
                # Set launch mode for a specific process (also handles legacy toggle_autolaunch)
                process_name = cmd_data.get('process_name')
                config = shared_utils.read_config()
                processes = config.get('processes', [])
                for process in processes:
                    if process.get('name') == process_name:
                        if cmd_type == 'set_launch_mode':
                            new_mode = cmd_data.get('mode', 'off')
                            new_schedules = cmd_data.get('schedules', None)
                            process['launch_mode'] = new_mode
                            if new_schedules is not None:
                                process['schedules'] = new_schedules
                        else:
                            # Legacy toggle_autolaunch support
                            new_autolaunch_value = cmd_data.get('autolaunch', False)
                            process['launch_mode'] = 'always' if new_autolaunch_value else 'off'
                        # Always derive autolaunch for backward compat
                        process['autolaunch'] = process.get('launch_mode', 'off') != 'off'
                        shared_utils.save_config(config)
                        logging.info(f"Launch mode for {process_name} set to {process['launch_mode']}")
                        return f"Launch mode for {process_name} set to {process['launch_mode']}"
                return f"Process {process_name} not found in configuration"

            elif cmd_type == 'update_config':
                # Update configuration from Firebase
                new_config = cmd_data.get('config')
                if new_config:
                    # CRITICAL: Preserve local firebase authentication config
                    # The firebase section should never come from remote commands
                    old_config = shared_utils.read_config()
                    if old_config and 'firebase' in old_config:
                        new_config['firebase'] = old_config['firebase']
                        logging.debug("Preserved firebase section during update_config command")

                    shared_utils.write_json_to_file(new_config, shared_utils.CONFIG_PATH)
                    logging.info("Configuration updated from Firebase command")
                    return "Configuration updated successfully"
                else:
                    return "No configuration data provided"

            elif cmd_type == 'install_software':
                # Install software from a URL with silent flags
                installer_url = cmd_data.get('installer_url')
                installer_name = cmd_data.get('installer_name', 'installer.exe')
                silent_flags = cmd_data.get('silent_flags', '')
                verify_path = cmd_data.get('verify_path')  # Optional verification path
                timeout_seconds = cmd_data.get('timeout_seconds', 2400)  # Default: 40 minutes
                expected_sha256 = cmd_data.get('sha256_checksum')  # Optional but recommended
                deployment_id = cmd_data.get('deployment_id')  # For tracking deployment progress

                if not installer_url:
                    return "Error: No installer URL provided"

                logging.info(f"Starting software installation: {installer_name}")
                logging.debug(f"URL: {installer_url}")
                logging.debug(f"Flags: {silent_flags}")
                logging.debug(f"Timeout: {timeout_seconds} seconds")
                if expected_sha256:
                    logging.debug(f"Checksum verification enabled: {expected_sha256[:16]}...")

                # Get temporary path for installer
                temp_installer_path = installer_utils.get_temp_installer_path(installer_name)

                try:
                    # Update status: downloading
                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'downloading', deployment_id)

                    # Download the installer
                    logging.debug(f"Downloading installer to: {temp_installer_path}")
                    download_success, actual_installer_path = installer_utils.download_file(installer_url, temp_installer_path)

                    if not download_success:
                        return f"Error: Failed to download installer from {installer_url}"

                    # Use the actual path where the file was saved (may differ if file was in use)
                    temp_installer_path = actual_installer_path

                    # Verify checksum if provided (SECURITY: recommended for remote installations)
                    if expected_sha256:
                        logging.info("Verifying installer checksum...")
                        checksum_valid = installer_utils.verify_checksum(temp_installer_path, expected_sha256)
                        if not checksum_valid:
                            installer_utils.cleanup_installer(temp_installer_path, force=True)
                            return f"Error: Checksum verification failed for {installer_name}. Installation aborted for security."
                        logging.info("[OK] Checksum verification passed")
                    else:
                        logging.warning("[WARNING] No checksum provided - skipping verification (security risk)")

                    # Update status: installing
                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'installing', deployment_id)

                    # Execute installer and wait for completion
                    logging.info("Executing installer with silent flags")
                    success, exit_code, error_msg = installer_utils.execute_installer(
                        temp_installer_path,
                        silent_flags,
                        installer_name,
                        self.active_installations,
                        timeout_seconds
                    )

                    if not success:
                        return f"Error: Installation failed with exit code {exit_code}. {error_msg}"

                    # Optional: Verify installation
                    if verify_path:
                        if installer_utils.verify_installation(verify_path):
                            result_msg = f"Installation completed successfully. Verified at {verify_path}"
                        else:
                            result_msg = f"Installation completed (exit code 0) but verification failed - {verify_path} not found"
                    else:
                        result_msg = f"Installation completed successfully (exit code {exit_code})"

                    logging.info(result_msg)

                    # Trigger immediate software inventory sync after installation completes
                    try:
                        if self.firebase_client and self.firebase_client.is_connected():
                            logging.info("Triggering software inventory sync after installation")
                            self.firebase_client.sync_software_inventory()
                    except Exception as sync_error:
                        logging.warning(f"Failed to sync software inventory after installation: {sync_error}")

                    return result_msg

                finally:
                    # Always cleanup the temporary installer file
                    try:
                        installer_utils.cleanup_installer(temp_installer_path, force=True)
                    except Exception as cleanup_error:
                        logging.warning(f"Error in cleanup finally block: {cleanup_error}")

            elif cmd_type == 'update_owlette':
                # Self-update command: Downloads and installs new Owlette version
                # Uses installer_utils for robust download (retries + backoff) and checksum verification
                # Launches via Task Scheduler so installer survives service stop
                # Recovery watchdog task ensures service comes back after update
                installer_url = cmd_data.get('installer_url')
                deployment_id = cmd_data.get('deployment_id')
                expected_sha256 = cmd_data.get('checksum_sha256')

                # Resolve target version: from command data, URL filename, or 'unknown'
                target_version = cmd_data.get('target_version')
                if not target_version:
                    import re
                    version_match = re.search(r'v(\d+\.\d+\.\d+)', installer_url or '')
                    target_version = version_match.group(1) if version_match else 'unknown'

                if not installer_url:
                    return "Error: No installer URL provided for update"

                # ANTI-FRAGILE: Require checksum for self-updates (supply chain protection)
                if not expected_sha256:
                    return "Error: No checksum provided for self-update - refusing to install unverified binary"

                # ANTI-FRAGILE: Idempotency guard - prevent concurrent update execution
                import json
                update_marker_path = os.path.join(os.environ.get('ProgramData', 'C:\\ProgramData'), 'Owlette', 'logs', 'update_in_progress.json')
                if os.path.exists(update_marker_path):
                    try:
                        with open(update_marker_path, 'r') as f:
                            existing_marker = json.load(f)
                        started_at = existing_marker.get('started_at', '')
                        # Parse the timestamp and check if update is still recent (< 10 minutes)
                        from datetime import datetime
                        marker_time = datetime.strptime(started_at, '%Y-%m-%d %H:%M:%S')
                        age_minutes = (datetime.now() - marker_time).total_seconds() / 60
                        if age_minutes < 10:
                            logging.warning(f"Update already in progress (started {age_minutes:.1f}m ago) - rejecting duplicate command")
                            return f"Update already in progress (started {age_minutes:.1f}m ago)"
                        else:
                            logging.warning(f"Stale update marker found ({age_minutes:.1f}m old) - proceeding with new update")
                    except Exception as marker_err:
                        logging.warning(f"Could not read existing update marker, proceeding: {marker_err}")

                logging.debug("="*60)
                logging.info("OWLETTE SELF-UPDATE INITIATED")
                logging.debug("="*60)
                logging.debug(f"Installer URL: {installer_url}")
                logging.debug(f"Target version: {target_version}")
                logging.debug(f"Checksum: {expected_sha256[:16]}...")
                logging.debug("Inno Setup will handle service stop/restart automatically")

                try:
                    # ANTI-FRAGILE: Check disk space before downloading
                    # Installer is ~100MB, extraction needs ~200MB more, plus old install still present
                    import shutil
                    install_drive = os.path.splitdrive(os.environ.get('ProgramData', 'C:\\ProgramData'))[0] or 'C:'
                    disk_usage = shutil.disk_usage(install_drive + '\\')
                    free_mb = disk_usage.free / (1024 * 1024)
                    logging.debug(f"Disk space on {install_drive}: {free_mb:.0f} MB free")
                    if free_mb < 500:
                        raise Exception(f"Insufficient disk space: {free_mb:.0f} MB free, need at least 500 MB for safe update")

                    # Update status: downloading
                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'downloading', deployment_id)

                    # Download installer to our own temp directory (not WINDOWS\TEMP)
                    # Some security software blocks execution from system temp directories
                    owlette_tmp_dir = os.path.join(os.environ.get('ProgramData', 'C:\\ProgramData'), 'Owlette', 'tmp')
                    os.makedirs(owlette_tmp_dir, exist_ok=True)
                    temp_installer_path = os.path.join(owlette_tmp_dir, 'Owlette-Update.exe')

                    # Use installer_utils for robust download with retries and progress
                    logging.info("Downloading installer (3 retries with exponential backoff)...")
                    download_success, actual_path = installer_utils.download_file(
                        installer_url,
                        temp_installer_path,
                        progress_callback=None,  # Progress already tracked via Firestore status
                        max_retries=3,
                        connect_timeout=30,
                        read_timeout=600
                    )

                    if not download_success:
                        raise Exception(f"Failed to download installer after 3 retries from {installer_url}")

                    temp_installer_path = actual_path
                    logging.debug(f"Installer downloaded to: {temp_installer_path}")

                    # Sanity check - Inno Setup installer should be at least 1MB
                    file_size = os.path.getsize(temp_installer_path)
                    logging.debug(f"Installer file size: {file_size:,} bytes")
                    if file_size < 1_000_000:
                        raise Exception(f"Downloaded file too small ({file_size} bytes) - likely not a valid installer")

                    # Verify it's a valid PE executable (check MZ header)
                    with open(temp_installer_path, 'rb') as f:
                        header = f.read(2)
                        if header != b'MZ':
                            raise Exception("Downloaded file is not a valid Windows executable")

                    # SHA256 checksum verification (MANDATORY for self-updates)
                    logging.info("Verifying installer checksum...")
                    if not installer_utils.verify_checksum(temp_installer_path, expected_sha256):
                        installer_utils.cleanup_installer(temp_installer_path, force=True)
                        raise Exception("Checksum verification FAILED - installer may be corrupted or tampered. Update aborted.")
                    logging.info("[OK] Checksum verification passed")

                    logging.info("Installer verified successfully")

                    # Create update marker file (persists across service restart)
                    # Used by _check_update_status() after service restarts to report success/failure
                    update_marker = {
                        'started_at': time.strftime('%Y-%m-%d %H:%M:%S'),
                        'old_version': shared_utils.APP_VERSION,
                        'target_version': target_version,
                        'installer_url': installer_url,
                        'installer_path': temp_installer_path,
                        'command_id': cmd_id,
                        'deployment_id': deployment_id
                    }
                    with open(update_marker_path, 'w') as f:
                        json.dump(update_marker, f, indent=2)
                    logging.debug(f"Update marker created: {update_marker_path}")

                    # Update status: installing
                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'installing', deployment_id)

                    # Launch installer via Windows Task Scheduler (survives service stop)
                    # This ensures installer keeps running even when Inno Setup kills the service
                    log_path = os.path.join(os.environ.get('ProgramData', 'C:\\ProgramData'), 'Owlette', 'logs', 'installer_update.log')
                    silent_flags = f'/VERYSILENT /NORESTART /SUPPRESSMSGBOXES /ALLUSERS /LOG="{log_path}"'
                    task_name = f"OwletteUpdate_{int(time.time())}"

                    logging.debug(f"Creating scheduled task: {task_name}")
                    logging.debug(f"Installer flags: {silent_flags}")
                    logging.debug(f"Installer log will be written to: {log_path}")

                    # Create one-time task that runs immediately as SYSTEM
                    schtasks_cmd = [
                        'schtasks',
                        '/Create',
                        '/TN', task_name,
                        '/TR', f'"{temp_installer_path}" {silent_flags}',
                        '/SC', 'ONCE',
                        '/ST', '00:00',
                        '/RU', 'SYSTEM',
                        '/RL', 'HIGHEST',
                        '/F'
                    ]

                    result = subprocess.run(
                        schtasks_cmd,
                        capture_output=True,
                        text=True,
                        timeout=10
                    )

                    if result.returncode != 0:
                        raise Exception(f"Failed to create scheduled task: {result.stderr}")

                    logging.debug(f"Scheduled task created: {task_name}")

                    # Run the task immediately
                    run_result = subprocess.run(
                        ['schtasks', '/Run', '/TN', task_name],
                        capture_output=True,
                        text=True,
                        timeout=10
                    )

                    if run_result.returncode != 0:
                        logging.warning(f"Task run command returned: {run_result.stderr}")
                    else:
                        logging.info("Installer task started successfully")

                    # ANTI-FRAGILE: Recovery watchdog - if service doesn't come back after update,
                    # attempt to restart it. Uses powershell Start-Sleep for clean non-interactive delay.
                    # Sequence: wait 5min → check if service running → if not, try net start
                    recovery_task_name = f"OwletteRecovery_{int(time.time())}"
                    recovery_cmd = (
                        f'powershell -NoProfile -Command "Start-Sleep 300" && '
                        f'sc query OwletteService | findstr "RUNNING" > nul || '
                        f'(net start OwletteService & '
                        f'schtasks /Delete /TN "{recovery_task_name}" /F)'
                    )
                    try:
                        subprocess.run(
                            ['schtasks', '/Create',
                             '/TN', recovery_task_name,
                             '/TR', f'cmd /c {recovery_cmd}',
                             '/SC', 'ONCE', '/ST', '00:00',
                             '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F'],
                            capture_output=True, text=True, timeout=10
                        )
                        subprocess.run(
                            ['schtasks', '/Run', '/TN', recovery_task_name],
                            capture_output=True, text=True, timeout=10
                        )
                        logging.info(f"Recovery watchdog scheduled: {recovery_task_name} (will check service in ~5 min)")
                    except Exception as recovery_err:
                        logging.warning(f"Failed to create recovery watchdog (non-fatal): {recovery_err}")

                    # Clean up the installer scheduled task after 5 minutes
                    subprocess.Popen(
                        ['cmd', '/c',
                         f'powershell -NoProfile -Command "Start-Sleep 300" && '
                         f'schtasks /Delete /TN "{task_name}" /F && '
                         f'schtasks /Delete /TN "{recovery_task_name}" /F'],
                        shell=False,
                        creationflags=0x00000008,  # DETACHED_PROCESS
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL
                    )

                    logging.debug("Installer will handle service restart automatically")
                    logging.debug("Recovery watchdog will attempt restart if service doesn't come back")
                    logging.debug("="*60)

                    return "Self-update initiated via Task Scheduler"

                except Exception as e:
                    error_msg = f"Error initiating update: {str(e)}"
                    logging.error(error_msg)
                    logging.exception("Update initiation failed")
                    # Clean up marker on failure so we don't block future updates
                    try:
                        if os.path.exists(update_marker_path):
                            os.remove(update_marker_path)
                    except:
                        pass
                    return error_msg

            elif cmd_type == 'cancel_installation':
                # Cancel an active installation
                installer_name = cmd_data.get('installer_name')

                if not installer_name:
                    return "Error: No installer name provided for cancellation"

                logging.info(f"Cancellation requested for: {installer_name}")

                # Attempt to cancel the installation
                success, message = installer_utils.cancel_installation(
                    installer_name,
                    self.active_installations
                )

                if success:
                    logging.info(f"Installation cancelled: {installer_name}")
                    return f"Installation cancelled: {installer_name}"
                else:
                    logging.warning(f"Cancellation failed: {message}")
                    return f"Cancellation failed: {message}"

            elif cmd_type == 'uninstall_software':
                # Uninstall software using registry-detected uninstall command
                software_name = cmd_data.get('software_name')
                uninstall_command = cmd_data.get('uninstall_command')
                silent_flags = cmd_data.get('silent_flags', '')
                installer_type = cmd_data.get('installer_type', 'custom')
                verify_paths = cmd_data.get('verify_paths', [])  # Paths to verify removal
                timeout_seconds = cmd_data.get('timeout_seconds', 1200)  # Default: 20 minutes
                deployment_id = cmd_data.get('deployment_id')  # For tracking deployment progress

                if not software_name or not uninstall_command:
                    return "Error: Software name and uninstall command required"

                logging.info(f"Starting software uninstallation: {software_name}")
                logging.debug(f"Uninstall command: {uninstall_command}")
                logging.debug(f"Installer type: {installer_type}")
                logging.debug(f"Timeout: {timeout_seconds} seconds")

                # Build complete silent uninstall command
                if not silent_flags:
                    # Auto-detect silent flags if not provided
                    silent_flags = registry_utils.get_silent_uninstall_flags(installer_type)
                    logging.debug(f"Auto-detected silent flags: {silent_flags}")

                complete_command_str = registry_utils.build_silent_uninstall_command(
                    uninstall_command,
                    installer_type
                ) if not silent_flags else f"{uninstall_command} {silent_flags}"

                logging.debug(f"Complete uninstall command: {complete_command_str}")

                # Parse command string into list to avoid shell injection.
                # Use posix=True so shlex strips surrounding quotes from paths
                # like '"C:\Program Files\App\Uninstall.exe"' — without this,
                # subprocess.Popen fails with Access Denied on quoted paths.
                try:
                    complete_command = shlex.split(complete_command_str, posix=True)
                except ValueError as e:
                    return f"Error: Invalid uninstall command format: {e}"

                try:
                    # Update status: uninstalling
                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'uninstalling', deployment_id)

                    # Execute the uninstaller (track for cancellation)
                    logging.info("Executing uninstaller with silent flags")

                    # Use installer_utils.execute_installer since it handles process tracking
                    # For uninstall, we don't have a file path, so we'll use subprocess directly
                    # (subprocess is imported at module level)

                    # Track process name for cancellation
                    uninstall_process_name = f"uninstall_{software_name.replace(' ', '_')}"

                    process = subprocess.Popen(
                        complete_command,
                        shell=False,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True
                    )

                    # Track process for potential cancellation
                    self.active_installations[uninstall_process_name] = process
                    logging.debug(f"Tracking uninstall process: {uninstall_process_name} (PID: {process.pid})")

                    # Wait for uninstallation to complete
                    try:
                        stdout, stderr = process.communicate(timeout=timeout_seconds)
                        exit_code = process.returncode
                    except subprocess.TimeoutExpired:
                        process.kill()
                        if uninstall_process_name in self.active_installations:
                            del self.active_installations[uninstall_process_name]
                        return f"Error: Uninstallation timeout (exceeded {timeout_seconds} seconds)"

                    # Remove from active processes once complete
                    if uninstall_process_name in self.active_installations:
                        del self.active_installations[uninstall_process_name]

                    logging.info(f"Uninstaller exit code: {exit_code}")

                    # Check if uninstallation was successful
                    # Note: Some uninstallers return non-zero even on success
                    if exit_code not in [0, 3010]:  # 0 = success, 3010 = success but reboot required
                        logging.warning(f"Uninstaller returned exit code {exit_code}")
                        if stderr:
                            logging.error(f"Uninstaller stderr: {stderr}")

                    # Verify uninstallation
                    verification_results = []
                    if verify_paths:
                        for verify_path in verify_paths:
                            if verify_path:
                                # Check if path still exists (should NOT exist after uninstall)
                                path_exists = os.path.exists(verify_path)
                                verification_results.append({
                                    'path': verify_path,
                                    'removed': not path_exists
                                })
                                if path_exists:
                                    logging.warning(f"Verification: Path still exists after uninstall: {verify_path}")
                                else:
                                    logging.info(f"Verification: Path successfully removed: {verify_path}")

                    # Check if software still appears in registry
                    registry_check = registry_utils.search_software_by_name(software_name)
                    still_in_registry = len(registry_check) > 0

                    if still_in_registry:
                        logging.warning(f"Software still appears in registry after uninstall: {software_name}")
                        result_msg = f"Uninstall completed with exit code {exit_code}, but software still appears in registry (may require reboot)"
                    elif any(not vr['removed'] for vr in verification_results):
                        result_msg = f"Uninstall completed with exit code {exit_code}, but some files remain (may require reboot)"
                    else:
                        result_msg = f"Uninstall completed successfully (exit code {exit_code})"

                    logging.info(result_msg)

                    # Trigger immediate software inventory sync after uninstall completes
                    try:
                        if self.firebase_client and self.firebase_client.is_connected():
                            logging.info("Triggering software inventory sync after uninstall")
                            self.firebase_client.sync_software_inventory()
                    except Exception as sync_error:
                        logging.warning(f"Failed to sync software inventory after uninstall: {sync_error}")
                        # Don't fail the uninstall if sync fails

                    return result_msg

                except Exception as e:
                    error_msg = f"Unexpected error during uninstallation: {e}"
                    logging.error(error_msg)
                    logging.exception("Uninstall error details:")
                    return f"Error: {error_msg}"

            elif cmd_type == 'cancel_uninstall':
                # Cancel an active uninstallation
                software_name = cmd_data.get('software_name')

                if not software_name:
                    return "Error: No software name provided for cancellation"

                # Build process tracking name
                uninstall_process_name = f"uninstall_{software_name.replace(' ', '_')}"
                logging.info(f"Cancellation requested for: {uninstall_process_name}")

                # Attempt to cancel the uninstallation
                success, message = installer_utils.cancel_installation(
                    uninstall_process_name,
                    self.active_installations
                )

                if success:
                    logging.info(f"Uninstallation cancelled: {software_name}")
                    return f"Uninstallation cancelled: {software_name}"
                else:
                    logging.warning(f"Cancellation failed: {message}")
                    return f"Cancellation failed: {message}"

            elif cmd_type == 'refresh_software_inventory':
                # Force immediate refresh of software inventory
                logging.info("Refreshing software inventory on demand")
                try:
                    if self.firebase_client and self.firebase_client.is_connected():
                        self.firebase_client._sync_software_inventory(force=True)
                        return "Software inventory refreshed successfully"
                    else:
                        return "Error: Not connected to Firebase"
                except Exception as e:
                    error_msg = f"Failed to refresh software inventory: {str(e)}"
                    logging.error(error_msg)
                    return error_msg

            elif cmd_type == 'distribute_project':
                # Distribute project files (ZIP) with extraction
                project_url = cmd_data.get('project_url')
                project_name = cmd_data.get('project_name', 'project.zip')
                extract_path = cmd_data.get('extract_path')  # Optional custom path
                verify_files = cmd_data.get('verify_files', [])  # List of files to verify
                distribution_id = cmd_data.get('distribution_id')  # For tracking distribution progress

                if not project_url:
                    return "Error: No project URL provided"

                logging.info(f"Starting project distribution: {project_name}")
                logging.debug(f"URL: {project_url}")
                logging.debug(f"Extract path: {extract_path or 'default'}")

                # Determine extraction path
                if not extract_path:
                    extract_path = project_utils.get_default_project_directory()
                    logging.debug(f"Using default extraction path: {extract_path}")

                # Get temporary path for project ZIP
                temp_project_path = project_utils.get_temp_project_path(project_name)

                try:
                    # Update status: downloading
                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'downloading', distribution_id)

                    # Download the project ZIP
                    logging.debug(f"Downloading project to: {temp_project_path}")
                    download_success, result = project_utils.download_project(
                        project_url,
                        project_name,
                        lambda progress: self.firebase_client.update_command_progress(
                            cmd_id, 'downloading', distribution_id, progress
                        ) if self.firebase_client else None
                    )

                    if not download_success:
                        return f"Error: {result}"

                    # Update status: extracting
                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'extracting', distribution_id)

                    # Extract the ZIP file
                    logging.info(f"Extracting project to: {extract_path}")
                    extract_success, error_msg = project_utils.extract_zip(
                        result,  # result contains the downloaded file path
                        extract_path,
                        lambda progress: self.firebase_client.update_command_progress(
                            cmd_id, 'extracting', distribution_id, progress
                        ) if self.firebase_client else None
                    )

                    if not extract_success:
                        return f"Error: Extraction failed - {error_msg}"

                    # Optional: Verify project files
                    result_msg = f"Project extracted successfully to {extract_path}"
                    if verify_files:
                        all_found, missing_files = project_utils.verify_project_files(extract_path, verify_files)
                        if all_found:
                            result_msg += f". Verified {len(verify_files)} file(s)"
                        else:
                            result_msg += f". Warning: {len(missing_files)} file(s) missing: {', '.join(missing_files)}"

                    logging.info(result_msg)
                    return result_msg

                finally:
                    # Always cleanup the temporary project ZIP
                    project_utils.cleanup_project_zip(temp_project_path)

            elif cmd_type == 'cancel_distribution':
                # Cancel an active project distribution
                project_name = cmd_data.get('project_name')

                if not project_name:
                    return "Error: No project name provided for cancellation"

                logging.info(f"Cancellation requested for project: {project_name}")

                # Note: We don't have a simple way to cancel downloads like we do for installers
                # since download_file is synchronous. For now, just cleanup the temp file.
                project_path = project_utils.get_temp_project_path(project_name)
                project_utils.cleanup_project_zip(project_path)

                return f"Distribution cancelled: {project_name} (cleaned up temporary files)"

            elif cmd_type == 'mcp_tool_call':
                # MCP tool call from chat interface
                tool_name = cmd_data.get('tool_name')
                tool_params = cmd_data.get('tool_params', {})

                if not tool_name:
                    return "Error: No tool_name provided for mcp_tool_call"

                logging.info(f"Executing MCP tool: {tool_name} with params: {list(tool_params.keys())}")

                # Tools that need user-session execution (desktop access)
                import json as _json
                user_session_result = self._try_user_session_tool(tool_name, tool_params)
                if user_session_result is not None:
                    return _json.dumps(user_session_result)

                import mcp_tools
                config = shared_utils.read_config()
                result = mcp_tools.execute_tool(tool_name, tool_params, config)

                # MCP tool results are dicts — serialize to JSON string for Firestore
                return _json.dumps(result)

            elif cmd_type == 'capture_screenshot':
                return self._handle_capture_screenshot(cmd_data)

            elif cmd_type == 'reboot_machine':
                return self._handle_reboot_machine(cmd_data)

            elif cmd_type == 'shutdown_machine':
                return self._handle_shutdown_machine(cmd_data)

            elif cmd_type == 'cancel_reboot':
                return self._handle_cancel_reboot(cmd_data)

            elif cmd_type == 'dismiss_reboot_pending':
                return self._handle_dismiss_reboot_pending(cmd_data)

            elif cmd_type == 'provision_cortex_key':
                return self._handle_provision_cortex_key(cmd_data)

            else:
                logging.warning(f"Unknown command type: {cmd_type}")
                return f"Unknown command type: {cmd_type}"

        except Exception as e:
            error_msg = f"Error executing command {cmd_type}: {e}"
            logging.error(error_msg)
            return error_msg

    def _handle_reboot_machine(self, command_data):
        """Handle remote reboot command."""
        try:
            self.firebase_client.log_event(
                action='command_executed',
                level='warning',
                details='Remote reboot initiated from dashboard'
            )

            # Set rebooting flag so dashboard shows "Rebooting..."
            self.firebase_client.set_machine_flag('rebooting', True)

            # Schedule reboot with 30-second delay (gives agent time to complete Firestore writes)
            import subprocess
            subprocess.run(
                ['shutdown', '/r', '/t', '30', '/c', 'Owlette remote reboot requested'],
                check=True
            )

            return "Reboot scheduled in 30 seconds"
        except Exception as e:
            return f"Reboot failed: {str(e)}"

    def _handle_shutdown_machine(self, command_data):
        """Handle remote shutdown command."""
        try:
            self.firebase_client.log_event(
                action='command_executed',
                level='warning',
                details='Remote shutdown initiated from dashboard'
            )

            self.firebase_client.set_machine_flag('shuttingDown', True)

            import subprocess
            subprocess.run(
                ['shutdown', '/s', '/t', '30', '/c', 'Owlette remote shutdown requested'],
                check=True
            )

            return "Shutdown scheduled in 30 seconds"
        except Exception as e:
            return f"Shutdown failed: {str(e)}"

    def _handle_cancel_reboot(self, command_data):
        """Cancel a pending reboot/shutdown."""
        try:
            import subprocess
            subprocess.run(['shutdown', '/a'], check=True)

            self.firebase_client.set_machine_flag('rebooting', False)
            self.firebase_client.set_machine_flag('shuttingDown', False)
            self.firebase_client.log_event(
                action='command_executed',
                level='info',
                details='Pending reboot/shutdown cancelled from dashboard'
            )

            return "Reboot/shutdown cancelled"
        except subprocess.CalledProcessError:
            return "No pending reboot to cancel"

    def _handle_dismiss_reboot_pending(self, command_data):
        """Dismiss a reboot pending prompt and reset relaunch counters."""
        try:
            process_name = command_data.get('process_name')

            # Clear the reboot pending flag
            self.firebase_client.clear_reboot_pending()

            # Reset relaunch counter for the affected process so it gets fresh attempts
            if process_name and process_name in self.relaunch_attempts:
                del self.relaunch_attempts[process_name]
                logging.info(f"Reset relaunch counter for {process_name}")

            # Kill the local restart prompt if it's still running
            if shared_utils.is_script_running('prompt_restart.py'):
                try:
                    import subprocess
                    subprocess.run(
                        ['taskkill', '/F', '/IM', 'pythonw.exe', '/FI', 'WINDOWTITLE eq *restart*'],
                        capture_output=True
                    )
                except Exception:
                    pass

            self.firebase_client.log_event(
                action='command_executed',
                level='info',
                process_name=process_name,
                details='Reboot dismissed by admin from dashboard'
            )

            return f"Reboot pending dismissed, relaunch counters reset for {process_name}"
        except Exception as e:
            return f"Failed to dismiss reboot pending: {str(e)}"

    def _handle_provision_cortex_key(self, command_data):
        """Encrypt and store the Cortex LLM API key in config.json."""
        try:
            api_key = command_data.get('api_key', '')
            provider = command_data.get('provider', 'anthropic')

            if not api_key:
                return "Error: No API key provided"

            # Encrypt with the same machine-specific Fernet key used by SecureStorage
            from secure_storage import get_storage
            storage = get_storage()
            encrypted = storage._fernet.encrypt(api_key.encode('utf-8')).decode('utf-8')

            # Store in config
            config = shared_utils.read_config()
            if 'cortex' not in config:
                config['cortex'] = {}
            config['cortex']['apiKeyEncrypted'] = encrypted
            config['cortex']['provider'] = provider
            config['cortex']['enabled'] = True
            shared_utils.write_config(config)

            logging.info(f"Cortex API key provisioned (provider={provider})")
            return "Cortex API key provisioned successfully"
        except Exception as e:
            logging.error(f"Failed to provision Cortex key: {e}")
            return f"Error: {str(e)}"

    def _try_user_session_tool(self, tool_name, tool_params):
        """Handle MCP tools that require user-session execution.

        Returns:
            dict result if handled, None if the tool should fall through
            to the standard mcp_tools.execute_tool() path.
        """
        if tool_name == 'run_command' and tool_params.get('user_session'):
            command = tool_params.get('command', '').strip()
            if not command:
                return {'error': 'command parameter is required'}
            result = self.execute_in_user_session('cmd', command, timeout=25)
            return {
                'command': command,
                'exit_code': result.get('exitCode', -1),
                'stdout': result.get('stdout', ''),
                'stderr': result.get('stderr', ''),
                'user_session': True,
                'error': result.get('error'),
            }

        if tool_name == 'run_powershell' and tool_params.get('user_session'):
            script = tool_params.get('script', '').strip()
            if not script:
                return {'error': 'script parameter is required'}
            result = self.execute_in_user_session('powershell', script, timeout=25)
            return {
                'script': script,
                'exit_code': result.get('exitCode', -1),
                'stdout': result.get('stdout', ''),
                'stderr': result.get('stderr', ''),
                'user_session': True,
                'error': result.get('error'),
            }

        if tool_name == 'run_python':
            code = tool_params.get('code', '').strip()
            if not code:
                return {'error': 'code parameter is required'}
            result = self.execute_in_user_session('python', code, timeout=25)
            return {
                'exit_code': result.get('exitCode', -1),
                'stdout': result.get('stdout', ''),
                'stderr': result.get('stderr', ''),
                'files': result.get('files', []),
                'duration_ms': result.get('durationMs', 0),
                'error': result.get('error'),
            }

        return None  # Not a user-session tool, fall through

    def _handle_capture_screenshot(self, command_data):
        """Handle screenshot capture via user-session execution."""
        try:
            import base64

            monitor = command_data.get('monitor', 0)

            # Python code to run in the user's desktop session
            capture_code = f"""
import mss
import io
import os
from mss.tools import to_png

with mss.mss() as sct:
    mon_idx = {monitor} if {monitor} > 0 and {monitor} < len(sct.monitors) else 0
    screenshot = sct.grab(sct.monitors[mon_idx])
    png_bytes = to_png(screenshot.rgb, screenshot.size)

try:
    from PIL import Image
    img = Image.open(io.BytesIO(png_bytes))
    max_width = 3840
    if img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
    buffer = io.BytesIO()
    img.save(buffer, format='JPEG', quality=80)
    jpeg_bytes = buffer.getvalue()
except ImportError:
    jpeg_bytes = png_bytes

out_path = os.path.join(output_dir, 'screenshot.jpg')
with open(out_path, 'wb') as f:
    f.write(jpeg_bytes)
print(f'size_kb={{len(jpeg_bytes) // 1024}}')
print(f'monitors={{len(sct.monitors) - 1}}')
"""

            result = self.execute_in_user_session('python', capture_code, timeout=20)

            if result.get('error'):
                return f"Error: Screenshot failed: {result['error']}"

            if 'screenshot.jpg' not in result.get('files', []):
                stderr = result.get('stderr', '')
                return f"Error: Screenshot capture failed{': ' + stderr if stderr else ''}"

            # Read the captured screenshot
            # Find the output dir from the result files
            ipc_dir = shared_utils.get_data_path('ipc')
            # The result came from the most recent execution — find the screenshot
            # We need to locate it via the results directory
            results_base = os.path.join(ipc_dir, 'results')
            screenshot_path = None
            for d in sorted(os.listdir(results_base), reverse=True):
                candidate = os.path.join(results_base, d, 'screenshot.jpg')
                if os.path.exists(candidate):
                    screenshot_path = candidate
                    break

            if not screenshot_path:
                return "Error: Screenshot file not found after capture"

            with open(screenshot_path, 'rb') as f:
                jpeg_bytes = f.read()

            size_kb = len(jpeg_bytes) / 1024
            screenshot_b64 = base64.b64encode(jpeg_bytes).decode('ascii')

            logging.info(f"Screenshot captured: {size_kb:.0f}KB")

            # Cleanup result directory
            result_dir = os.path.dirname(screenshot_path)
            try:
                import shutil
                shutil.rmtree(result_dir, ignore_errors=True)
            except Exception:
                pass

            # Upload to Firebase Storage via web API
            upload_result = self._upload_screenshot(screenshot_b64)

            self.firebase_client.log_event(
                action='command_executed',
                level='info',
                details=f'Screenshot captured ({size_kb:.0f}KB)'
            )

            url = upload_result.get('url', '') if upload_result else ''
            monitor_label = f'monitor {monitor}' if monitor > 0 else 'all monitors'
            result_msg = f"Screenshot captured ({monitor_label}, {size_kb:.0f}KB)"
            if url:
                result_msg += f" — URL: {url}"
            return result_msg

        except Exception as e:
            return f"Error: Screenshot failed: {str(e)}"

    def _upload_screenshot(self, screenshot_b64):
        """Upload screenshot base64 to web API for storage in Firebase Storage.

        Returns:
            dict with 'url' and 'sizeKB' on success, None on failure.
        """
        try:
            import requests
            token = self.firebase_client.auth_manager.get_valid_token()
            api_base = shared_utils.get_api_base_url()
            response = requests.post(
                f"{api_base}/agent/screenshot",
                json={
                    'siteId': self.firebase_client.site_id,
                    'machineId': self.firebase_client.machine_id,
                    'screenshot': screenshot_b64,
                    'agentVersion': shared_utils.APP_VERSION,
                },
                headers={'Authorization': f'Bearer {token}'},
                timeout=30
            )
            if response.status_code != 200:
                logging.warning(f"Screenshot upload failed: {response.status_code} {response.text}")
                return None
            else:
                logging.info("Screenshot uploaded successfully")
                return response.json()
        except Exception as e:
            logging.warning(f"Screenshot upload failed: {e}")
            return None

    def _check_update_status(self):
        """
        Check if a self-update was in progress when the service started.
        This helps diagnose whether updates are completing successfully.
        Also detects stale markers from updates that never completed (crash, power loss, etc.)
        """
        try:
            update_marker_path = os.path.join(
                os.environ.get('ProgramData', 'C:\\ProgramData'),
                'Owlette', 'logs', 'update_in_progress.json'
            )

            if not os.path.exists(update_marker_path):
                return  # No update was in progress

            logging.debug("=" * 60)
            logging.info("UPDATE STATUS CHECK")
            logging.debug("=" * 60)

            import json
            with open(update_marker_path, 'r') as f:
                marker = json.load(f)

            old_version = marker.get('old_version', 'unknown')
            target_version = marker.get('target_version', 'unknown')
            started_at = marker.get('started_at', 'unknown')
            current_version = shared_utils.APP_VERSION

            logging.debug(f"Update started at: {started_at}")
            logging.debug(f"Old version: {old_version}")
            logging.debug(f"Target version: {target_version}")
            logging.debug(f"Current version: {current_version}")

            # ANTI-FRAGILE: Detect stale markers from updates that never completed
            # (e.g., power loss during install, BSOD, installer hung and was killed)
            from datetime import datetime
            marker_age_minutes = float('inf')
            try:
                marker_time = datetime.strptime(started_at, '%Y-%m-%d %H:%M:%S')
                marker_age_minutes = (datetime.now() - marker_time).total_seconds() / 60
                logging.debug(f"Update marker age: {marker_age_minutes:.1f} minutes")
            except (ValueError, TypeError):
                logging.warning(f"Could not parse marker timestamp: {started_at}")

            command_id = marker.get('command_id')
            deployment_id = marker.get('deployment_id')

            # Store result for Firebase logging + command completion after client starts
            if current_version == target_version:
                logging.info("[SUCCESS] Self-update completed successfully!")
                self._pending_update_event = ('update_success', f'Updated from {old_version} to {current_version}', 'info')
                self._pending_update_completion = ('completed', command_id, deployment_id, f'Updated to {current_version}')
            elif current_version == old_version:
                logging.error(f"[FAILED] Self-update FAILED - still on version {old_version}")
                logging.error("Check installer_update.log for details")
                if marker_age_minutes > 30:
                    logging.error(f"Marker is {marker_age_minutes:.0f}m old - update likely crashed or hung")
                self._pending_update_event = ('update_failed', f'Failed to update from {old_version} to {target_version}', 'error')
                self._pending_update_completion = ('failed', command_id, deployment_id, f'Still on {old_version}, target was {target_version}')
            else:
                logging.warning(f"[PARTIAL?] Unexpected version {current_version} after update")
                logging.warning(f"Expected {target_version}, was {old_version}")
                self._pending_update_event = ('update_unknown', f'Unexpected version {current_version} after update from {old_version}', 'warning')
                self._pending_update_completion = ('completed', command_id, deployment_id, f'Updated to {current_version} (expected {target_version})')

            logging.debug("=" * 60)

            # Clean up marker file
            try:
                os.remove(update_marker_path)
                logging.info("Update marker file cleaned up")
            except Exception as e:
                logging.warning(f"Failed to remove update marker: {e}")

            # ANTI-FRAGILE: Clean up any leftover recovery/update scheduled tasks
            try:
                # List and clean up any OwletteUpdate_* or OwletteRecovery_* tasks
                result = subprocess.run(
                    ['schtasks', '/Query', '/FO', 'LIST'],
                    capture_output=True, text=True, timeout=10
                )
                if result.returncode == 0:
                    import re
                    for task_match in re.finditer(r'(OwletteUpdate_\d+|OwletteRecovery_\d+)', result.stdout):
                        stale_task = task_match.group(1)
                        logging.info(f"Cleaning up leftover scheduled task: {stale_task}")
                        subprocess.run(
                            ['schtasks', '/Delete', '/TN', stale_task, '/F'],
                            capture_output=True, text=True, timeout=10
                        )
            except Exception as task_err:
                logging.debug(f"Task cleanup (non-fatal): {task_err}")

        except Exception as e:
            logging.warning(f"Error checking update status: {e}")
            # ANTI-FRAGILE: If we can't even read the marker, clean it up to prevent
            # blocking all future updates
            try:
                update_marker_path = os.path.join(
                    os.environ.get('ProgramData', 'C:\\ProgramData'),
                    'Owlette', 'logs', 'update_in_progress.json'
                )
                if os.path.exists(update_marker_path):
                    os.remove(update_marker_path)
                    logging.info("Cleaned up unreadable update marker")
            except:
                pass

    # Main main
    def main(self):

        # Process startup info
        self.startup_info = win32process.STARTUPINFO()
        self.startup_info.dwFlags = win32process.STARTF_USESHOWWINDOW

        # Enable critical privileges before first token acquisition.
        # LocalSystem has these assigned but NSSM child process may inherit them disabled.
        self._enable_privileges()

        # Initial user token acquisition. This is refreshed before each process launch
        # via _refresh_user_token() to handle session changes (logout/login, RDP, user switch).
        self.console_session_id = None
        self.console_user_token = None
        self.environment = None
        self._last_logged_session_id = None
        self._refresh_user_token()

        # Tray icon launch tracking — avoid thrashing (crash-relaunch loops)
        self._tray_last_launch_time = 0
        self._tray_launch_cooldown = 30  # seconds between launch attempts

        # Cortex (local AI agent) launch tracking
        self._cortex_last_launch_time = 0
        self._cortex_launch_cooldown = 30

        # Launch tray icon EARLY - before Firebase init which can take several seconds
        # This gives the user immediate visual feedback that the service is starting
        self._try_launch_tray()

        logging.info("Service initialization complete")

        # Check for update marker (indicates a self-update was in progress)
        self._check_update_status()

        # Start Firebase client and upload local config
        if self.firebase_client:
            try:
                # Register command callback
                self.firebase_client.register_command_callback(self.handle_firebase_command)

                # Register config update callback
                self.firebase_client.register_config_update_callback(self.handle_config_update)

                # Sync config: pull from Firestore (source of truth), or seed if new machine
                sync_result = self.firebase_client.sync_config_on_startup()
                logging.info(f"Config sync on startup: {sync_result}")

                # Wire state listener BEFORE start() so the CONNECTED event
                # writes the status file immediately (tray polls every 1s)
                def _on_connection_change(event):
                    try:
                        self._write_service_status()
                    except Exception:
                        pass
                self.firebase_client.connection_manager.add_state_listener(_on_connection_change)

                # Wire health callback
                self.firebase_client.connection_manager.set_health_callback(
                    lambda code, msg: self._update_health_state('connection_failure', code, msg)
                )

                # NOW start Firebase background threads (including config listener)
                # At this point, Firestore has our local config, and the hash is set
                self.firebase_client.start()
                logging.info("Firebase client started successfully")

                # Cache site timezone for schedule evaluation
                self._cached_site_timezone = self.firebase_client.site_timezone

                # Log any pending update event (from self-update check)
                if hasattr(self, '_pending_update_event') and self._pending_update_event:
                    event_type, message, level = self._pending_update_event
                    try:
                        self.firebase_client.log_event(event_type, message, level)
                        logging.info(f"Update event logged to Firebase: {event_type}")
                    except Exception as e:
                        logging.warning(f"Failed to log update event to Firebase: {e}")
                    self._pending_update_event = None

                # Report update command completion to Firestore (closes the loop for web dashboard)
                if hasattr(self, '_pending_update_completion') and self._pending_update_completion:
                    status, cmd_id, deployment_id, result_msg = self._pending_update_completion
                    if cmd_id:
                        try:
                            if status == 'completed':
                                self.firebase_client._mark_command_completed(cmd_id, result_msg, deployment_id, 'update_owlette')
                                if deployment_id:
                                    self.firebase_client.log_event('deployment_completed', 'info', 'Owlette Update',
                                                                   f"Deployment {deployment_id}: {result_msg}")
                            else:
                                self.firebase_client._mark_command_failed(cmd_id, result_msg, deployment_id, 'update_owlette')
                                if deployment_id:
                                    self.firebase_client.log_event('deployment_failed', 'error', 'Owlette Update',
                                                                   f"Deployment {deployment_id} failed: {result_msg}")
                            logging.info(f"Update command {cmd_id} marked as {status} in Firestore")
                        except Exception as e:
                            logging.warning(f"Failed to report update completion to Firestore: {e}")
                    self._pending_update_completion = None

                # Register atexit handler to ensure machine is marked offline even if killed abruptly
                def emergency_offline_handler():
                    """Emergency handler to mark machine offline if service is killed without proper shutdown"""
                    try:
                        if self.firebase_client and self.firebase_client.connected:
                            logging.warning("EMERGENCY CLEANUP: Marking machine offline")
                            self.firebase_client._update_presence(False)
                            logging.debug("Emergency offline update sent")
                    except Exception as e:
                        logging.debug(f"Emergency offline handler error (shutting down): {e}")

                atexit.register(emergency_offline_handler)
                logging.debug("Emergency offline handler registered")

                # Add Firebase log shipping if enabled
                shared_utils.add_firebase_log_handler(self.firebase_client)

            except Exception as e:
                logging.error(f"Error starting Firebase client: {e}")

        # Recover processes from previous session (if any are still running)
        logging.debug("Checking for processes from previous session...")
        self.recover_running_processes()

        # Clear stale reboot/shutdown flags from previous session (e.g., after a completed reboot)
        if self.firebase_client and self.firebase_client.is_connected():
            try:
                self.firebase_client.set_machine_flag('rebooting', False)
                self.firebase_client.set_machine_flag('shuttingDown', False)
                self.firebase_client.clear_reboot_pending()
                logging.info("Cleared stale reboot/shutdown flags on startup")
            except Exception as e:
                logging.warning(f"Failed to clear stale flags on startup: {e}")

        # The heart of Owlette
        cleanup_counter = 0  # Counter for periodic cleanup
        log_cleanup_counter = 0  # Counter for log cleanup (runs less frequently)
        firebase_check_counter = 0  # Counter for Firebase state check (runs every minute)
        last_firebase_state = {
            'enabled': self.firebase_client is not None,
            'site_id': shared_utils.read_config(['firebase', 'site_id']) if self.firebase_client else None
        }

        logging.info("Starting main service loop...")

        try:
            while self.is_alive:
                # Check for shutdown flag from tray icon
                shutdown_flag = shared_utils.get_data_path('tmp/shutdown.flag')
                if os.path.exists(shutdown_flag):
                    logging.info("Shutdown flag detected - initiating graceful shutdown")
                    try:
                        os.remove(shutdown_flag)
                    except Exception as e:
                        logging.debug(f"Could not remove shutdown flag: {e}")
                    self.is_alive = False
                    break

                # Check for restart flag from tray icon.
                # Exit with code 42 so NSSM auto-restarts us (AppExit Default Restart).
                # Code 42 is arbitrary non-zero — NSSM restarts on any non-zero exit.
                restart_flag = shared_utils.get_data_path('tmp/restart.flag')
                if os.path.exists(restart_flag):
                    logging.info("Restart flag detected — exiting for NSSM restart")
                    try:
                        os.remove(restart_flag)
                    except Exception as e:
                        logging.debug(f"Could not remove restart flag: {e}")
                    self._restart_exit_code = 42
                    self.is_alive = False
                    break

                # Ensure tray icon is running (with cooldown to avoid crash-relaunch thrashing)
                self._try_launch_tray()

                # Ensure Cortex is running (if enabled)
                self._try_launch_cortex()

                # Process Cortex IPC commands (Tier 2 tool calls)
                self._process_cortex_ipc_commands()

                # Get the current time
                self.current_time = datetime.datetime.now()

                # Load in latest results from the output file
                content = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)
                # Defensive programming: ensure content is never None
                if content is None:
                    content = {}
                if content:
                    self.results = content
                else:
                    # Initialize empty results if file was empty/corrupted
                    self.results = {}

                # Load in all processes in config json
                processes = shared_utils.read_config(['processes'])
                for process in processes:
                    mode = process.get('launch_mode', 'always' if process.get('autolaunch', False) else 'off')
                    if mode == 'always':
                        self.handle_process(process)
                    elif mode == 'scheduled':
                        process_id = process.get('id')
                        schedules = process.get('schedules')
                        in_window = shared_utils.is_within_schedule(schedules, self._cached_site_timezone)
                        has_override = process_id in self.manual_overrides

                        if in_window:
                            # Clear manual override when schedule window opens
                            if has_override:
                                del self.manual_overrides[process_id]
                            self.handle_process(process)
                        else:
                            # Outside schedule window
                            if has_override:
                                # Manual override active — keep processing (don't kill)
                                self.handle_process(process)
                            else:
                                # Check if process is running and should be stopped
                                last_info = self.last_started.get(process_id, {})
                                last_pid = last_info.get('pid')
                                if last_pid and not last_info.get('failed'):
                                    try:
                                        p = psutil.Process(last_pid)
                                        if p.is_running():
                                            p.terminate()
                                            logging.info(f"Stopped '{process.get('name')}' (PID {last_pid}) - outside schedule window")
                                            if self.firebase_client and self.firebase_client.is_connected():
                                                self.firebase_client.log_event(
                                                    action='process_killed',
                                                    level='info',
                                                    process_name=process.get('name'),
                                                    details='Stopped by schedule (outside active window)'
                                                )
                                            # Clear tracking so we don't keep trying to stop
                                            if process_id in self.last_started:
                                                del self.last_started[process_id]
                                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                                        pass
                    # mode == 'off': skip entirely

                if self.first_start:
                    logging.info('Owlette initialized')

                    # Log Agent Started event to Firestore
                    if self.firebase_client and self.firebase_client.is_connected():
                        try:
                            version = shared_utils.get_app_version()
                            self.firebase_client.log_event(
                                action='agent_started',
                                level='info',
                                process_name=None,
                                details=f'Owlette agent v{version} started successfully'
                            )
                            logging.debug("Logged agent_started event to Firestore")
                        except Exception as log_err:
                            logging.error(f"Failed to log agent_started event: {log_err}")

                self.first_start = False

                # Periodic check for Firebase state changes (every 2 iterations = 10 seconds)
                # This detects when Firebase is re-enabled via GUI or config file changes
                firebase_check_counter += 1
                if firebase_check_counter >= 2:
                    try:
                        current_firebase_enabled = shared_utils.read_config(['firebase', 'enabled'])
                        current_site_id = shared_utils.read_config(['firebase', 'site_id'])
                        current_firebase_state = {
                            'enabled': current_firebase_enabled and current_site_id is not None,
                            'site_id': current_site_id
                        }

                        # Detect state changes
                        was_enabled = last_firebase_state['enabled']
                        is_enabled = current_firebase_state['enabled']
                        old_site_id = last_firebase_state['site_id']
                        new_site_id = current_firebase_state['site_id']

                        # Case 1: Firebase was disabled and is now enabled
                        if not was_enabled and is_enabled:
                            logging.debug("=" * 60)
                            logging.info("FIREBASE RE-ENABLED DETECTED (via local config change)")
                            logging.debug(f"Site ID: {new_site_id}")
                            logging.debug("Reinitializing Firebase client...")
                            logging.debug("=" * 60)

                            success = self._initialize_or_restart_firebase_client()
                            if success:
                                logging.info("[OK] Firebase client restarted successfully")
                                last_firebase_state = current_firebase_state
                            else:
                                logging.error("[ERROR] Failed to restart Firebase client")

                        # Case 2: Site ID changed while Firebase was enabled
                        elif was_enabled and is_enabled and old_site_id != new_site_id:
                            logging.debug("=" * 60)
                            logging.info(f"SITE ID CHANGE DETECTED: {old_site_id} -> {new_site_id}")
                            logging.debug("Reinitializing Firebase client for new site...")
                            logging.debug("=" * 60)

                            success = self._initialize_or_restart_firebase_client()
                            if success:
                                logging.info("[OK] Firebase client restarted for new site")
                                last_firebase_state = current_firebase_state
                            else:
                                logging.error("[ERROR] Failed to restart Firebase client for new site")

                        # Case 3: Firebase was enabled and is now disabled
                        elif was_enabled and not is_enabled:
                            logging.info("Firebase has been DISABLED - stopping Firebase client")
                            if self.firebase_client:
                                try:
                                    self.firebase_client.stop()
                                    self.firebase_client = None
                                    logging.info("[OK] Firebase client stopped")
                                except Exception as e:
                                    logging.error(f"[ERROR] Failed to stop Firebase client: {e}")
                            last_firebase_state = current_firebase_state

                    except Exception as e:
                        logging.error(f"Error checking Firebase state: {e}")

                    firebase_check_counter = 0

                # Periodic cleanup of stale tracking data (every 30 iterations = 5 minutes)
                cleanup_counter += 1
                if cleanup_counter >= 60:
                    self.cleanup_stale_tracking_data()
                    cleanup_counter = 0

                # Periodic cleanup of old log files (every 8640 iterations = 24 hours)
                log_cleanup_counter += 1
                if log_cleanup_counter >= 17280:
                    try:
                        max_age_days = shared_utils.read_config(['logging', 'max_age_days']) or 90
                        deleted_count = shared_utils.cleanup_old_logs(max_age_days)
                        if deleted_count > 0:
                            logging.debug(f"Daily log cleanup: {deleted_count} old log file(s) removed")
                    except Exception as e:
                        logging.error(f"Log cleanup failed: {e}")
                    log_cleanup_counter = 0

                # Write service status for tray icon (every loop iteration = 10s)
                self._write_service_status()

                # Sleep for 10 seconds
                time.sleep(SLEEP_INTERVAL)
        finally:
            # CRITICAL: Cleanup when loop exits (graceful shutdown or signal handler)
            # This ensures machine is marked offline even when running in NSSM mode
            logging.warning("=== MAIN LOOP EXITING - PERFORMING CLEANUP ===")

            # Log Agent Stopped event to Firestore
            firebase_connected = self.firebase_client and self.firebase_client.is_connected()
            logging.info(f"Firebase client available: {self.firebase_client is not None}, connected: {firebase_connected}")

            # Note: agent_stopped is logged by signal handler in owlette_runner.py
            # (most reliable - always executes even if service is killed quickly)
            # No need to log here to avoid duplicate events
            if firebase_connected:
                logging.info("Main loop exiting - agent_stopped will be logged by signal handler")
                # Give Firebase time to flush any pending writes
                time.sleep(0.5)
            else:
                logging.warning("Firebase client not available")

            # Mark machine offline in Firestore
            if self.firebase_client:
                try:
                    logging.info("Calling firebase_client.stop() to mark machine offline...")
                    self.firebase_client.stop()
                    logging.info("[OK] Cleanup complete - machine marked offline")
                except Exception as e:
                    logging.error(f"[ERROR] Error during cleanup: {e}")

            # Close any open Owlette windows
            try:
                self.close_owlette_windows()
                logging.info("[OK] Owlette windows closed")
            except Exception as e:
                logging.error(f"Error closing windows: {e}")

            # Terminate tray icon
            try:
                self.terminate_tray_icon()
                logging.info("[OK] Tray icon terminated")
            except Exception as e:
                logging.error(f"Error terminating tray icon: {e}")

            logging.info("Service cleanup complete - exiting")

if __name__ == '__main__':
    # Check if running under NSSM (no command-line arguments)
    # or being run directly for debugging/testing
    import sys

    if len(sys.argv) == 1:
        # No arguments - running under NSSM or direct execution
        # Run the service main loop directly
        print("Starting Owlette service (NSSM mode)...")
        service = OwletteService(None)
        service.SvcDoRun()
    else:
        # Has arguments - use normal win32serviceutil command-line handling
        win32serviceutil.HandleCommandLine(OwletteService)
