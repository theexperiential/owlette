import os
import sys

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
import servicemanager
import logging
import psutil
import time
import json
import datetime
import atexit
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

"""
To install/run this as a service, 
switch to the current working directory in 
an Administrator Command Prompt & run:
python owlette_service.py install | start | stop | remove
"""

# Constants
LOG_FILE_PATH = shared_utils.get_data_path('logs/service.log')
MAX_RELAUNCH_ATTEMPTS = 3
SLEEP_INTERVAL = 10
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

        # Only initialize results file if it doesn't exist (don't clear existing PIDs!)
        if not os.path.exists(shared_utils.RESULT_FILE_PATH):
            Util.initialize_results_file()
            logging.info("Initialized new app_states.json file")

        # Upgrade JSON config to latest version
        logging.info(f"Config path: {shared_utils.CONFIG_PATH}")
        shared_utils.upgrade_config()

        self.hWaitStop = win32event.CreateEvent(None, 0, 0, None)
        self.is_alive = True
        self.tray_icon_pid = None
        self.relaunch_attempts = {} # Restart attempts for each process
        self.first_start = True # First start of this service
        self.last_started = {} # Last time a process was started
        self.results = {} # App process response esults
        self.current_time = datetime.datetime.now()
        self.active_installations = {} # Track active installer processes for cancellation

        # Initialize Firebase client
        self.firebase_client = None
        logging.info(f"Firebase check - Available: {FIREBASE_AVAILABLE}")

        if not FIREBASE_AVAILABLE and FIREBASE_IMPORT_ERROR:
            logging.warning(f"Firebase client not available - Import error: {FIREBASE_IMPORT_ERROR}")
            logging.warning("Running in local-only mode")

        if FIREBASE_AVAILABLE:
            firebase_enabled = shared_utils.read_config(['firebase', 'enabled'])
            logging.info(f"Firebase config - enabled: {firebase_enabled}")

            if firebase_enabled:
                try:
                    # Get configuration
                    site_id = shared_utils.read_config(['firebase', 'site_id'])
                    project_id = shared_utils.read_config(['firebase', 'project_id']) or "owlette-dev-3838a"
                    api_base = shared_utils.read_config(['firebase', 'api_base']) or "https://owlette.app/api"
                    cache_path = shared_utils.get_data_path('cache/firebase_cache.json')

                    logging.info(f"Firebase config - site: {site_id}, project: {project_id}")

                    # Initialize OAuth authentication manager
                    from auth_manager import AuthManager
                    auth_manager = AuthManager(api_base=api_base)

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
            api_base = shared_utils.read_config(['firebase', 'api_base']) or "https://owlette.app/api"
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
                logging.info("Stopping existing Firebase client before reinitialization...")
                try:
                    self.firebase_client.stop()
                    logging.info("Existing Firebase client stopped")
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

            # Upload local config before starting listeners
            local_config = shared_utils.read_config()
            if local_config:
                config_for_firestore = {k: v for k, v in local_config.items() if k != 'firebase'}

                # Pre-set hash to prevent listener loop
                import hashlib
                import json
                config_hash = hashlib.md5(json.dumps(config_for_firestore, sort_keys=True).encode()).hexdigest()
                self.firebase_client._last_uploaded_config_hash = config_hash
                logging.info(f"Pre-set config hash: {config_hash[:8]}...")

                self.firebase_client.upload_config(config_for_firestore)
                logging.info("Local config uploaded to Firebase")

            # Start Firebase client background threads
            self.firebase_client.start()
            logging.info(f"[OK] Firebase client initialized and started for site: {site_id}")

            # Write status file for tray icon
            self._write_service_status()

            return True

        except Exception as e:
            logging.error(f"Failed to initialize Firebase client: {e}")
            logging.exception("Firebase initialization error details:")
            self.firebase_client = None
            return False

    def _write_service_status(self, running=True):
        """
        Write current service status to file for tray icon to read.

        Creates/updates C:\\ProgramData\\Owlette\\tmp\\service_status.json with:
        - Service running state
        - Firebase enabled/connected state
        - Site ID
        - Last heartbeat timestamp
        - Service version

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
                }
            }

            # Write atomically (write to temp file, then rename)
            temp_path = status_path + '.tmp'
            with open(temp_path, 'w') as f:
                json.dump(status, f, indent=2)

            # Atomic rename on Windows
            if os.path.exists(status_path):
                os.remove(status_path)
            os.rename(temp_path, status_path)

        except Exception as e:
            logging.debug(f"Failed to write service status: {e}")

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

            logging.info(f"Found {len(app_states)} PID(s) in app_states.json")

            # Clean up dead PIDs immediately to prevent unbounded growth
            cleaned_states = {}
            dead_pid_count = 0

            # Get current config
            config = shared_utils.read_config()
            if not config:
                logging.warning("Could not load config for process recovery")
                return

            processes = config.get('processes', [])
            logging.info(f"Checking {len(processes)} configured process(es) for recovery")

            # Check each PID in the state file
            recovered_count = 0
            for pid_str, state_info in app_states.items():
                try:
                    pid = int(pid_str)
                    process_id = state_info.get('id')

                    logging.debug(f"Checking PID {pid} (process ID: {process_id})")

                    # Check if this PID is still running
                    if Util.is_pid_running(pid):
                        logging.info(f"PID {pid} is still running")

                        # Validate that this PID is actually the expected process (prevent PID reuse/hijacking)
                        if process_id:
                            process = next((p for p in processes if p.get('id') == process_id), None)

                            if process:
                                # Validate executable path matches
                                try:
                                    import psutil
                                    actual_process = psutil.Process(pid)
                                    actual_exe = actual_process.exe().lower()
                                    expected_exe = process.get('exe_path', '').replace('/', '\\').lower()

                                    # Check if the executable matches
                                    if expected_exe and expected_exe in actual_exe:
                                        # Valid process - keep in cleaned state
                                        cleaned_states[pid_str] = state_info

                                        # Only recover if autolaunch is enabled
                                        if process.get('autolaunch', False):
                                            # Adopt this process
                                            self.last_started[process_id] = {
                                                'time': datetime.datetime.now(),
                                                'pid': pid
                                            }
                                            recovered_count += 1
                                            logging.info(f"[OK] Recovered process '{process.get('name')}' with PID {pid}")
                                        else:
                                            logging.info(f"Skipping recovery of '{process.get('name')}' (PID {pid}) - autolaunch is disabled")
                                    else:
                                        # PID reused for different process - don't recover
                                        dead_pid_count += 1
                                        logging.warning(f"PID {pid} is running but executable mismatch (expected: {expected_exe}, actual: {actual_exe}) - likely PID reuse, not recovering")
                                except psutil.NoSuchProcess:
                                    # Process died between is_running check and exe() call
                                    dead_pid_count += 1
                                    logging.debug(f"PID {pid} died during validation")
                                except Exception as e:
                                    # On validation error, keep the PID to be safe
                                    cleaned_states[pid_str] = state_info
                                    logging.warning(f"Could not validate PID {pid}: {e} - keeping in state")
                            else:
                                # Process ID not found in config - keep in state but don't recover
                                cleaned_states[pid_str] = state_info
                                logging.warning(f"PID {pid} is running but process ID {process_id} not found in config")
                        else:
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
                logging.info("No running processes to recover from previous session")

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

    def _refresh_user_token(self):
        """Re-obtain the console user token, session ID, and environment block.

        Called before each process launch to ensure we have a fresh token for the
        current interactive session. This handles user logout/login, RDP disconnect,
        and fast user switching — scenarios where the token obtained at service startup
        becomes stale and points to a dead or wrong session.
        """
        try:
            session_id = win32ts.WTSGetActiveConsoleSessionId()
            if session_id == 0xFFFFFFFF:
                logging.warning("No active console session (headless/locked machine)")
                self.console_session_id = None
                self.console_user_token = None
                self.environment = None
                return False

            token = win32ts.WTSQueryUserToken(session_id)
            environment = win32profile.CreateEnvironmentBlock(token, False)

            # Close old token handle to avoid leaking logon sessions
            if self.console_user_token and self.console_user_token != token:
                try:
                    self.console_user_token.Close()
                except Exception:
                    pass

            self.console_session_id = session_id
            self.console_user_token = token
            self.environment = environment

            if session_id != getattr(self, '_last_logged_session_id', None):
                logging.info(f"User token refreshed for console session {session_id}")
                self._last_logged_session_id = session_id

            return True

        except Exception as e:
            logging.warning(f"Could not obtain console user token: {e}")
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

            self.startup_info.wShowWindow = win32con.SW_HIDE
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
                self.startup_info)
            if 'owlette_tray.py' in script_name:
                self.tray_icon_pid = pid
            return True
        except Exception as e:
            logging.error(f"Failed to start process: {e}")
            return False

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
            if not os.path.isfile(exe_path):
                raise FileNotFoundError('Executable path not found!')
        except Exception as e:
            logging.error(f'Error: {e}')
            return None

        # Fetch file path
        file_path = process.get('file_path', '')
        if file_path:
            # Convert forward slashes to backslashes for Windows
            file_path = file_path.replace('/', '\\')
        # If file path exists, leave as-is (could be file or cmd args)
        file_path = f"{file_path}" if os.path.isfile(file_path) else file_path
        logging.info(f"Starting {exe_path}{' ' if file_path else ''}{file_path}...")

        # Fetch working directory (convert empty string to None)
        cwd = process.get('cwd', None)
        if cwd == '':
            cwd = None
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

        # Track all VBS files created for cleanup
        vbs_cleanup_paths = []

        # For Hidden mode, use VBScript wrapper to launch without window
        # This is the most reliable method for truly hidden launches (works for console apps)
        if visibility == 'Hidden':
            # Create VBScript that launches process with window style 0 (hidden)
            # Use Chr(34) for quotes to avoid escaping issues
            if file_path:
                # Build command with proper quote escaping: "exe_path" "file_path"
                vbs_content = f'''Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & "{exe_path}" & Chr(34) & " " & Chr(34) & "{file_path}" & Chr(34), 0, False
Set WshShell = Nothing'''
            else:
                vbs_content = f'''Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & "{exe_path}" & Chr(34), 0, False
Set WshShell = Nothing'''

            # Write VBS to temp file
            import tempfile
            vbs_file = tempfile.NamedTemporaryFile(mode='w', suffix='.vbs', delete=False, dir=shared_utils.get_data_path('tmp'))
            vbs_file.write(vbs_content)
            vbs_path = vbs_file.name
            vbs_file.close()
            vbs_cleanup_paths.append(vbs_path)

            command = f'cscript.exe //nologo "{vbs_path}"'
            logging.info(f"Launching with Hidden visibility via VBScript wrapper")
        else:
            # Normal launch
            if file_path:
                command = f'"{exe_path}" "{file_path}"'
            else:
                command = f'"{exe_path}"'

        # Wrap command with working directory if specified
        if cwd:
            # Create a VBScript wrapper to launch with zero window visibility
            # VBScript's Run method with windowStyle=0 (vbHide) completely suppresses windows
            import tempfile

            # Escape quotes in command for VBScript
            vbs_command = command.replace('"', '""')

            vbs_content = f'''Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "{cwd}"
WshShell.Run "{vbs_command}", 0, False
'''

            # Create temp VBS file (in ProgramData, not install directory)
            tmp_dir = shared_utils.get_data_path('tmp')
            vbs_fd, vbs_path = tempfile.mkstemp(suffix='.vbs', dir=tmp_dir)
            try:
                with os.fdopen(vbs_fd, 'w') as f:
                    f.write(vbs_content)
                vbs_cleanup_paths.append(vbs_path)
                # Update command to execute VBS with hidden window
                command = f'wscript.exe //nologo "{vbs_path}"'
                logging.info(f"Command will run in directory: {cwd}")
            except Exception as e:
                logging.error(f"Failed to create VBS wrapper: {e}")
                if os.path.exists(vbs_path):
                    os.unlink(vbs_path)
                # Fall back to cmd approach
                command = f'cmd /c start /b /d "{cwd}" "" {command}'

        logging.info(f"Launching: {command}")
        if visibility not in ['Normal', 'Hidden']:
            logging.warning(f"Visibility mode '{visibility}' is not yet supported - using Normal visibility")
        if priority != 'Normal':
            logging.warning(f"Priority '{priority}' is not yet supported - using Normal priority")

        pid = None

        # Refresh user token to handle session changes (logout/login, RDP, user switch)
        self._refresh_user_token()

        if not self.console_user_token:
            logging.error("No interactive user session available - cannot launch process")
            return None

        # Launch process as the logged-in user via CreateProcessAsUser.
        # The token from WTSQueryUserToken is a primary token that carries the correct
        # session ID, so the process appears on the user's desktop automatically.
        # CREATE_NEW_PROCESS_GROUP isolates the process from the service's control group.
        try:
            startup_info = win32process.STARTUPINFO()
            startup_info.dwFlags = win32process.STARTF_USESHOWWINDOW
            if visibility == 'Hidden':
                startup_info.wShowWindow = win32con.SW_HIDE
            else:
                startup_info.wShowWindow = win32con.SW_SHOWNORMAL

            creation_flags = (
                win32con.NORMAL_PRIORITY_CLASS |
                win32con.CREATE_NEW_PROCESS_GROUP
            )

            _, _, proc_pid, _ = win32process.CreateProcessAsUser(
                self.console_user_token,
                None,       # Application Name
                command,    # Command Line
                None,       # Process Attributes
                None,       # Thread Attributes
                0,          # Inherit Handles
                creation_flags,
                self.environment,
                cwd,        # Working Directory
                startup_info
            )
            pid = proc_pid
            logging.info(f"Process launched with PID {pid} via CreateProcessAsUser")

        except Exception as e:
            logging.error(f"CreateProcessAsUser failed: {e}")
            logging.exception("Full traceback:")
            return None

        # Clean up VBS wrappers after a delay (in background thread)
        # This prevents race condition where wscript.exe hasn't finished reading the VBS file yet
        if vbs_cleanup_paths:
            import threading

            def delayed_vbs_cleanup(paths, delay=10):
                """Clean up VBS files after a delay to ensure wscript.exe has finished"""
                time.sleep(delay)
                for path in paths:
                    if os.path.exists(path):
                        try:
                            os.unlink(path)
                            logging.debug(f"Cleaned up VBS wrapper: {path}")
                        except Exception as e:
                            logging.warning(f"Failed to clean up VBS wrapper {path}: {e}")

            cleanup_thread = threading.Thread(
                target=delayed_vbs_cleanup,
                args=(vbs_cleanup_paths.copy(),),
                daemon=True
            )
            cleanup_thread.start()
            logging.debug(f"Scheduled VBS cleanup for {len(vbs_cleanup_paths)} file(s)")

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
        except:
            logging.error('JSON write error')

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
                    # If a restart prompt isn't already running, open one
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
                # Kill the process
                psutil.Process(pid).terminate()

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

                self.log_and_notify(
                    process,
                    f'Terminated PID {pid} and restarted with new PID {new_pid}'
                )
                # Status message - sync to Firebase immediately
                shared_utils.update_process_status_in_json(new_pid, 'LAUNCHING', self.firebase_client)

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
                return None

    # Attempt to launch the process if not running
    def handle_process_launch(self, process):
        # Validate executable path before attempting launch
        exe_path = process.get('exe_path', '').strip()
        if not exe_path:
            process_name = Util.get_process_name(process)
            logging.error(f"Cannot launch '{process_name}': Executable path is not set. Please configure a valid exe_path and disable/re-enable autolaunch.")
            return None

        if not os.path.isfile(exe_path):
            process_name = Util.get_process_name(process)
            logging.error(f"Cannot launch '{process_name}': Executable path does not exist: {exe_path}")
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
                    return None

                # Update the last started time and PID
                self.last_started[process_list_id] = {'time': self.current_time, 'pid': pid}
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
                shared_utils.update_process_status_in_json(pid, 'STALLED', self.firebase_client)
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
                logging.info(f"Process {process_name} (PID {pid}) hung for {hung_duration}s, waiting for confirmation ({self.HANG_CONFIRM_SECONDS}s threshold)")
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
                # No recovered PID, launch normally
                new_pid = self.handle_process_launch(process)
            else:
                # Process was recovered from previous session, just use it - sync to Firebase immediately
                shared_utils.update_process_status_in_json(last_pid, 'RUNNING', self.firebase_client)
                logging.info(f"Using recovered process '{process.get('name')}' with PID {last_pid}")
                new_pid = None  # Don't update last_started since it's already set

        else:
            # Check if process is running
            if last_pid and Util.is_pid_running(last_pid):
                # Launch scout to check if process is responsive
                self.launch_python_script_as_user(
                    shared_utils.get_path('owlette_scout.py'), 
                    str(last_pid)
                )
                new_pid = self.handle_unresponsive_process(last_pid, process)

                #  Everything is fine, keep calm and carry on - sync to Firebase immediately
                if not new_pid:
                    shared_utils.update_process_status_in_json(last_pid, 'RUNNING', self.firebase_client)

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
                    except:
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
                    else:
                        logging.info(f"Process {last_pid} was manually killed - skipping crash log")

                # Launch the process again if it isn't running
                new_pid = self.handle_process_launch(process)
        
        # Update last started info (for handling process startup timing)
        if new_pid:
            self.last_started[process_list_id] = {'time': self.current_time, 'pid': new_pid}

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

            # Write the updated config to local config.json
            shared_utils.write_json_to_file(new_config, shared_utils.CONFIG_PATH)

            logging.info("Local config.json updated from Firestore")

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
                    logging.info("=" * 60)
                    logging.info("Firebase has been RE-ENABLED - reinitializing Firebase client")
                    logging.info(f"Site ID: {new_site_id}")
                    logging.info("=" * 60)

                    # Reinitialize Firebase client
                    success = self._initialize_or_restart_firebase_client()
                    if success:
                        logging.info("[OK] Firebase client restarted successfully after being re-enabled")
                    else:
                        logging.error("[ERROR] Failed to restart Firebase client after being re-enabled")

                elif old_firebase_enabled and new_firebase_enabled and old_site_id != new_site_id:
                    logging.info("=" * 60)
                    logging.info(f"Site ID CHANGED: {old_site_id} -> {new_site_id}")
                    logging.info("Reinitializing Firebase client for new site")
                    logging.info("=" * 60)

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
                                psutil.Process(pid).terminate()
                                # Update status and sync to Firebase immediately
                                shared_utils.update_process_status_in_json(pid, 'STOPPED', self.firebase_client)
                                logging.info(f"[OK] Terminated removed process: {removed_proc.get('name')} (PID {pid})")
                            except Exception as e:
                                logging.error(f"Failed to terminate removed process PID {pid}: {e}")

                        # Clean up tracking
                        del self.last_started[removed_id]

                # Check for autolaunch changes (disable -> terminate)
                for process_id, new_proc in new_process_map.items():
                    if process_id in old_process_map:
                        old_proc = old_process_map[process_id]
                        old_autolaunch = old_proc.get('autolaunch', False)
                        new_autolaunch = new_proc.get('autolaunch', False)

                        if old_autolaunch and not new_autolaunch:
                            # Autolaunch disabled - terminate the process
                            logging.info(f"Autolaunch disabled for {new_proc.get('name')} - terminating process")

                            if process_id in self.last_started:
                                pid_info = self.last_started[process_id]
                                pid = pid_info.get('pid')

                                if pid and Util.is_pid_running(pid):
                                    try:
                                        psutil.Process(pid).terminate()
                                        # Update status and sync to Firebase immediately
                                        shared_utils.update_process_status_in_json(pid, 'STOPPED', self.firebase_client)
                                        logging.info(f"[OK] Terminated process with disabled autolaunch: {new_proc.get('name')} (PID {pid})")
                                    except Exception as e:
                                        logging.error(f"Failed to terminate PID {pid}: {e}")
                        elif new_autolaunch and not old_autolaunch:
                            logging.info(f"Autolaunch enabled for {new_proc.get('name')} - will start on next cycle")

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

            if cmd_type == 'restart_process':
                # Restart a specific process by name
                process_name = cmd_data.get('process_name')
                processes = shared_utils.read_config(['processes'])
                for process in processes:
                    if process.get('name') == process_name:
                        process_list_id = process['id']
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
                            psutil.Process(last_pid).terminate()
                            # Update status and sync to Firebase immediately
                            shared_utils.update_process_status_in_json(last_pid, 'STOPPED', self.firebase_client)
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

            elif cmd_type == 'toggle_autolaunch':
                # Toggle autolaunch for a specific process
                process_name = cmd_data.get('process_name')
                new_autolaunch_value = cmd_data.get('autolaunch', False)
                config = shared_utils.read_config()
                processes = config.get('processes', [])
                for process in processes:
                    if process.get('name') == process_name:
                        process['autolaunch'] = new_autolaunch_value
                        shared_utils.save_config(config)
                        logging.info(f"Autolaunch for {process_name} set to {new_autolaunch_value}")
                        return f"Autolaunch for {process_name} set to {new_autolaunch_value}"
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
                logging.info(f"URL: {installer_url}")
                logging.info(f"Flags: {silent_flags}")
                logging.info(f"Timeout: {timeout_seconds} seconds")
                if expected_sha256:
                    logging.info(f"Checksum verification enabled: {expected_sha256[:16]}...")

                # Get temporary path for installer
                temp_installer_path = installer_utils.get_temp_installer_path(installer_name)

                # Initialize self-update flag (must be before try block for finally block access)
                is_self_update = False

                try:
                    # Update status: downloading
                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'downloading', deployment_id)

                    # Download the installer
                    logging.info(f"Downloading installer to: {temp_installer_path}")
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

                    # SELF-UPDATE DETECTION: Check if this is an Owlette self-update
                    is_self_update = 'owlette' in installer_name.lower()

                    if is_self_update:
                        # SIMPLIFIED SELF-UPDATE:
                        # Just launch the installer - Inno Setup handles service stop/restart automatically
                        logging.warning("=" * 60)
                        logging.warning("SELF-UPDATE DETECTED: Running installer directly")
                        logging.warning(f"Installer: {installer_name}")
                        logging.warning("Inno Setup will handle service stop/restart automatically")
                        logging.warning("=" * 60)

                        try:
                            # Update status: installing
                            if self.firebase_client:
                                self.firebase_client.update_command_progress(cmd_id, 'installing', deployment_id)

                            # Launch installer as detached process
                            # Inno Setup will:
                            # 1. Stop this service automatically
                            # 2. Replace files
                            # 3. Restart service automatically
                            DETACHED_PROCESS = 0x00000008
                            CREATE_NO_WINDOW = 0x08000000

                            logging.info(f"Launching Owlette installer: {temp_installer_path}")
                            logging.info(f"Flags: {silent_flags}")

                            process = subprocess.Popen(
                                [temp_installer_path] + silent_flags,
                                creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW,
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL,
                                stdin=subprocess.DEVNULL
                            )

                            logging.info(f"Installer launched (PID: {process.pid})")
                            logging.info("Installer will handle service restart automatically")
                            logging.info("=" * 60)

                            return "Self-update initiated - installer running in background"

                        except Exception as e:
                            error_msg = f"Error launching installer: {str(e)}"
                            logging.error(error_msg)
                            logging.exception("Installer launch failed")
                            return error_msg

                    else:
                        # Normal installation (not self-update) - wait for completion
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
                        # Don't fail the installation if sync fails

                    return result_msg

                finally:
                    # Always cleanup the temporary installer file (with force=True to handle locked files)
                    # EXCEPT for self-updates: installer must stay on disk until it finishes extracting
                    try:
                        if not is_self_update:
                            installer_utils.cleanup_installer(temp_installer_path, force=True)
                        else:
                            logging.info("Skipping cleanup for self-update (installer will clean itself up)")
                    except Exception as cleanup_error:
                        logging.warning(f"Error in cleanup finally block: {cleanup_error}")

            elif cmd_type == 'update_owlette':
                # Self-update command: Downloads and installs new Owlette version
                # SIMPLIFIED: Download installer, launch it, let Inno Setup handle service restart
                installer_url = cmd_data.get('installer_url')
                deployment_id = cmd_data.get('deployment_id')  # For tracking deployment progress

                if not installer_url:
                    return "Error: No installer URL provided for update"

                logging.info("="*60)
                logging.info("OWLETTE SELF-UPDATE INITIATED")
                logging.info("="*60)
                logging.info(f"Installer URL: {installer_url}")
                logging.info("Inno Setup will handle service stop/restart automatically")

                try:
                    # Update status: downloading
                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'downloading', deployment_id)

                    # Download installer to our own temp directory (not WINDOWS\TEMP)
                    # Some security software blocks execution from system temp directories
                    logging.info("Downloading installer...")
                    owlette_tmp_dir = os.path.join(os.environ.get('ProgramData', 'C:\\ProgramData'), 'Owlette', 'tmp')
                    os.makedirs(owlette_tmp_dir, exist_ok=True)
                    temp_installer_path = os.path.join(owlette_tmp_dir, 'Owlette-Update.exe')

                    import urllib.request
                    urllib.request.urlretrieve(installer_url, temp_installer_path)
                    logging.info(f"Installer downloaded to: {temp_installer_path}")

                    # Verify downloaded file
                    if not os.path.exists(temp_installer_path):
                        raise Exception("Installer file not found after download")

                    file_size = os.path.getsize(temp_installer_path)
                    logging.info(f"Installer file size: {file_size:,} bytes")

                    # Sanity check - Inno Setup installer should be at least 1MB
                    if file_size < 1_000_000:
                        raise Exception(f"Downloaded file too small ({file_size} bytes) - likely not a valid installer")

                    # Verify it's a valid PE executable (check MZ header)
                    with open(temp_installer_path, 'rb') as f:
                        header = f.read(2)
                        if header != b'MZ':
                            raise Exception("Downloaded file is not a valid Windows executable")

                    logging.info("Installer verified successfully")

                    # Create update marker file (persists across service restart)
                    # This helps diagnose whether updates are completing successfully
                    update_marker_path = os.path.join(os.environ.get('ProgramData', 'C:\\ProgramData'), 'Owlette', 'logs', 'update_in_progress.json')
                    import json
                    update_marker = {
                        'started_at': time.strftime('%Y-%m-%d %H:%M:%S'),
                        'old_version': shared_utils.APP_VERSION,
                        'target_version': target_version,
                        'installer_url': installer_url,
                        'installer_path': temp_installer_path,
                        'command_id': cmd_id
                    }
                    with open(update_marker_path, 'w') as f:
                        json.dump(update_marker, f, indent=2)
                    logging.info(f"Update marker created: {update_marker_path}")

                    # Update status: installing
                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'installing', deployment_id)

                    # Launch installer via Windows Task Scheduler (survives service stop)
                    # This ensures installer keeps running even when Inno Setup kills the service
                    # Include /LOG to help diagnose failures on problematic systems
                    log_path = os.path.join(os.environ.get('ProgramData', 'C:\\ProgramData'), 'Owlette', 'logs', 'installer_update.log')
                    silent_flags = f'/VERYSILENT /NORESTART /SUPPRESSMSGBOXES /ALLUSERS /LOG="{log_path}"'
                    task_name = f"OwletteUpdate_{int(time.time())}"

                    logging.info(f"Creating scheduled task: {task_name}")
                    logging.info(f"Installer flags: {silent_flags}")
                    logging.info(f"Installer log will be written to: {log_path}")

                    # Create one-time task that runs immediately as SYSTEM
                    schtasks_cmd = [
                        'schtasks',
                        '/Create',
                        '/TN', task_name,
                        '/TR', f'"{temp_installer_path}" {silent_flags}',
                        '/SC', 'ONCE',
                        '/ST', '00:00',  # Start time (will be forced to run immediately)
                        '/RU', 'SYSTEM',
                        '/RL', 'HIGHEST',
                        '/F'  # Force create (overwrite if exists)
                    ]

                    result = subprocess.run(
                        schtasks_cmd,
                        capture_output=True,
                        text=True,
                        timeout=10
                    )

                    if result.returncode != 0:
                        raise Exception(f"Failed to create scheduled task: {result.stderr}")

                    logging.info(f"Scheduled task created: {task_name}")

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

                    # Delete the task after a delay (cleanup) - but don't wait for it
                    # The task will self-clean after installer completes
                    cleanup_cmd = f'schtasks /Delete /TN "{task_name}" /F'
                    subprocess.Popen(
                        f'timeout /t 300 && {cleanup_cmd}',  # Delete after 5 min
                        shell=True,
                        creationflags=0x00000008,  # DETACHED_PROCESS
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL
                    )

                    logging.info("Installer will handle service restart automatically")
                    logging.info("="*60)

                    return "Self-update initiated via Task Scheduler"

                except Exception as e:
                    error_msg = f"Error initiating update: {str(e)}"
                    logging.error(error_msg)
                    logging.exception("Update initiation failed")
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
                logging.info(f"Uninstall command: {uninstall_command}")
                logging.info(f"Installer type: {installer_type}")
                logging.info(f"Timeout: {timeout_seconds} seconds")

                # Build complete silent uninstall command
                if not silent_flags:
                    # Auto-detect silent flags if not provided
                    silent_flags = registry_utils.get_silent_uninstall_flags(installer_type)
                    logging.info(f"Auto-detected silent flags: {silent_flags}")

                complete_command = registry_utils.build_silent_uninstall_command(
                    uninstall_command,
                    installer_type
                ) if not silent_flags else f"{uninstall_command} {silent_flags}"

                logging.info(f"Complete uninstall command: {complete_command}")

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
                        shell=True,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True
                    )

                    # Track process for potential cancellation
                    self.active_installations[uninstall_process_name] = process
                    logging.info(f"Tracking uninstall process: {uninstall_process_name} (PID: {process.pid})")

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
                logging.info(f"URL: {project_url}")
                logging.info(f"Extract path: {extract_path or 'default'}")

                # Determine extraction path
                if not extract_path:
                    extract_path = project_utils.get_default_project_directory()
                    logging.info(f"Using default extraction path: {extract_path}")

                # Get temporary path for project ZIP
                temp_project_path = project_utils.get_temp_project_path(project_name)

                try:
                    # Update status: downloading
                    if self.firebase_client:
                        self.firebase_client.update_command_progress(cmd_id, 'downloading', distribution_id)

                    # Download the project ZIP
                    logging.info(f"Downloading project to: {temp_project_path}")
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

            else:
                logging.warning(f"Unknown command type: {cmd_type}")
                return f"Unknown command type: {cmd_type}"

        except Exception as e:
            error_msg = f"Error executing command {cmd_type}: {e}"
            logging.error(error_msg)
            return error_msg

    def _check_update_status(self):
        """
        Check if a self-update was in progress when the service started.
        This helps diagnose whether updates are completing successfully.
        """
        try:
            update_marker_path = os.path.join(
                os.environ.get('ProgramData', 'C:\\ProgramData'),
                'Owlette', 'logs', 'update_in_progress.json'
            )

            if not os.path.exists(update_marker_path):
                return  # No update was in progress

            logging.info("=" * 60)
            logging.info("UPDATE STATUS CHECK")
            logging.info("=" * 60)

            import json
            with open(update_marker_path, 'r') as f:
                marker = json.load(f)

            old_version = marker.get('old_version', 'unknown')
            target_version = marker.get('target_version', 'unknown')
            started_at = marker.get('started_at', 'unknown')
            current_version = shared_utils.APP_VERSION

            logging.info(f"Update started at: {started_at}")
            logging.info(f"Old version: {old_version}")
            logging.info(f"Target version: {target_version}")
            logging.info(f"Current version: {current_version}")

            # Store result for Firebase logging after client starts
            if current_version == target_version:
                logging.info("[SUCCESS] Self-update completed successfully!")
                self._pending_update_event = ('update_success', f'Updated from {old_version} to {current_version}', 'info')
            elif current_version == old_version:
                logging.error(f"[FAILED] Self-update FAILED - still on version {old_version}")
                logging.error("Check installer_update.log for details")
                self._pending_update_event = ('update_failed', f'Failed to update from {old_version} to {target_version}', 'error')
            else:
                logging.warning(f"[PARTIAL?] Unexpected version {current_version} after update")
                logging.warning(f"Expected {target_version}, was {old_version}")
                self._pending_update_event = ('update_unknown', f'Unexpected version {current_version} after update from {old_version}', 'warning')

            logging.info("=" * 60)

            # Clean up marker file
            try:
                os.remove(update_marker_path)
                logging.info("Update marker file cleaned up")
            except Exception as e:
                logging.warning(f"Failed to remove update marker: {e}")

        except Exception as e:
            logging.warning(f"Error checking update status: {e}")

    # Main main
    def main(self):

        # Process startup info
        self.startup_info = win32process.STARTUPINFO()
        self.startup_info.dwFlags = win32process.STARTF_USESHOWWINDOW

        # Initial user token acquisition. This is refreshed before each process launch
        # via _refresh_user_token() to handle session changes (logout/login, RDP, user switch).
        self.console_session_id = None
        self.console_user_token = None
        self.environment = None
        self._last_logged_session_id = None
        self._refresh_user_token()

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

                # CRITICAL: Upload local config to Firestore BEFORE starting the config listener
                # This prevents a race condition where the listener processes an empty/old Firestore config
                # before we upload the local config, which would wipe out the firebase auth section
                local_config = shared_utils.read_config()
                if local_config:
                    # Create a copy without the firebase section (local auth config, not for Firestore)
                    config_for_firestore = {k: v for k, v in local_config.items() if k != 'firebase'}

                    # Pre-set the hash BEFORE uploading to prevent listener from processing this upload
                    import hashlib
                    import json
                    config_hash = hashlib.md5(json.dumps(config_for_firestore, sort_keys=True).encode()).hexdigest()
                    self.firebase_client._last_uploaded_config_hash = config_hash
                    logging.info(f"Pre-set config hash to prevent listener loop: {config_hash[:8]}...")

                    # Now upload
                    self.firebase_client.upload_config(config_for_firestore)
                    logging.info("Local config uploaded to Firebase (firebase auth section excluded)")

                # NOW start Firebase background threads (including config listener)
                # At this point, Firestore has our local config, and the hash is set
                self.firebase_client.start()
                logging.info("Firebase client started successfully")

                # Log any pending update event (from self-update check)
                if hasattr(self, '_pending_update_event') and self._pending_update_event:
                    event_type, message, level = self._pending_update_event
                    try:
                        self.firebase_client.log_event(event_type, message, level)
                        logging.info(f"Update event logged to Firebase: {event_type}")
                    except Exception as e:
                        logging.warning(f"Failed to log update event to Firebase: {e}")
                    self._pending_update_event = None

                # Register atexit handler to ensure machine is marked offline even if killed abruptly
                def emergency_offline_handler():
                    """Emergency handler to mark machine offline if service is killed without proper shutdown"""
                    try:
                        if self.firebase_client and self.firebase_client.connected:
                            logging.warning("EMERGENCY CLEANUP: Marking machine offline")
                            self.firebase_client._update_presence(False)
                            logging.info("Emergency offline update sent")
                    except:
                        pass  # Fail silently - we're shutting down anyway

                atexit.register(emergency_offline_handler)
                logging.info("Emergency offline handler registered")

                # Add Firebase log shipping if enabled
                shared_utils.add_firebase_log_handler(self.firebase_client)

            except Exception as e:
                logging.error(f"Error starting Firebase client: {e}")

        # Recover processes from previous session (if any are still running)
        logging.info("Checking for processes from previous session...")
        self.recover_running_processes()

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
                    except:
                        pass
                    self.is_alive = False
                    break

                # Check for restart flag from tray icon
                restart_flag = shared_utils.get_data_path('tmp/restart.flag')
                if os.path.exists(restart_flag):
                    logging.info("Restart flag detected - logging agent_stopped before restart")
                    try:
                        os.remove(restart_flag)
                    except:
                        pass

                    # Note: agent_stopped is logged by signal handler in owlette_runner.py
                    # (most reliable - always executes even if service is killed quickly)
                    # No need to log here to avoid duplicate events
                    if self.firebase_client:
                        logging.info("Restart requested - agent_stopped will be logged by signal handler")
                    else:
                        logging.warning("No Firebase client - cannot log agent_stopped")

                # Start the tray icon script as a process (if it isn't running)
                tray_script = 'owlette_tray.py'
                if not shared_utils.is_script_running(tray_script):
                    self.launch_python_script_as_user(tray_script)

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
                    if process.get('autolaunch', False): # Default to False if not found
                        self.handle_process(process)

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
                            logging.info("Logged agent_started event to Firestore")
                        except Exception as log_err:
                            logging.error(f"Failed to log agent_started event: {log_err}")

                self.first_start = False

                # Periodic check for Firebase state changes (every 6 iterations = 1 minute)
                # This detects when Firebase is re-enabled via GUI or config file changes
                firebase_check_counter += 1
                if firebase_check_counter >= 6:
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
                            logging.info("=" * 60)
                            logging.info("FIREBASE RE-ENABLED DETECTED (via local config change)")
                            logging.info(f"Site ID: {new_site_id}")
                            logging.info("Reinitializing Firebase client...")
                            logging.info("=" * 60)

                            success = self._initialize_or_restart_firebase_client()
                            if success:
                                logging.info("[OK] Firebase client restarted successfully")
                                last_firebase_state = current_firebase_state
                            else:
                                logging.error("[ERROR] Failed to restart Firebase client")

                        # Case 2: Site ID changed while Firebase was enabled
                        elif was_enabled and is_enabled and old_site_id != new_site_id:
                            logging.info("=" * 60)
                            logging.info(f"SITE ID CHANGE DETECTED: {old_site_id} -> {new_site_id}")
                            logging.info("Reinitializing Firebase client for new site...")
                            logging.info("=" * 60)

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
                if cleanup_counter >= 30:
                    self.cleanup_stale_tracking_data()
                    cleanup_counter = 0

                # Periodic cleanup of old log files (every 8640 iterations = 24 hours)
                log_cleanup_counter += 1
                if log_cleanup_counter >= 8640:
                    try:
                        max_age_days = shared_utils.read_config(['logging', 'max_age_days']) or 90
                        deleted_count = shared_utils.cleanup_old_logs(max_age_days)
                        if deleted_count > 0:
                            logging.info(f"Daily log cleanup: {deleted_count} old log file(s) removed")
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
