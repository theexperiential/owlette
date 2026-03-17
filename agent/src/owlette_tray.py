import shared_utils
import pystray
from pystray import MenuItem as item
from PIL import Image
import subprocess
import logging
import os
import psutil
import ctypes
import sys
import winreg
import win32gui
import win32con
import threading
import time
import json
import win32serviceutil
import win32service

pid = None
start_on_login = True
current_status = {'service': 'unknown', 'firebase': 'unknown'}
last_status = {'service': 'unknown', 'firebase': 'unknown'}
status_lock = threading.Lock()

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
def read_service_status():
    """
    Read service status from status file written by service.

    The service writes C:\\ProgramData\\Owlette\\tmp\\service_status.json
    every 10 seconds with current Firebase connection state.

    Returns dict or None if file doesn't exist/can't be read.
    """
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
            return status_data

    except NameError as e:
        logging.error(f"[STATUS] NameError (json module not imported?): {e}")
        return None
    except json.JSONDecodeError as e:
        logging.error(f"[STATUS] JSON decode error: {e}")
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
    if not is_process_running(pid):
        try:
            process = subprocess.Popen(
                ["pythonw", shared_utils.get_path('owlette_gui.py')],
                creationflags=subprocess.CREATE_NO_WINDOW
            )
            pid = process.pid
        except Exception as e:
            logging.error(f"Failed to open Owlette Configuration: {e}")
    else:
        try:
            # Assuming the window title contains "Owlette"
            hwnd = win32gui.FindWindow(None, shared_utils.WINDOW_TITLES.get("owlette_gui"))
            if hwnd:
                # Restore window if minimized.
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                # Bring window to front.
                win32gui.SetForegroundWindow(hwnd)
        except Exception as e:
            logging.error(f"Failed to bring Owlette Configuration to the front: {e}")

