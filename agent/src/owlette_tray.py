import os
import sys

# Ensure our source directory is on the path (so we work without PYTHONPATH or batch wrapper)
_src_dir = os.path.dirname(os.path.abspath(__file__))
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

import shared_utils

# Set app identity so Windows notifications show "owlette" instead of "Python"
import ctypes
ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('tec.owlette.tray')

import pystray
from pystray import MenuItem as item
from PIL import Image
import subprocess
import logging
import psutil
import ctypes
import winreg
import win32gui
import win32con
import threading
import time
import json
import win32serviceutil
import win32service

pid = None
start_on_login = True  # updated from registry in _run_tray() before first menu build
current_status = {'service': 'unknown', 'firebase': 'unknown'}
last_status = {'service': 'unknown', 'firebase': 'unknown'}
status_lock = threading.Lock()

# Icon flashing state
_flash_active = False
_flash_stop = threading.Event()

# Notification debounce — only notify if degraded state persists
_degraded_since = None   # timestamp when status first went non-normal
_degraded_notified = False  # True once we've sent a notification for this degraded period
_NOTIFY_DELAY = 5        # seconds a degraded state must persist before notifying

def _start_flash(icon, status_code):
    """Start flashing the tray icon between normal and error/warning."""
    global _flash_active
    if _flash_active:
        return
    _flash_active = True
    _flash_stop.clear()

    def flash_loop():
        global _flash_active
        normal_icon = load_icon('normal')
        alert_icon = load_icon(status_code)
        show_alert = True
        while not _flash_stop.is_set():
            try:
                icon.icon = alert_icon if show_alert else normal_icon
            except Exception:
                break
            show_alert = not show_alert
            _flash_stop.wait(0.8)
        _flash_active = False

    t = threading.Thread(target=flash_loop, daemon=True)
    t.start()

def _stop_flash():
    """Stop flashing the tray icon."""
    global _flash_active
    _flash_stop.set()
    _flash_active = False

# Function to detect Windows theme (light or dark)
def is_windows_dark_theme():
    """
    Detect if Windows is using dark theme.
    Returns True for dark theme, False for light theme.
    """
    try:
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r'Software\Microsoft\Windows\CurrentVersion\Themes\Personalize',
            0,
            winreg.KEY_READ
        )
        value, _ = winreg.QueryValueEx(key, 'SystemUsesLightTheme')
        winreg.CloseKey(key)
        # 0 = dark theme, 1 = light theme
        return value == 0
    except Exception as e:
        logging.debug(f"Could not detect Windows theme: {e}")
        # Default to dark theme if detection fails
        return True

# Function to load icon image from file
def load_icon(status='normal'):
    """
    Load universal tray icon (white lines on dark grey background).

    Single icon design that works on both light and dark taskbars.
    Status indicated by center dot color:
    - normal: White dot (everything OK, Always Watching)
    - warning: Orange dot (Firebase connection issues)
    - error: Red dot (service stopped/disconnected)
    """
    # Use .ico files for better Windows HiDPI support
    # .ico files contain multiple resolutions (16x16 to 256x256) that Windows
    # automatically selects based on DPI settings
    icon_path = shared_utils.get_path(f'../icons/{status}.ico')

    # Fallback to .png if .ico doesn't exist (backwards compatibility)
    if not os.path.exists(icon_path):
        logging.debug(f"ICO file not found: {icon_path}, trying PNG")
        icon_path = shared_utils.get_path(f'../icons/{status}.png')

    if not os.path.exists(icon_path):
        logging.warning(f"Icon file not found: {icon_path}, falling back to normal.ico")
        icon_path = shared_utils.get_path('../icons/normal.ico')
        if not os.path.exists(icon_path):
            icon_path = shared_utils.get_path('../icons/normal.png')

    try:
        return Image.open(icon_path)
    except Exception as e:
        logging.error(f"Failed to load icon: {e}")
        # Return a simple fallback icon if files are missing
        size = 64
        image = Image.new('RGBA', (size, size), (255, 255, 255, 255))
        return image

# Function to check Windows service status
def check_service_running():
    """
    Check if OwletteService is running.
    Returns True if running, False if stopped/not installed.
    """
    try:
        status = win32serviceutil.QueryServiceStatus('OwletteService')[1]
        # SERVICE_RUNNING = 4
        return status == 4
    except Exception as e:
        logging.debug(f"Service status check failed: {e}")
        return False

# Function to read service status from IPC file
_last_good_status = None  # Cache last successful read to ride through atomic-rename races
_last_good_status_time = 0  # Timestamp of last successful read

def read_service_status():
    """
    Read service status from status file written by service.

    The service writes C:\\ProgramData\\Owlette\\tmp\\service_status.json
    every 10 seconds with current Firebase connection state.

    Returns dict or None if file doesn't exist and has never been read.
    On transient read failures (PermissionError, JSONDecodeError during
    atomic rename), returns the last successfully read status to avoid
    false-positive "Starting" flickers in determine_status().
    """
    global _last_good_status, _last_good_status_time
    try:
        status_path = shared_utils.get_data_path('tmp/service_status.json')

        if not os.path.exists(status_path):
            logging.debug(f"[STATUS] Status file does not exist: {status_path}")
            return None

        # Check file age (stale if > 120 seconds old)
        file_age = time.time() - os.path.getmtime(status_path)

        if file_age > 120:
            logging.warning(f"[STATUS] Service status file is stale ({int(file_age)}s old)")
            return None

        # Parse JSON
        with open(status_path, 'r') as f:
            status_data = json.load(f)
            _last_good_status = status_data
            _last_good_status_time = time.time()
            return status_data

    except NameError as e:
        logging.error(f"[STATUS] NameError (json module not imported?): {e}")
        return None
    except (json.JSONDecodeError, PermissionError, OSError) as e:
        # Transient failures during atomic rename — return cached status if fresh enough
        if _last_good_status is not None and (time.time() - _last_good_status_time) < 60:
            logging.debug(f"[STATUS] Transient read error, using cached status: {e}")
            return _last_good_status
        logging.error(f"[STATUS] Failed to read service status (no cache or cache too old): {e}")
        return None
    except Exception as e:
        logging.error(f"[STATUS] Failed to read service status: {e}", exc_info=True)
        return None

# Function to determine overall status
def determine_status():
    """
    Determine overall system status using IPC status file from service.

    Returns tuple of (status_code, service_msg, firebase_msg) where:
    - status_code: 'error' (red), 'warning' (orange), 'normal' (white)
    - service_msg: "Service: Running" or "Service: Stopped"
    - firebase_msg: "Connected", "Connecting", "Disconnected", "Disabled", "Unknown"
    """
    # Try to read status file first (IPC from service)
    status_data = read_service_status()

    if not status_data:
        # Fallback to checking Windows service status directly
        service_running = check_service_running()
        if not service_running:
            return 'error', 'Service: Stopped', 'Unknown'
        else:
            # Service running but no status file - likely starting up
            return 'warning', 'Service: Running', 'Starting'

    # --- Health probe errors take priority (config/auth issues) ---
    health = status_data.get('health', {})
    health_status = health.get('status')
    if health_status and health_status not in ('ok', 'unknown'):
        error_code = health.get('error_code', health_status)
        return 'error', 'Service: Error', error_code

    # Service reports its own status
    service_running = status_data.get('service', {}).get('running', False)
    firebase_enabled = status_data.get('firebase', {}).get('enabled', False)
    firebase_connected = status_data.get('firebase', {}).get('connected', False)
    site_id = status_data.get('firebase', {}).get('site_id', '')

    # Determine Firebase message
    if not firebase_enabled or not site_id:
        firebase_msg = 'Disabled'
    elif firebase_connected:
        firebase_msg = 'Connected'
    else:
        firebase_msg = 'Disconnected'

    # Determine overall status code (icon color)
    if not service_running:
        return 'error', 'Service: Stopped', firebase_msg

    if not firebase_enabled or not site_id:
        # Firebase disabled = red dot (not monitoring)
        return 'error', 'Service: Running', firebase_msg
    elif firebase_connected:
        # Connected = white dot (all good)
        return 'normal', 'Service: Running', firebase_msg
    else:
        # Not connected = orange dot (connection issues)
        return 'warning', 'Service: Running', firebase_msg