# Function to restart the service (using UAC elevation)
def restart_service(icon, item):
    """
    Restart the Owlette service and tray icon.
    """
    try:
        logging.info("Starting service restart procedure...")

        # CRITICAL: Write restart flag for service to detect
        # Service will log agent_stopped when it sees this flag
        try:
            restart_flag = shared_utils.get_data_path('tmp/restart.flag')
            os.makedirs(os.path.dirname(restart_flag), exist_ok=True)
            with open(restart_flag, 'w') as f:
                f.write('restart_requested')
            logging.info("Restart flag written - waiting for service to log agent_stopped...")

            # Wait 2 seconds for service to detect flag and log agent_stopped
            time.sleep(2)
            logging.info("Proceeding with restart commands...")
        except Exception as flag_error:
            logging.error(f"Failed to write restart flag: {flag_error}")
            # Continue with restart anyway

        # Show notification immediately for user feedback
        try:
            icon.notify(
                title="🔄 Restarting Owlette",
                message="Restarting service - will return momentarily"
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

        # Build the restart command (runs with admin privileges via UAC)
        # This batch script will:
        # 1. Stop the service
        # 2. Wait 3 seconds
        # 3. Start the service
        # 4. Wait 2 seconds
        # 5. Restart the tray icon
        tray_path = shared_utils.get_path('owlette_tray.py')

        # Get pythonw.exe path from installation directory
        # Assumes structure: C:\Owlette\python\pythonw.exe
        python_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        pythonw_path = os.path.join(python_dir, 'python', 'pythonw.exe')

        restart_cmd = (
            f'net stop OwletteService && '
            f'timeout /t 3 /nobreak >nul && '
            f'net start OwletteService && '
            f'timeout /t 2 /nobreak >nul && '
            f'start "" "{pythonw_path}" "{tray_path}" --restarted'
        )

        logging.info(f"Launching elevated restart command: {restart_cmd}")

        # Use ShellExecuteW with "runas" to trigger UAC prompt
        # SW_HIDE (0) hides the command window
        result = ctypes.windll.shell32.ShellExecuteW(
            None,           # parent window
            "runas",        # operation (triggers UAC)
            "cmd.exe",      # executable
            f'/c {restart_cmd}',  # parameters
            None,           # working directory
            0               # show command (0 = hidden)
        )

        # Result > 32 means success, <= 32 means error
        if result > 32:
            logging.info("Elevated restart command launched successfully")
        else:
            logging.error(f"Failed to launch elevated command, result code: {result}")
            icon.notify(
                title="⚠️ Restart Cancelled",
                message="UAC was cancelled or failed. Service not restarted."
            )
            return

        # Stop the icon immediately (the elevated command will restart it)
        time.sleep(0.5)
        icon.stop()
        logging.info("Tray icon stopped, elevated restart command running")

    except Exception as e:
        logging.error(f"Failed to initiate service restart: {e}")
        try:
            icon.notify(
                title="⚠️ Restart Failed",
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
            ctypes.windll.shell32.ShellExecuteW(None, "runas", "cmd.exe", f"/k sc config OwletteService start= {start_type}", None, 0)
        else:
            subprocess.run(
                'sc config OwletteService start= disabled',
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
    logging.info("[MONITOR] Waiting for icon to become visible...")
    for i in range(100):  # Wait up to 10 seconds
        if icon.visible:
            break
        time.sleep(0.1)

    if not icon.visible:
        logging.error("[MONITOR] Icon never became visible after 10s, exiting monitor thread")
        return

    logging.info("[MONITOR] Icon is visible, starting status monitoring loop")

    # Grace period to avoid false alarms during restarts (seconds)
    grace_period = 5
    last_check_time = 0

    while icon.visible:
        try:
            current_time = time.time()

            # Check status every 15 seconds (more responsive than 60s)
            if current_time - last_check_time >= 15:
                status_code, service_msg, firebase_msg = determine_status()

                with status_lock:
                    current_status = {
                        'code': status_code,
                        'service': service_msg,
                        'firebase': firebase_msg
                    }

                # Update tooltip and menu OUTSIDE the lock (generate_menu also uses lock)
                hostname = psutil.os.environ.get('COMPUTERNAME', 'Unknown')
                tooltip = f"Owlette v{shared_utils.APP_VERSION}\nHostname: {hostname}\n{service_msg}\nStatus: {firebase_msg}"
                icon.title = tooltip
                icon.menu = generate_menu()  # Update menu object
                icon.update_menu()  # Signal OS to refresh the menu display

                with status_lock:
                    # Check if icon color should change
                    if last_status.get('code') != status_code:
                        # Update icon
                        icon.icon = load_icon(status_code)
                        logging.info(f"[TRAY] Icon updated: {last_status.get('code')} -> {status_code} ({firebase_msg})")

                        # Send notification on state change (but not on first check)
                        if last_status.get('code') != 'unknown' and current_time - last_check_time > grace_period:
                            send_status_notification(icon, status_code, service_msg, firebase_msg)
                    else:
                        # Log status even if unchanged (for debugging)
                        logging.debug(f"[TRAY] Status check: {status_code} ({firebase_msg})")

                    # Always update last status
                    last_status = current_status.copy()

                last_check_time = current_time

            # Sleep for 5 seconds before checking again
            time.sleep(5)

        except Exception as e:
            logging.error(f"Status monitoring error: {e}")
            time.sleep(60)

_HEALTH_ERROR_MESSAGES = {
    'config_error': (
        "⚠️ Owlette Config Error",
        "Config file missing or corrupted. Please reinstall Owlette."
    ),
    'auth_error': (
        "⚠️ Owlette Not Registered",
        "No authentication token found. Please run the Owlette installer again."
    ),
    'network_error': (
        "⚠️ Network Unreachable",
        "Network was not reachable at startup. Check internet connection."
    ),
    'connection_failure': (
        "⚠️ Owlette Connection Failed",
        "Persistent Firestore connection failures. Check service logs."
    ),
    'fatal_error': (
        "⚠️ Owlette Fatal Error",
        "A fatal connection error occurred. Check service logs."
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
                    title="⚠️ Owlette Service Stopped",
                    message=f"{service_msg}\nThe service may have crashed or failed to start.\nClick 'Restart' to fix."
                )
        elif status_code == 'warning':
            icon.notify(
                title="⚠️ Firebase Connection Issue",
                message=f"{firebase_msg}\nLocal monitoring still works, but cloud sync is unavailable."
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
        "Leave Site?",
        MB_YESNO | MB_ICONWARNING
    )

    if result == IDYES:
        try:
            # Show notification immediately
            icon.notify(
                title="🔄 Leaving Site...",
                message="Stopping service and marking machine offline..."
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
                    title="✓ Service Restarted",
                    message="The Owlette service has been restarted successfully."
                )
            except Exception as restart_error:
                logging.error(f"Error restarting service: {restart_error}")
                ctypes.windll.user32.MessageBoxW(
                    0,
                    f"Failed to restart service:\n{str(restart_error)}\n\nPlease restart manually.",
                    "Restart Failed",
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
        item(f'Owlette v{shared_utils.APP_VERSION}', lambda icon, item: None, enabled=False),
        item(f'Hostname: {hostname}', lambda icon, item: None, enabled=False),
        item(f'{service_status}', lambda icon, item: None, enabled=False),
        item(f'Status: {firebase_status}', lambda icon, item: None, enabled=False),
    ]

    if health_error_item:
        menu_items.append(health_error_item)

    menu_items += [
        pystray.Menu.SEPARATOR,
        item('Open Config', open_config_gui),
        item('Start on Login', on_select, checked=lambda text: start_on_login),
        item('Restart', restart_service),
        item('Exit', exit_action),
    ]

    return pystray.Menu(*menu_items)

def is_script_running(script_name):
    count = 0
    for process in psutil.process_iter(attrs=['pid', 'name', 'cmdline']):
        if 'python' in process.info['name']:
            cmdline = process.info.get('cmdline')
            if cmdline:
                if script_name in ' '.join(cmdline):
                    count += 1
    return count > 1

if __name__ == "__main__":
    # Initialize logging with configurable log level
    log_level = shared_utils.get_log_level_from_config()
    shared_utils.initialize_logging("tray", level=log_level)

    # Check if this is a restart (--restarted flag passed)
    is_restarted = '--restarted' in sys.argv

    if not is_script_running('owlette_tray.py'):
        # Do initial status check
        status_code, service_msg, firebase_msg = determine_status()

        with status_lock:
            current_status = {
                'code': status_code,
                'service': service_msg,
                'firebase': firebase_msg
            }
            last_status = current_status.copy()

        # Create the system tray icon with initial status
        hostname = psutil.os.environ.get('COMPUTERNAME', 'Unknown')
        tooltip = f"Owlette v{shared_utils.APP_VERSION}\nHostname: {hostname}\n{service_msg}\nStatus: {firebase_msg}"
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
                # Wait a moment for icon to fully initialize
                time.sleep(1)
                try:
                    icon.notify(
                        title="✅ Back online!",
                        message="Owlette service running normally."
                    )
                    logging.info("Restart complete - 'back online' notification shown")
                except Exception as e:
                    logging.debug(f"Could not show restart notification: {e}")

            # Show notification in background thread
            notification_thread = threading.Thread(target=show_restart_notification, daemon=True)
            notification_thread.start()

        # Run the icon (blocking call)
        icon.run()

        logging.info('Exiting Tray icon...')

    else:
        logging.info('Tray icon is already running...')
        sys.exit(0)