# Function to check if process is running
def is_process_running(pid):
    if pid is None:
        return False
    try:
        process = psutil.Process(pid)
        return True if process.is_running() else False
    except psutil.NoSuchProcess:
        return False
    except Exception as e:
        logging.error(f"Failed to check if process is running: {e}")
        return False

# Function to open configuration
def open_config_gui(icon, item):
    global pid
    gui_title = shared_utils.WINDOW_TITLES.get("owlette_gui")
    # First, try to find and focus an existing GUI window
    try:
        hwnd = win32gui.FindWindow(None, gui_title)
        logging.info(f"[TRAY] open_config_gui: FindWindow('{gui_title}') = {hwnd}, pid={pid}, running={is_process_running(pid)}")
        if hwnd:
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            win32gui.SetForegroundWindow(hwnd)
            return
    except Exception as e:
        logging.error(f"Failed to bring Owlette GUI to the front: {e}")

    # No visible window — kill any zombie process and spawn fresh
    if is_process_running(pid):
        logging.info(f"[TRAY] Killing zombie GUI process {pid}")
        try:
            psutil.Process(pid).kill()
        except Exception:
            pass
    try:
        process = subprocess.Popen(
            ["pythonw", shared_utils.get_path('owlette_gui.py')],
            creationflags=subprocess.CREATE_NO_WINDOW
        )
        pid = process.pid
        logging.info(f"[TRAY] Spawned GUI process {pid}")
    except Exception as e:
        logging.error(f"Failed to open Owlette GUI: {e}")

# Function to restart the service (using UAC elevation)
def restart_service(icon, item):
    """
    Restart the Owlette service and tray icon.

    No UAC prompt needed — the tray writes a restart flag, the service detects
    it and exits with code 42, NSSM automatically restarts the service (AppExit
    Default Restart), and the service relaunches the tray on startup.
    """
    try:
        logging.info("Starting service restart procedure...")

        # Show notification immediately for user feedback
        try:
            icon.notify(
                title="owlette — restarting",
                message="restarting service — will return momentarily"
            )
        except:
            pass

        # Close all Owlette windows first
        for window_title in shared_utils.WINDOW_TITLES.values():
            try:
                hwnd = win32gui.FindWindow(None, window_title)
                if hwnd:
                    win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
                    logging.info(f"Closed window: {window_title}")
            except Exception as e:
                logging.debug(f"Could not close window '{window_title}': {e}")

        # Write restart flag — service picks this up and exits with code 42,
        # which triggers NSSM's automatic restart (AppExit Default Restart).
        restart_flag = shared_utils.get_data_path('tmp/restart.flag')
        os.makedirs(os.path.dirname(restart_flag), exist_ok=True)
        with open(restart_flag, 'w') as f:
            f.write('restart_requested')
        logging.info("Restart flag written — service will restart via NSSM")

        # Stop the tray icon — service will relaunch it after restart
        time.sleep(0.5)
        icon.stop()
        logging.info("Tray icon stopped, waiting for service restart")

    except Exception as e:
        logging.error(f"Failed to initiate service restart: {e}")
        try:
            icon.notify(
                title="restart failed",
                message=f"Error: {str(e)}"
            )
        except:
            pass

# Function to exit
def exit_action(icon, item):
    try:
        for key, window_title in shared_utils.WINDOW_TITLES.items():
            # Try to close the configuration window if it's open
            hwnd = win32gui.FindWindow(None, window_title)
            if hwnd:
                # Close the window
                win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)

        # Write shutdown flag file for service to detect
        shutdown_flag = shared_utils.get_data_path('tmp/shutdown.flag')
        os.makedirs(os.path.dirname(shutdown_flag), exist_ok=True)
        with open(shutdown_flag, 'w') as f:
            f.write('exit')
        logging.info("Shutdown flag written - service will exit gracefully")

        # Give service a moment to detect the flag and shut down
        time.sleep(2)
    except Exception as e:
        logging.error(f"Failed to initiate shutdown: {e}")
    icon.stop()


# Function to change the registry setting for the Windows Service
def on_select(icon, item):
    global start_on_login  # Declare global to modify it
    
    try:
        #logging.info(f"Checkbox state before action: {start_on_login}")

        # Check for admin rights
        is_admin = ctypes.windll.shell32.IsUserAnAdmin() != 0

        # Set the service start type
        start_type = "delayed-auto" if not start_on_login else "disabled"

        if not is_admin:
            # Re-run the command with admin rights
            ctypes.windll.shell32.ShellExecuteW(None, "runas", "cmd.exe", f"/c sc config OwletteService start= {start_type}", None, 0)
        else:
            subprocess.run(
                f'sc config OwletteService start= {start_type}',
                shell=True,
                creationflags=subprocess.CREATE_NO_WINDOW
            )

        start_on_login = not start_on_login  # Toggle the checkbox state
        #logging.info(f"Checkbox state after action: {start_on_login}")
        
        # Update menu
        icon.menu = generate_menu()
        icon.update_menu()

    except Exception as e:
        logging.error(f"Failed to change service startup type: {e}")


# Function to check the service status
def check_service_status():
    try:
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, 'SYSTEM\\CurrentControlSet\\Services\\OwletteService', 0, winreg.KEY_READ)
        start_type, _ = winreg.QueryValueEx(key, 'Start')
        winreg.CloseKey(key)
        return start_type == 0x2
    except Exception as e:
        logging.error(f"Failed to read service start type: {e}")
        return False

# Status monitoring thread
def monitor_status(icon):
    """
    Background thread that monitors service and Firebase status.
    Updates icon and sends notifications when status changes.
    """
    global current_status, last_status

    # Wait for icon to become visible (icon.run() is called after thread starts)
    logging.debug("[MONITOR] Waiting for icon to become visible...")
    for i in range(100):  # Wait up to 10 seconds
        if icon.visible:
            break
        time.sleep(0.1)

    if not icon.visible:
        logging.error("[MONITOR] Icon never became visible after 10s, exiting monitor thread")
        return

    logging.debug("[MONITOR] Icon is visible, starting status monitoring loop")

    # Grace period after startup to avoid false-alarm notifications (seconds)
    started_at = time.time()
    grace_period = 10

    while icon.visible:
        try:
            status_code, service_msg, firebase_msg = determine_status()

            with status_lock:
                current_status = {
                    'code': status_code,
                    'service': service_msg,
                    'firebase': firebase_msg
                }

            # Update tooltip and menu OUTSIDE the lock (generate_menu also uses lock)
            hostname = psutil.os.environ.get('COMPUTERNAME', 'Unknown')
            tooltip = f"owlette v{shared_utils.APP_VERSION}\nhostname: {hostname}\n{service_msg.lower()}\nstatus: {firebase_msg.lower()}"
            icon.title = tooltip
            icon.menu = generate_menu()  # Update menu object
            icon.update_menu()  # Signal OS to refresh the menu display

            with status_lock:
                # Track how long we've been in a degraded state (debounce)
                global _degraded_since, _degraded_notified
                if status_code != 'normal':
                    if _degraded_since is None:
                        _degraded_since = time.time()
                        _degraded_notified = False
                else:
                    # Recovered — send recovery notification if we previously notified about degradation
                    if _degraded_notified and last_status.get('code') != 'unknown' and time.time() - started_at > grace_period:
                        send_status_notification(icon, status_code, service_msg, firebase_msg)
                    _degraded_since = None
                    _degraded_notified = False

                # Check if icon color should change
                if last_status.get('code') != status_code:
                    # Error: flash blood red. Warning: dim solid. Normal: solid coral.
                    if status_code == 'error':
                        _stop_flash()
                        time.sleep(0.1)
                        _start_flash(icon, 'error')
                    else:
                        _stop_flash()
                        time.sleep(0.1)
                        if status_code == 'warning':
                            icon.icon = load_icon('disconnected')
                        else:
                            icon.icon = load_icon('normal')
                    logging.info(f"[TRAY] Icon updated: {last_status.get('code')} -> {status_code} ({firebase_msg})")

                # Send degraded notification only after debounce threshold (once per degraded period)
                # This prevents spam from brief 1-second blips during status file rewrites
                if (status_code != 'normal'
                        and not _degraded_notified
                        and _degraded_since is not None
                        and time.time() - _degraded_since >= _NOTIFY_DELAY
                        and last_status.get('code') != 'unknown'
                        and time.time() - started_at > grace_period):
                    _degraded_notified = True
                    send_status_notification(icon, status_code, service_msg, firebase_msg)

                # Always update last status
                last_status = current_status.copy()

            time.sleep(1)

        except Exception as e:
            logging.error(f"Status monitoring error: {e}")
            time.sleep(60)

_HEALTH_ERROR_MESSAGES = {
    'config_error': (
        "owlette — config error",
        "config file missing or corrupted. please reinstall owlette."
    ),
    'auth_error': (
        "owlette — not registered",
        "no authentication token found. please run the installer again."
    ),
    'network_error': (
        "owlette — network unreachable",
        "network was not reachable at startup. check internet connection."
    ),
    'connection_failure': (
        "owlette — connection failed",
        "persistent connection failures. check service logs."
    ),
    'fatal_error': (
        "owlette — fatal error",
        "a fatal connection error occurred. check service logs."
    ),
}


def send_status_notification(icon, status_code, service_msg, firebase_msg):
    """Send Windows notification when status changes."""
    try:
        if status_code == 'error':
            # Check if firebase_msg is a health error code
            health_notification = _HEALTH_ERROR_MESSAGES.get(firebase_msg)
            if health_notification:
                title, message = health_notification
                icon.notify(title=title, message=message)
            else:
                icon.notify(
                    title="owlette — service stopped",
                    message="the service may have crashed or failed to start.\nclick 'restart' to fix."
                )
        elif status_code == 'warning':
            icon.notify(
                title="owlette — reconnecting",
                message="cloud sync temporarily unavailable. local monitoring still active."
            )
        # Don't notify on normal status (too noisy)
    except Exception as e:
        logging.error(f"Failed to send notification: {e}")

def leave_site(icon, item):
    """Handle Leave Site action - kept for GUI use."""
    import ctypes

    # Get current site ID for display
    config = shared_utils.read_config()
    site_id = config.get('firebase', {}).get('site_id', 'this site')

    # Show confirmation dialog using Windows MessageBox
    MB_YESNO = 0x04
    MB_ICONWARNING = 0x30
    IDYES = 6

    message = (
        f"This will remove this machine from '{site_id}'.\n\n"
        "The following will happen:\n"
        "• Firebase sync will be disabled\n"
        "• Machine will be deregistered\n"
        "• Service will be restarted\n\n"
        "To re-join a site, you will need to run the Owlette installer again.\n\n"
        "Are you sure you want to leave this site?"
    )

    result = ctypes.windll.user32.MessageBoxW(
        0,
        message,
        "owlette — leave site?",
        MB_YESNO | MB_ICONWARNING
    )

    if result == IDYES:
        try:
            # Show notification immediately
            icon.notify(
                title="owlette — leaving site",
                message="stopping service and marking machine offline..."
            )

            # CRITICAL: Restart service FIRST while Firebase is still enabled
            # This allows the service to mark itself offline during shutdown
            try:
                import win32serviceutil
                service_name = 'OwletteService'

                # Stop service (Firebase is still enabled, so it will mark offline)
                logging.info("Stopping service to mark machine offline...")
                win32serviceutil.StopService(service_name)
                logging.info("Service stopped - machine should now be offline")
                time.sleep(2)

                # Now that service is stopped and marked offline, disable Firebase in config
                if 'firebase' not in config:
                    config['firebase'] = {}

                config['firebase']['enabled'] = False
                config['firebase']['site_id'] = ''

                # Save config
                shared_utils.save_config(config)
                logging.info("Left site successfully - Firebase disabled and site_id cleared")

                # Start service with Firebase disabled
                win32serviceutil.StartService(service_name)

                logging.info("Service restarted successfully after leaving site")
                icon.notify(
                    title="owlette — service restarted",
                    message="service is running normally."
                )
            except Exception as restart_error:
                logging.error(f"Error restarting service: {restart_error}")
                ctypes.windll.user32.MessageBoxW(
                    0,
                    f"Failed to restart service:\n{str(restart_error)}\n\nPlease restart manually.",
                    "restart failed",
                    0x10  # MB_ICONERROR
                )

        except Exception as e:
            logging.error(f"Error leaving site: {e}")
            ctypes.windll.user32.MessageBoxW(
                0,
                f"Failed to leave site:\n{str(e)}",
                "Error",
                0x10  # MB_ICONERROR
            )

# Dynamically generate the menu with status info
def generate_menu():
    hostname = psutil.os.environ.get('COMPUTERNAME', 'Unknown')

    # Get current status for menu display
    with status_lock:
        service_status = current_status.get('service', 'Checking...')
        firebase_status = current_status.get('firebase', 'Checking...')

    # Check for health error message to surface in menu
    health_error_item = None
    try:
        status_data = read_service_status()
        if status_data:
            health = status_data.get('health', {})
            health_status = health.get('status')
            if health_status and health_status not in ('ok', 'unknown'):
                error_msg = health.get('error_message') or health.get('error_code', 'Unknown error')
                # Truncate if too long for a menu item
                if len(error_msg) > 60:
                    error_msg = error_msg[:57] + '...'
                health_error_item = item(f'  {error_msg}', lambda icon, i: None, enabled=False)
    except Exception:
        pass

    menu_items = [
        item(f'owlette v{shared_utils.APP_VERSION}', lambda icon, item: None, enabled=False),
        item(f'hostname: {hostname}', lambda icon, item: None, enabled=False),
        item(f'{service_status.lower()}', lambda icon, item: None, enabled=False),
        item(f'status: {firebase_status.lower()}', lambda icon, item: None, enabled=False),
    ]

    if health_error_item:
        menu_items.append(health_error_item)

    menu_items += [
        pystray.Menu.SEPARATOR,
        item('open owlette', open_config_gui),
        item('start on login', on_select, checked=lambda text: start_on_login),
        item('restart', restart_service),
        item('exit', exit_action),
    ]

    return pystray.Menu(*menu_items)

_PID_FILE = shared_utils.get_data_path('tmp/tray.pid')


def _acquire_pid_lock():
    """Try to claim the tray singleton via a PID file.
    Returns True if we are the only instance, False if another is alive."""
    try:
        if os.path.exists(_PID_FILE):
            with open(_PID_FILE, 'r') as f:
                old_pid = int(f.read().strip())
            # Check if that PID is still a tray process
            try:
                proc = psutil.Process(old_pid)
                name = (proc.name() or '').lower()
                if 'python' in name and proc.is_running():
                    return False  # another tray is alive
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass  # stale PID — we can take over

        # Write our PID
        os.makedirs(os.path.dirname(_PID_FILE), exist_ok=True)
        with open(_PID_FILE, 'w') as f:
            f.write(str(os.getpid()))
        return True
    except Exception as e:
        logging.warning(f"[TRAY] PID lock error: {e}")
        return True  # proceed anyway on error

def _wait_for_explorer(timeout=120):
    """
    Wait until explorer.exe is running (shell notification area is available).
    At boot, the service may launch us before the user's desktop is ready.
    Returns True if Explorer is found, False if timeout expired.

    Uses FindWindowW instead of psutil — it's instantaneous because it
    queries the Window Manager directly rather than iterating all processes.
    """
    deadline = time.time() + timeout
    check_interval = 2  # seconds between checks
    while time.time() < deadline:
        # Shell_TrayWnd is the class name of the Windows taskbar/notification area.
        # If it exists, Explorer is running and the tray is ready.
        if ctypes.windll.user32.FindWindowW("Shell_TrayWnd", None):
            return True
        logging.debug(f"[TRAY] Waiting for Shell_TrayWnd ({int(deadline - time.time())}s remaining)...")
        time.sleep(check_interval)
    return False


def _run_tray(is_restarted=False):
    """
    Create and run the tray icon.  Separated from __main__ so we can
    retry on failure without re-importing everything.
    """
    # Sync Start on Login state from registry before building the first menu
    global start_on_login
    start_on_login = check_service_status()

    # Do initial status check
    status_code, service_msg, firebase_msg = determine_status()

    with status_lock:
        current_status_local = {
            'code': status_code,
            'service': service_msg,
            'firebase': firebase_msg
        }
        # Update globals
        global current_status, last_status
        current_status = current_status_local
        last_status = current_status_local.copy()

    # Create the system tray icon with initial status
    hostname = os.environ.get('COMPUTERNAME', 'Unknown')
    tooltip = f"owlette v{shared_utils.APP_VERSION}\nhostname: {hostname}\n{service_msg.lower()}\nstatus: {firebase_msg.lower()}"
    image = load_icon(status_code)

    icon = pystray.Icon(
        "owlette_icon",
        image,
        tooltip,
        menu=generate_menu()  # Initial menu - will be updated by monitor_status
    )

    # Start status monitoring thread
    monitor_thread = threading.Thread(target=monitor_status, args=(icon,), daemon=True)
    monitor_thread.start()

    # Show "back online" notification if this was a restart
    if is_restarted:
        def show_restart_notification():
            time.sleep(1)
            try:
                icon.notify(
                    title="owlette — back online",
                    message="service running normally."
                )
                logging.info("Restart complete - 'back online' notification shown")
            except Exception as e:
                logging.debug(f"Could not show restart notification: {e}")

        notification_thread = threading.Thread(target=show_restart_notification, daemon=True)
        notification_thread.start()

    # Run the icon (blocking call)
    icon.run()
    logging.info('Exiting Tray icon...')

    # Clean up PID file on normal exit
    try:
        if os.path.exists(_PID_FILE):
            os.remove(_PID_FILE)
    except Exception:
        pass


def _flush_logs():
    """Force-flush all log handlers so messages appear in the log file immediately.
    Necessary because pythonw.exe uses full buffering (no terminal)."""
    for handler in logging.getLogger().handlers:
        try:
            handler.flush()
        except Exception:
            pass


if __name__ == "__main__":
    # Initialize logging FIRST so any crash is captured
    log_level = shared_utils.get_log_level_from_config()
    shared_utils.initialize_logging("tray", level=log_level)

    try:
        # Check if this is a restart (--restarted flag passed)
        is_restarted = '--restarted' in sys.argv

        if not _acquire_pid_lock():
            logging.info('Tray icon is already running (PID lock)...')
            _flush_logs()
            sys.exit(0)

        logging.info("[TRAY] Waiting for Explorer shell...")
        _flush_logs()

        # Wait for Explorer (shell notification area) before attempting to show icon.
        # At boot, the service launches us before the desktop is ready, which causes
        # pystray to fail silently.  This avoids the crash-relaunch loop.
        if not _wait_for_explorer(timeout=120):
            logging.error("[TRAY] Explorer not found after 120s — exiting (service will retry later)")
            _flush_logs()
            sys.exit(1)

        # Small grace period after Explorer starts — the notification area needs a
        # moment to initialise even after explorer.exe appears in the process list.
        logging.info("[TRAY] Explorer found, waiting 2s for notification area...")
        _flush_logs()
        time.sleep(2)

        # Retry with backoff — pystray can still fail if the shell notification area
        # is not fully initialised (common during Windows boot).
        max_retries = 5
        for attempt in range(1, max_retries + 1):
            try:
                logging.info(f"[TRAY] Attempting to show icon (attempt {attempt}/{max_retries})")
                _flush_logs()
                _run_tray(is_restarted=is_restarted)
                break  # icon.run() returned normally (user clicked Exit)
            except Exception as e:
                logging.error(f"[TRAY] Icon failed on attempt {attempt}/{max_retries}: {e}", exc_info=True)
                _flush_logs()
                if attempt < max_retries:
                    wait = min(5 * attempt, 20)  # 5s, 10s, 15s, 20s
                    logging.info(f"[TRAY] Retrying in {wait}s...")
                    _flush_logs()
                    time.sleep(wait)
                else:
                    logging.error("[TRAY] All retry attempts exhausted — exiting")
                    _flush_logs()
                    sys.exit(1)

    except SystemExit:
        raise  # Let sys.exit() through
    except Exception as e:
        logging.critical(f"[TRAY] FATAL unhandled error: {e}", exc_info=True)
        _flush_logs()
        sys.exit(1)