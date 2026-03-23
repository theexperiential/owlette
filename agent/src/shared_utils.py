import os
import json
import logging
from logging.handlers import RotatingFileHandler
import ctypes
import socket
from packaging import version
import psutil
import GPUtil
import platform
import subprocess
import threading
import winreg
import time
from pathlib import Path

# VERSION MANAGEMENT
def get_app_version():
    """
    Read application version from VERSION file.
    This ensures a single source of truth for version management.

    Returns:
        str: Version string (e.g., "2.0.55") or "0.0.0" if VERSION file not found
    """
    try:
        # VERSION file is in agent/ directory (parent of src/)
        version_file = Path(__file__).parent.parent / 'VERSION'
        if version_file.exists():
            return version_file.read_text().strip()
        else:
            logging.warning("VERSION file not found — using fallback '0.0.0'")
            return '0.0.0'
    except Exception as e:
        logging.warning(f"Failed to read VERSION file: {e} — using fallback '0.0.0'")
        return '0.0.0'

# GLOBAL VARS

APP_VERSION = get_app_version()
CONFIG_VERSION = '1.6.0'  # Added launch_mode (scheduling)
# Color scheme matching web app dark theme (oklch hue 250 navy + cyan accent)
WINDOW_COLOR = '#020b16'      # web --background oklch(0.145 0.03 250)
FRAME_COLOR = '#0d1e2f'       # web --card oklch(0.23 0.04 250)
BUTTON_COLOR = '#11283e'      # web --muted oklch(0.269 0.05 250)
BUTTON_HOVER_COLOR = '#143c62' # web --accent/border oklch(0.35 0.08 250)
BUTTON_IMPORTANT_COLOR = '#00cfd1' # web --accent-cyan oklch(0.75 0.18 195)
BUTTON_IMPORTANT_HOVER = '#00e2e5' # web --accent-cyan-hover oklch(0.80 0.20 195)
BUTTON_IMPORTANT_TEXT = '#020b16'  # dark text on cyan buttons (matches background)
ACCENT_COLOR = '#00cfd1'      # web --accent-cyan oklch(0.75 0.18 195)
BORDER_COLOR = '#143c62'      # web --border oklch(0.35 0.08 250)
HIGHLIGHT_COLOR = '#006566'   # web --accent-cyan-muted oklch(0.45 0.10 195)
TEXT_COLOR = "white"
CORNER_RADIUS = 6             # consistent corner radius for all elements
STATUS_COLORS = {
    'RUNNING':       '#4ade80',  # green-400
    'LAUNCHING':     '#facc15',  # yellow-400
    'QUEUED':        '#fb923c',  # orange-400
    'LAUNCH_FAILED': '#ef4444',  # red-500
    'KILLED':        '#f87171',  # red-400
    'STOPPED':       '#f87171',  # red-400
    'INACTIVE':      '#94a3b8',  # slate-400
}
WINDOW_TITLES = {
    "owlette_gui": "owlette",
    "prompt_slack_config": "connect to slack",
    "prompt_restart": "process repeatedly failing!"
}
SERVICE_NAME = 'OwletteService'


# OS
# Initialize a global lock (thread-level)
json_lock = threading.Lock()

# Cross-process mutex for JSON file access (service + GUI coordination)
_json_file_mutex = None
def _get_json_file_mutex():
    """Get or create a Windows named mutex for cross-process JSON file locking."""
    global _json_file_mutex
    if _json_file_mutex is None:
        try:
            import win32event
            # Named mutex shared between service and GUI processes
            _json_file_mutex = win32event.CreateMutex(None, False, "Global\\OwletteJsonFileMutex")
        except Exception:
            _json_file_mutex = False  # Fallback: skip cross-process locking
    return _json_file_mutex

class _CrossProcessLock:
    """Context manager for cross-process file locking using a Windows named mutex."""
    def __init__(self, timeout_ms=2000):
        self.timeout_ms = timeout_ms
        self.mutex = _get_json_file_mutex()
        self.acquired = False

    def __enter__(self):
        if self.mutex:
            try:
                import win32event, win32con
                result = win32event.WaitForSingleObject(self.mutex, self.timeout_ms)
                self.acquired = result in (win32event.WAIT_OBJECT_0, win32event.WAIT_ABANDONED)
            except Exception:
                pass
        return self

    def __exit__(self, *args):
        if self.acquired and self.mutex:
            try:
                import win32event
                win32event.ReleaseMutex(self.mutex)
            except Exception:
                pass

# Return the hostname of the machine where the script is running
def get_hostname():
    return socket.gethostname()

def get_cpu_name():
    """
    Get CPU model name with multi-layered fallback for maximum reliability.

    Tries methods in order of speed and reliability:
    1. Windows Registry (fastest, most reliable)
    2. PowerShell Get-CimInstance (Windows 11 compatible, modern)
    3. platform.processor() (last resort, incomplete but always works)

    Returns:
        str: CPU model name (e.g., "Intel(R) Core(TM) i9-9900X CPU @ 3.50GHz")
             or "Unknown CPU" if all methods fail
    """
    # Method 1: Windows Registry (BEST - fast, reliable, no admin rights)
    try:
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r'HARDWARE\DESCRIPTION\System\CentralProcessor\0')
        cpu_name = winreg.QueryValueEx(key, 'ProcessorNameString')[0].strip()
        winreg.CloseKey(key)
        if cpu_name:
            return cpu_name
    except Exception as e:
        logging.debug(f"Registry CPU detection failed: {e}")

    # Method 2: PowerShell Get-CimInstance (GOOD - Windows 11 compatible)
    try:
        result = subprocess.run(
            ['powershell', '-NoProfile', '-Command',
             'Get-CimInstance -ClassName Win32_Processor | Select-Object -ExpandProperty Name'],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW  # No console flash
        )
        if result.returncode == 0 and result.stdout.strip():
            cpu_name = result.stdout.strip()
            if cpu_name:
                return cpu_name
    except Exception as e:
        logging.debug(f"PowerShell CPU detection failed: {e}")

    # Method 3: platform.processor() (LAST RESORT - incomplete but always works)
    try:
        cpu_name = platform.processor()
        if cpu_name:
            return cpu_name
    except Exception as e:
        logging.debug(f"platform.processor() failed: {e}")

    # All methods failed
    logging.warning("All CPU detection methods failed")
    return "Unknown CPU"

def get_cpu_temperature():
    """
    Get CPU temperature in Celsius using LibreHardwareMonitor (via WinTmp).

    Returns:
        float: CPU temperature in Celsius, or None if unavailable

    Notes:
        - Uses LibreHardwareMonitor driver via WinTmp wrapper
        - Requires administrator privileges (satisfied by Windows service)
        - Returns None on unsupported hardware without crashing
        - Non-critical feature - system continues normally if unavailable
    """
    try:
        import WinTmp

        cpu_temp = WinTmp.CPU_Temp()

        # Validate reasonable temperature range (0-150°C)
        if cpu_temp is not None and 0 < cpu_temp < 150:
            return float(cpu_temp)
        return None

    except ImportError:
        logging.debug("[TEMP] WinTmp not available")
        return None

    except Exception as e:
        logging.debug(f"[TEMP] WinTmp error: {e}")
        return None

def get_gpu_temperatures():
    """
    Get GPU temperatures in Celsius with fallback chain.

    Tries multiple methods:
    1. WinTmp (supports NVIDIA, AMD, Intel)
    2. pynvml (NVIDIA only - official NVML library)

    Returns:
        list: List of dicts with GPU index and temperature, or empty list if unavailable
              Example: [{'index': 0, 'temperature': 72.0}]

    Notes:
        - Always returns Celsius (storage standard)
        - Requires administrator privileges for WinTmp (satisfied by Windows service)
        - pynvml works with standard user permissions
        - Non-critical - returns empty list on failure without crashing
    """
    temps = []

    # Method 1: Try WinTmp (works for NVIDIA, AMD, Intel)
    try:
        import WinTmp
        all_temps = WinTmp.GPU_Temps()

        if all_temps:
            for i, temp in enumerate(all_temps):
                if temp is not None and 0 < temp < 150:
                    temps.append({
                        'index': i,
                        'temperature': float(temp)
                    })
            if temps:
                return temps

    except ImportError:
        pass
    except Exception:
        pass

    # Method 2: Fallback to pynvml for NVIDIA GPUs
    try:
        from pynvml import nvmlInit, nvmlDeviceGetCount, nvmlDeviceGetHandleByIndex, nvmlDeviceGetTemperature, nvmlShutdown, NVML_TEMPERATURE_GPU, NVMLError

        nvmlInit()
        gpu_count = nvmlDeviceGetCount()

        for i in range(gpu_count):
            try:
                handle = nvmlDeviceGetHandleByIndex(i)
                temp = nvmlDeviceGetTemperature(handle, NVML_TEMPERATURE_GPU)

                # Validate reasonable temperature range (0-150°C)
                if temp is not None and 0 < temp < 150:
                    temps.append({
                        'index': i,
                        'temperature': float(temp)
                    })
            except Exception as e:
                logging.warning(f"[TEMP] pynvml failed for GPU {i}: {e}")

        nvmlShutdown()

        if temps:
            return temps

    except ImportError as e:
        logging.warning(f"[TEMP] pynvml not installed - GPU temperature unavailable: {e}")
    except Exception as e:
        logging.warning(f"[TEMP] pynvml GPU temp failed: {e}")

    # All methods failed
    return []

def get_path(filename=None):
    """
    Get path relative to the currently executing script (installation directory).
    Use this for accessing icons, scripts, and executables.

    For application data (config, logs, cache), use get_data_path() instead.
    """
    # Get the directory of the currently executing script
    path = os.path.dirname(os.path.realpath(__file__))

    # Build the full path to the file name
    if filename is not None:
        path = os.path.join(path, filename)

    # Normalize the path
    path = os.path.normpath(path)

    return path

def get_python_exe_path():
    """
    Get path to the bundled Python interpreter executable.
    Returns pythonw.exe (GUI, no console) if available, otherwise python.exe.

    Returns:
        str: Full path to pythonw.exe or python.exe

    Raises:
        FileNotFoundError: If neither pythonw.exe nor python.exe can be found
    """
    # Get installation root (C:\ProgramData\Owlette or wherever installed)
    # src is at <install>\agent\src, so go up 2 levels to get <install>
    install_root = os.path.dirname(os.path.dirname(get_path()))

    # Try pythonw.exe first (for GUI scripts, no console window)
    pythonw_path = os.path.join(install_root, 'python', 'pythonw.exe')
    if os.path.exists(pythonw_path):
        return pythonw_path

    # Fall back to python.exe
    python_path = os.path.join(install_root, 'python', 'python.exe')
    if os.path.exists(python_path):
        return python_path

    # If neither found, raise error
    raise FileNotFoundError(
        f"Python interpreter not found. Searched in: {os.path.join(install_root, 'python')}"
    )

def get_data_path(filename=None):
    """
    Get path in ProgramData for Owlette application data.
    This is the proper location for Windows services to store runtime data.

    Args:
        filename: Optional relative path within ProgramData\Owlette\

    Returns:
        Absolute path to ProgramData\Owlette\ or specified file within it

    Examples:
        get_data_path() -> C:\ProgramData\Owlette
        get_data_path('config/config.json') -> C:\ProgramData\Owlette\config\config.json
    """
    # Get ProgramData directory (typically C:\ProgramData)
    program_data = os.environ.get('PROGRAMDATA', 'C:\\ProgramData')

    # Build Owlette data directory
    owlette_data = os.path.join(program_data, 'Owlette')

    # Build full path if filename provided
    if filename is not None:
        path = os.path.join(owlette_data, filename)
    else:
        path = owlette_data

    # Normalize the path
    path = os.path.normpath(path)

    return path

def ensure_data_directories():
    """
    Ensure all required ProgramData directories exist.
    Creates directories if they don't exist.

    Returns:
        bool: True if all directories exist or were created successfully
    """
    directories = [
        get_data_path(),
        get_data_path('config'),
        get_data_path('logs'),
        get_data_path('cache'),
        get_data_path('tmp'),
        get_data_path('ipc/cortex_commands'),
        get_data_path('ipc/cortex_results'),
        get_data_path('ipc/cortex_events'),
    ]

    try:
        for directory in directories:
            os.makedirs(directory, exist_ok=True)
        return True
    except Exception as e:
        logging.error(f"Failed to create data directories: {e}")
        return False

def get_environment():
    """
    Get the current environment setting from config.

    Returns:
        str: 'production' or 'development' (defaults to 'production')
    """
    try:
        config = read_config()
        if config:
            return config.get('environment', 'production')
    except:
        pass
    return 'production'

def get_api_base_url(environment=None):
    """
    Get API base URL based on environment.

    Args:
        environment: Optional environment override ('production' or 'development')
                    If None, reads from config

    Returns:
        str: API base URL (e.g., 'https://owlette.app/api')
    """
    if environment is None:
        environment = get_environment()

    if environment == 'development':
        return 'https://dev.owlette.app/api'
    else:
        return 'https://owlette.app/api'

def get_setup_url(environment=None):
    """
    Get setup URL based on environment.

    Args:
        environment: Optional environment override ('production' or 'development')
                    If None, reads from config

    Returns:
        str: Setup URL (e.g., 'https://owlette.app/setup')
    """
    if environment is None:
        environment = get_environment()

    if environment == 'development':
        return 'https://dev.owlette.app/setup'
    else:
        return 'https://owlette.app/setup'

def get_project_id(environment=None):
    """
    Get Firebase project ID based on environment.

    Args:
        environment: Optional environment override ('production' or 'development')
                    If None, reads from config

    Returns:
        str: Firebase project ID
    """
    if environment is None:
        environment = get_environment()

    if environment == 'development':
        return 'owlette-dev-3838a'
    else:
        return 'owlette-prod-90a12'

def is_script_running(script_name):
    for process in psutil.process_iter(attrs=['pid', 'name', 'cmdline']):
        try:
            name = process.info.get('name') or ''
            if 'python' in name:
                cmdline = process.info.get('cmdline')
                if cmdline and script_name in ' '.join(cmdline):
                    return True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return False

# PATHS - Now using ProgramData for proper Windows service data storage
CONFIG_PATH = get_data_path('config/config.json')
RESULT_FILE_PATH = get_data_path('tmp/app_states.json')

# Cortex (local AI agent) paths
CORTEX_PID_PATH = get_data_path('tmp/cortex.pid')
CORTEX_IPC_CMD_DIR = get_data_path('ipc/cortex_commands')
CORTEX_IPC_RESULT_DIR = get_data_path('ipc/cortex_results')
CORTEX_IPC_EVENTS_DIR = get_data_path('ipc/cortex_events')


def is_cortex_enabled(config=None):
    """Check if Cortex is enabled in config.

    Args:
        config: Optional config dict. If None, reads from disk.

    Returns:
        True if cortex.enabled is truthy.
    """
    if config is None:
        config = read_config()
    return bool(config.get('cortex', {}).get('enabled', False))

# LOGGING
# Get log level from config
def get_log_level_from_config():
    """
    Read log level from config.json and convert to logging constant.
    Defaults to INFO if not found or invalid.

    Returns:
        logging level constant (e.g., logging.INFO, logging.WARNING)
    """
    try:
        level_str = read_config(['logging', 'level'])
        if not level_str:
            return logging.INFO

        # Map string to logging constant
        level_map = {
            'DEBUG': logging.DEBUG,
            'INFO': logging.INFO,
            'WARNING': logging.WARNING,
            'ERROR': logging.ERROR,
            'CRITICAL': logging.CRITICAL
        }

        return level_map.get(level_str.upper(), logging.INFO)
    except Exception as e:
        # If config read fails, default to INFO
        return logging.INFO

# Clean up old log files
def cleanup_old_logs(max_age_days=90):
    """
    Delete log files older than max_age_days.
    Helps prevent unbounded log growth on long-running agents.

    Args:
        max_age_days: Maximum age in days for log files (default: 90 days)

    Returns:
        Number of files deleted
    """
    try:
        import time
        log_dir = get_data_path('logs')

        if not os.path.exists(log_dir):
            return 0

        cutoff_time = time.time() - (max_age_days * 24 * 60 * 60)
        deleted_count = 0
        total_size_freed = 0

        for filename in os.listdir(log_dir):
            file_path = os.path.join(log_dir, filename)

            # Only process files (not directories)
            if not os.path.isfile(file_path):
                continue

            # Only process log files
            if not (filename.endswith('.log') or '.log.' in filename):
                continue

            # Check file age
            file_mtime = os.path.getmtime(file_path)
            if file_mtime < cutoff_time:
                try:
                    file_size = os.path.getsize(file_path)
                    os.remove(file_path)
                    deleted_count += 1
                    total_size_freed += file_size
                    logging.debug(f"Deleted old log file: {filename} ({round(file_size / 1024 / 1024, 2)} MB)")
                except Exception as e:
                    logging.warning(f"Could not delete old log file {filename}: {e}")

        if deleted_count > 0:
            mb_freed = round(total_size_freed / 1024 / 1024, 2)
            logging.info(f"[OK] Log cleanup complete: {deleted_count} file(s) deleted, {mb_freed} MB freed")

        return deleted_count

    except Exception as e:
        logging.error(f"Error during log cleanup: {e}")
        return 0

# Initialize logging with a rotating file handler
def initialize_logging(log_file_name, level=logging.INFO):
    # Ensure data directories exist before logging
    ensure_data_directories()

    log_file_path = get_data_path(f'logs/{log_file_name}.log')

    # DON'T clear the log file - let RotatingFileHandler manage it
    # This preserves historical logs for debugging crashes and issues
    # Old code (removed):
    # with open(log_file_path, 'w'):
    #     pass

    # Create a formatter for the log messages
    log_formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')

    # Create a handler that writes log messages to a file, with a maximum
    # log file size of 10 MB, keeping 5 old log files.
    # Mode 'a' appends to existing file instead of overwriting
    # Total retention: 60 MB (current + 5 backups of 10 MB each)
    log_handler = RotatingFileHandler(log_file_path, mode='a', maxBytes=10*1024*1024, backupCount=5, encoding=None, delay=0)

    # Set the formatter for the handler
    log_handler.setFormatter(log_formatter)

    # Create the logger and set its level
    logger = logging.getLogger()
    logger.setLevel(level)

    # Add the handler to the logger
    logger.addHandler(log_handler)

    # Log an initial message with clear separator for new service start
    logging.info("="*60)
    logging.info(f"Starting {log_file_name}...")
    logging.info(f"Log level: {logging.getLevelName(level)}")
    logging.info("="*60)

# Firebase log handler for centralized logging
class FirebaseLogHandler(logging.Handler):
    """
    Custom logging handler that ships logs to Firebase Firestore.
    Useful for centralized monitoring of multiple agents.
    """
    def __init__(self, firebase_client, errors_only=True):
        """
        Args:
            firebase_client: FirebaseClient instance
            errors_only: If True, only ship ERROR and CRITICAL logs (default: True)
        """
        super().__init__()
        self.firebase_client = firebase_client
        self.errors_only = errors_only
        self.buffer = []
        self.max_buffer_size = 50  # Ship in batches of 50 logs

    def emit(self, record):
        """
        Emit a log record to Firebase.
        """
        try:
            # If errors_only mode, skip non-error logs
            if self.errors_only and record.levelno < logging.ERROR:
                return

            # Format the log entry
            log_entry = {
                'timestamp': record.created,
                'level': record.levelname,
                'message': self.format(record),
                'logger': record.name,
                'filename': record.filename,
                'line': record.lineno
            }

            # Add to buffer
            self.buffer.append(log_entry)

            # Ship immediately for critical errors, otherwise batch
            if record.levelno >= logging.CRITICAL or len(self.buffer) >= self.max_buffer_size:
                self.flush()

        except Exception:
            # Don't let logging errors crash the app
            self.handleError(record)

    def flush(self):
        """
        Ship buffered logs to Firebase.
        """
        if not self.buffer or not self.firebase_client:
            return

        try:
            # Ship logs to Firebase (non-blocking)
            self.firebase_client.ship_logs(self.buffer.copy())
            self.buffer.clear()
        except Exception:
            # Silently fail - don't crash the app due to logging issues
            pass

def add_firebase_log_handler(firebase_client):
    """
    Add Firebase log shipping to the root logger if enabled in config.

    Args:
        firebase_client: FirebaseClient instance
    """
    try:
        # Check if Firebase log shipping is enabled
        shipping_config = read_config(['logging', 'firebase_shipping'])
        if not shipping_config or not shipping_config.get('enabled', False):
            return

        errors_only = shipping_config.get('ship_errors_only', True)

        # Create and add the Firebase handler
        firebase_handler = FirebaseLogHandler(firebase_client, errors_only=errors_only)
        firebase_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))

        logger = logging.getLogger()
        logger.addHandler(firebase_handler)

        logging.info(f"[OK] Firebase log shipping enabled (errors_only: {errors_only})")

    except Exception as e:
        logging.warning(f"Could not enable Firebase log shipping: {e}")

# CONFIG JSON

# Reads a JSON configuration file from a given path and optionally updates 
# an emails_to_entry list with email addresses from the configuration.
def load_config(emails_to_entry=None):
    try:
        config = read_json_from_file(CONFIG_PATH)
        if emails_to_entry is not None:
            emails_to_entry.insert(0, ', '.join(config['gmail']['to']))
        return config
        
    except FileNotFoundError as e:
        logging.error(f"Failed to load config: {e}")
        return generate_config_file()

# Writes a given configuration to a JSON file at a specified path. 
# If emails_to_entry is provided, the function updates the email addresses 
# in the configuration before saving.
def save_config(config=None, emails_to_entry=None):
    if config is None:
        config = read_json_from_file(CONFIG_PATH)

    if emails_to_entry is not None:
        config['gmail']['to'] = [email.strip() for email in emails_to_entry.get().split(',')]

    # Strip runtime-only fields before persisting — these belong in app_states.json, not config
    for process in config.get('processes', []):
        process.pop('status', None)

    write_json_to_file(config, CONFIG_PATH)
  
# Maintain compatibility from JSON config versions < 1.1.0
def upgrade_config():
    # Directly read the original config file
    config = read_json_from_file(CONFIG_PATH)
    if config:
        # Check if 'version' key exists and its value
        current_version = config.get('version', '0.0.0')

        # If version is less than 1.1.0, apply changes
        if version.parse(current_version) < version.parse(CONFIG_VERSION):
            # Add or update the 'version' key to latest
            config['version'] = CONFIG_VERSION

            # Update other keys as needed
            if 'email' in config:
                config['gmail'] = config.pop('email')
                config['gmail']['enabled'] = True

            # Update autostart to autolaunch
            for process in config['processes']:
                if 'autostart_process' in process:
                    process['autolaunch'] = process.pop('autostart_process')
                elif 'autolaunch_process' in process:
                    process['autolaunch'] = process.pop('autolaunch_process')

                # Ensure all necessary keys are in each process object
                for key in ['id', 'name', 'exe_path', 'file_path', 'cwd', 'time_delay', 'time_to_init', 'relaunch_attempts', 'autolaunch', 'visibility', 'priority']:
                    if key == 'visibility':
                        process.setdefault(key, 'Show')
                    elif key == 'priority':
                        process.setdefault(key, 'Normal')
                    elif key == 'cwd':
                        process.setdefault(key, None)
                    else:
                        process.setdefault(key, '')

            # Add logging configuration if missing (v1.4.0+)
            if 'logging' not in config:
                config['logging'] = {
                    "level": "INFO",
                    "max_age_days": 90,
                    "firebase_shipping": {
                        "enabled": False,
                        "ship_errors_only": True
                    }
                }
                logging.info("Added logging configuration to config.json (v1.4.0)")

            # Add environment configuration if missing (v1.5.0+)
            # Detect current environment from existing api_base if set
            if 'environment' not in config:
                # Auto-detect from existing firebase config
                existing_api_base = config.get('firebase', {}).get('api_base', '')
                if 'dev.owlette.app' in existing_api_base:
                    config['environment'] = 'development'
                else:
                    config['environment'] = 'production'
                logging.info(f"Added environment configuration to config.json (v1.5.0): {config['environment']}")

            # Migrate autolaunch → launch_mode (v1.6.0+)
            for process in config.get('processes', []):
                if 'launch_mode' not in process:
                    if process.get('autolaunch', False):
                        process['launch_mode'] = 'always'
                    else:
                        process['launch_mode'] = 'off'
                    logging.info(f"Migrated process '{process.get('name', '?')}' autolaunch={process.get('autolaunch')} -> launch_mode={process['launch_mode']}")
                # Always derive autolaunch for backward compat with older agents
                process['autolaunch'] = process.get('launch_mode', 'off') != 'off'
                if 'schedules' not in process:
                    process['schedules'] = None

            # Reorder the keys so that 'version' is at the top
            ordered_config = {'version': config['version']}
            for key in config:
                if key != 'version':
                    ordered_config[key] = config[key]

            # Write the updated config back to the file
            write_json_to_file(ordered_config, CONFIG_PATH)


    else:
        # CRITICAL: If config file exists but couldn't be read (file locking, etc.),
        # DO NOT regenerate it - this would wipe the firebase section!
        # Just skip the upgrade and let the service use what's there.
        if os.path.exists(CONFIG_PATH):
            logging.warning(f"Config file exists but couldn't be read (file lock?). Skipping upgrade.")
            logging.warning("If this persists, check file permissions and locks.")
            return  # Skip upgrade, don't overwrite

        # Only generate new config if file truly doesn't exist
        logging.info("Config file doesn't exist, generating default...")
        new_config = generate_config_file()
        write_json_to_file(new_config, CONFIG_PATH)

# Schedule utility for launch_mode='scheduled'
def is_within_schedule(schedules, timezone_str=None):
    """Check if current time falls within ANY schedule block's active window.

    Args:
        schedules: List of schedule blocks, each with 'days' and 'ranges'.
        timezone_str: Optional IANA timezone (e.g. 'America/New_York'). Uses local time if None.

    Returns:
        True if current day+time matches any block, or if schedules is empty/None (safety fallback).
    """
    if not schedules:
        return True  # No schedules = always active (safety fallback)

    from datetime import datetime, time as dt_time
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        from backports.zoneinfo import ZoneInfo

    try:
        tz = ZoneInfo(timezone_str) if timezone_str else None
    except (KeyError, Exception):
        logging.warning(f"Invalid timezone '{timezone_str}', falling back to local time")
        tz = None
    now = datetime.now(tz)
    day_names = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    current_day = day_names[now.weekday()]
    current_time = now.time()

    for block in schedules:
        days = block.get('days', day_names)
        if current_day not in days:
            continue
        for time_range in block.get('ranges', []):
            try:
                start_h, start_m = map(int, time_range['start'].split(':'))
                stop_h, stop_m = map(int, time_range['stop'].split(':'))
            except (ValueError, KeyError):
                continue
            start = dt_time(start_h, start_m)
            stop = dt_time(stop_h, stop_m)
            if start <= stop:
                if start <= current_time <= stop:
                    return True
            else:  # Overnight (e.g., 22:00 - 06:00)
                if current_time >= start or current_time <= stop:
                    return True
    return False

# Read a JSON file and returns its content as a Python dictionary with retry logic
def read_json_from_file(file_path, max_retries=3, initial_delay=0.1):
    """
    Read JSON data from file with retry logic to handle cross-process file locking.

    Args:
        file_path: Source file path
        max_retries: Maximum number of retry attempts (default: 3)
        initial_delay: Initial delay in seconds, doubles with each retry (default: 0.1s)

    Returns:
        Dictionary from JSON file, or {} if error/not found (never returns None)
    """
    with _CrossProcessLock(), json_lock:
        for attempt in range(max_retries):
            try:
                with open(file_path, 'r') as f:
                    content = f.read().strip()
                    # Handle empty files gracefully
                    if not content:
                        logging.debug(f"{file_path} is empty, returning empty dict")
                        return {}
                    data = json.loads(content)
                    return data

            except FileNotFoundError:
                logging.debug(f"{file_path} not found, returning empty dict")
                return {}

            except json.JSONDecodeError as e:
                logging.error(f"Failed to decode JSON from {file_path}: {e}")
                # Return empty dict instead of None to prevent NoneType errors
                return {}

            except PermissionError as e:
                # File is locked by another process - retry with exponential backoff
                if attempt < max_retries - 1:
                    delay = initial_delay * (2 ** attempt)  # Exponential backoff: 0.1s, 0.2s, 0.4s
                    logging.warning(f"File locked during read, retrying in {delay}s... (attempt {attempt + 1}/{max_retries}): {e}")
                    time.sleep(delay)
                else:
                    # Final attempt failed
                    logging.error(f"Failed to read after {max_retries} attempts (file locked): {e}")
                    return {}

            except Exception as e:
                logging.error(f"An error occurred while reading the file {file_path}: {e}")
                return {}

        return {}  # All retries exhausted

# Writes a Python dictionary to a JSON file using atomic write pattern with retry logic
def write_json_to_file(data, file_path, max_retries=3, initial_delay=0.1):
    """
    Write JSON data to file with retry logic to handle cross-process file locking.

    Args:
        data: Dictionary to write as JSON
        file_path: Target file path
        max_retries: Maximum number of retry attempts (default: 3)
        initial_delay: Initial delay in seconds, doubles with each retry (default: 0.1s)
    """
    with _CrossProcessLock(), json_lock:
        # Use atomic write pattern: write to temp file, then rename
        temp_path = file_path + '.tmp'

        for attempt in range(max_retries):
            try:
                # Write to temporary file first
                with open(temp_path, 'w') as f:
                    json.dump(data, f, indent=4)

                # Atomic rename (replaces existing file)
                # os.replace is atomic on Windows (unlike os.rename)
                os.replace(temp_path, file_path)

                return  # Success - exit function

            except PermissionError as e:
                # File is locked by another process - retry with exponential backoff
                if attempt < max_retries - 1:
                    delay = initial_delay * (2 ** attempt)  # Exponential backoff: 0.1s, 0.2s, 0.4s
                    logging.warning(f"File locked, retrying in {delay}s... (attempt {attempt + 1}/{max_retries}): {e}")
                    time.sleep(delay)
                else:
                    # Final attempt failed
                    logging.error(f"Failed to write after {max_retries} attempts (file locked): {e}")
                    # Clean up temp file
                    if os.path.exists(temp_path):
                        try:
                            os.remove(temp_path)
                        except:
                            pass

            except Exception as e:
                # Other errors - don't retry
                if os.path.exists(temp_path):
                    try:
                        os.remove(temp_path)
                    except:
                        pass
                logging.error(f"An error occurred while writing to the file: {e}")
                break  # Exit retry loop on non-permission errors

# Generate a default configuration file, optionally merging with an existing one
def generate_config_file(existing_config=None):
    # Try to preserve firebase section from existing config file
    # This prevents losing authentication when config is regenerated
    preserved_firebase = None
    if existing_config is None and os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r') as f:
                file_config = json.load(f)
                if 'firebase' in file_config:
                    preserved_firebase = file_config['firebase']
                    logging.debug("Preserving firebase section from existing config file")
        except Exception as e:
            logging.debug(f"Could not read existing config to preserve firebase: {e}")
            pass  # Continue with default generation

    default_config = {
        "version": CONFIG_VERSION,
        "environment": "production",  # Default to production environment
        "processes": [],
        "logging": {
            "level": "INFO",
            "max_age_days": 90,
            "firebase_shipping": {
                "enabled": False,
                "ship_errors_only": True
            }
        }
    }

    if existing_config is None:
        # If we preserved a firebase section, add it to default config
        if preserved_firebase:
            default_config['firebase'] = preserved_firebase
            logging.debug("Added preserved firebase section to generated config")
        return default_config

    # Update only missing keys
    for key, value in default_config.items():
        if key not in existing_config:
            existing_config[key] = value

    return existing_config

# Read specific keys from the configuration file or a specific process by its ID
def read_config(keys=None, process_list_id=None):
    config = read_json_from_file(CONFIG_PATH)

    # If process_list_id is provided, find the corresponding process
    if process_list_id:
        for process in config['processes']:
            if process['id'] == process_list_id:
                if keys:
                    item = process
                    for key in keys:
                        item = item.get(key, None)
                        if item is None:
                            return None
                    return item
                else:
                    return process

    # If keys are provided, traverse the config to find the value
    elif keys:
        item = config
        for key in keys:
            item = item.get(key, None)
            if item is None:
                return None
        return item

    return config

# Write a specific value to a specific key in the configuration file
def write_config(keys, value):
    config = read_json_from_file(CONFIG_PATH)

    # Traverse the config dictionary using the keys to find the item to update
    item = config
    for key in keys[:-1]:
        item = item.get(key, {})

    # Update the value
    item[keys[-1]] = value

    write_json_to_file(config, CONFIG_PATH)

# PROCESS TERMINATION

def find_windows_by_pid(pid):
    """Find all top-level window handles (HWNDs) owned by a given PID."""
    import win32gui
    import win32process
    windows = []
    def enum_callback(hwnd, _):
        try:
            _, window_pid = win32process.GetWindowThreadProcessId(hwnd)
            if window_pid == pid and win32gui.IsWindowVisible(hwnd):
                windows.append(hwnd)
        except Exception:
            pass
    try:
        win32gui.EnumWindows(enum_callback, None)
    except Exception:
        pass
    return windows


def graceful_terminate(pid, timeout=5):
    """Attempt graceful shutdown via WM_CLOSE, then fall back to hard terminate.

    Returns True if the process was terminated, False if it was already gone.
    """
    import win32gui
    import win32con

    try:
        proc = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return False

    # Try graceful shutdown: send WM_CLOSE to all visible windows
    windows = find_windows_by_pid(pid)
    if windows:
        for hwnd in windows:
            try:
                win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
            except Exception:
                pass

        # Wait for process to exit gracefully
        try:
            proc.wait(timeout=timeout)
            logging.info(f"Process {pid} exited gracefully after WM_CLOSE")
            return True
        except psutil.TimeoutExpired:
            logging.info(f"Process {pid} did not exit after WM_CLOSE ({timeout}s), forcing terminate")

    # Fall back to hard terminate
    try:
        proc.terminate()
        proc.wait(timeout=3)
        return True
    except psutil.NoSuchProcess:
        return False
    except psutil.TimeoutExpired:
        try:
            proc.kill()
            return True
        except psutil.NoSuchProcess:
            return False


# PROCESSES

def fetch_pid_by_id(target_id):
    data = read_json_from_file(RESULT_FILE_PATH)

    # Defensive programming: ensure data is never None
    if data is None:
        data = {}

    # Filter out the processes that match the target_id
    matching_processes = {pid: info for pid, info in data.items() if info['id'] == target_id}

    if not matching_processes:
        logging.debug(f"No processes found with id: {target_id}")
        return None
    
    # Find the pid of the process with the newest timestamp
    newest_pid = max(matching_processes.keys(), key=lambda pid: matching_processes[pid]['timestamp'])
    
    return newest_pid

def update_process_status_in_json(pid, new_status, firebase_client=None, process_id=None):
    """
    Update process status in JSON file. Status will sync to Firebase via centralized metrics loop.

    Args:
        pid: OS process ID to update
        new_status: New status string (LAUNCHING, RUNNING, STALLED, etc.)
        firebase_client: Deprecated parameter (kept for compatibility)
        process_id: Config process ID (for GUI status mapping)
    """
    # Guard against None/invalid PIDs — writing "None" as a key corrupts app_states.json
    if pid is None:
        logging.debug(f"Skipping status update for None PID (status={new_status}, process_id={process_id})")
        return

    data = read_json_from_file(RESULT_FILE_PATH)

    # Defensive programming: ensure data is never None
    if data is None:
        data = {}

    # Ensure PID entry exists
    if str(pid) not in data:
        data[str(pid)] = {}

    data[str(pid)]['status'] = new_status
    if process_id:
        data[str(pid)]['id'] = process_id
    write_json_to_file(data, RESULT_FILE_PATH)

    # Status updated locally - will sync via centralized metrics loop on next interval
    # (removed immediate Firebase sync to eliminate duplicate uploads and reduce Firebase writes)
    # Removed verbose logging - status changes sync every ~30s to Firebase

def fetch_process_by_id(id, data):
    return next((process for process in data['processes'] if process['id'] == id), None)

def fetch_process_name_by_id(id, data):
    process = next((process for process in data['processes'] if process['id'] == id), None)
    return process['name'] if process else None   

def fetch_process_id_by_name(name, data):
    process = next((process for process in data['processes'] if process['name'] == name), None)
    return process['id'] if process else None

def get_process_index(selected_process_id):
    return next((i for i, p in enumerate(read_config()['processes']) if p['id'] == selected_process_id), None)

# WINDOWS / UI

def get_scaling_factor():
    hdc = ctypes.windll.user32.GetDC(0)
    LOGPIXELSX = 88
    actual_dpi = ctypes.windll.gdi32.GetDeviceCaps(hdc, LOGPIXELSX)
    ctypes.windll.user32.ReleaseDC(0, hdc)
    return actual_dpi / 96.0  # 96 DPI is the standard DPI, so we divide the actual by 96 to get the scaling factor

def center_window(root, width, height):
    scaling_factor = get_scaling_factor()

    # Get screen width and height
    screen_width = root.winfo_screenwidth() * scaling_factor
    screen_height = root.winfo_screenheight() * scaling_factor

    # Calculate position x and y coordinates
    x = (screen_width / 2) - (width * scaling_factor / 2)
    y = (screen_height / 2) - (height * scaling_factor / 2)
    root.geometry(f'{int(width)}x{int(height)}+{int(x)}+{int(y)}')
    root.minsize(width, height)

# METRICS
def get_system_info():
    # Get system information
    cpu_info = get_cpu_name()
    if not cpu_info:
        # Revert to platform info
        cpu_info = platform.processor()
    cpu_usage = psutil.cpu_percent()
    memory_info = psutil.virtual_memory()
    disk_info = psutil.disk_usage('/')
    gpus = GPUtil.getGPUs()
    gpu_info = gpus[0] if gpus else "No GPU detected"

    # Convert bytes to gigabytes
    bytes_to_gb = lambda x: round(x / (1024 ** 3), 2)

    return {
        'cpu_model': cpu_info,
        'cpu_usage': cpu_usage,
        'memory_used': bytes_to_gb(memory_info.used),
        'memory_total': bytes_to_gb(memory_info.total),
        'disk_used': bytes_to_gb(disk_info.used),
        'disk_total': bytes_to_gb(disk_info.total),
        'gpu_model': gpu_info.name if gpu_info else 'N/A',
        'gpu_info': gpu_info.memoryUsed if gpu_info else 'N/A',
        'gpu_total': gpu_info.memoryTotal if gpu_info else 'N/A'
    }

def get_system_metrics(skip_gpu=False):
    """
    Get system metrics with clear units for Firebase.
    Returns CPU model/%, memory (used/total GB), disk (used/total GB), GPU (usage % and VRAM used/total GB).
    Also includes process information from config and runtime state.

    Args:
        skip_gpu: If True, skip GPU checks to avoid command window flashing (use when called from GUI)
    """
    # Read config from disk
    config = read_json_from_file(CONFIG_PATH)
    return get_system_metrics_with_config(config, skip_gpu)


def get_system_metrics_with_config(config, skip_gpu=False):
    """
    Get system metrics with clear units for Firebase.
    Accepts config as parameter to avoid file read race conditions.

    Args:
        config: Configuration dict (to avoid re-reading from disk)
        skip_gpu: If True, skip GPU checks to avoid command window flashing (use when called from GUI)
    """
    try:
        # CPU - model name, percentage, and temperature
        cpu_name = get_cpu_name()
        cpu_percent = round(psutil.cpu_percent(interval=0.1), 1)
        cpu_temp = get_cpu_temperature()  # Celsius or None

        # Memory - bytes to GB
        mem = psutil.virtual_memory()
        mem_used_gb = round(mem.used / (1024**3), 2)
        mem_total_gb = round(mem.total / (1024**3), 2)
        mem_percent = round(mem.percent, 1)

        # Disk - bytes to GB
        disk = psutil.disk_usage('/')
        disk_used_gb = round(disk.used / (1024**3), 2)
        disk_total_gb = round(disk.total / (1024**3), 2)
        disk_percent = round(disk.percent, 1)

        # GPU - usage %, VRAM, and temperature (skip if requested to avoid command window flashing)
        gpu_usage_percent = 0
        gpu_vram_used_gb = 0
        gpu_vram_total_gb = 0
        gpu_name = "N/A"
        gpu_temp = None  # Celsius or None
        if not skip_gpu:
            try:
                gpus = GPUtil.getGPUs()
                if gpus:
                    gpu = gpus[0]
                    gpu_usage_percent = round(gpu.load * 100, 1)
                    gpu_vram_used_gb = round(gpu.memoryUsed / 1024, 2)  # MB to GB
                    gpu_vram_total_gb = round(gpu.memoryTotal / 1024, 2)
                    gpu_name = gpu.name

                    # Get GPU temperature (first GPU only, to match GPUtil behavior)
                    gpu_temps = get_gpu_temperatures()
                    if gpu_temps and len(gpu_temps) > 0:
                        gpu_temp = gpu_temps[0]['temperature']  # Celsius
            except:
                pass

        # Processes - combine config and runtime state
        processes_data = {}
        try:
            # Use config passed as parameter (avoids race condition from re-reading disk)
            # Read runtime state
            runtime_state = read_json_from_file(RESULT_FILE_PATH)

            if config and 'processes' in config:
                # Create a map of process IDs to their runtime PIDs
                pid_to_runtime = {}
                if runtime_state:
                    for pid, state_info in runtime_state.items():
                        # Skip invalid PID keys (e.g. "None" from failed launches)
                        try:
                            pid_int = int(pid)
                        except (ValueError, TypeError):
                            continue
                        process_id = state_info.get('id')
                        if process_id:
                            pid_to_runtime[process_id] = {
                                'pid': pid_int,
                                'status': state_info.get('status', 'UNKNOWN'),
                                'responsive': state_info.get('responsive', True),
                                'timestamp': state_info.get('timestamp', 0)
                            }

                # Build processes data structure
                for index, process in enumerate(config['processes']):
                    process_id = process.get('id')
                    if process_id:
                        # Start with configuration data
                        process_data = {
                            'name': process.get('name', ''),
                            'exe_path': process.get('exe_path', ''),
                            'file_path': process.get('file_path', ''),
                            'cwd': process.get('cwd', ''),
                            'autolaunch': process.get('autolaunch', False),
                            'launch_mode': process.get('launch_mode', 'always' if process.get('autolaunch', False) else 'off'),
                            'schedules': process.get('schedules', None),
                            'priority': process.get('priority', 'Normal'),
                            'visibility': process.get('visibility', 'Show'),
                            'time_delay': process.get('time_delay', 0),
                            'time_to_init': process.get('time_to_init', 10),
                            'relaunch_attempts': process.get('relaunch_attempts', 5),
                            'index': index  # Preserve config order for web app display
                        }

                        # Add runtime state if available
                        if process_id in pid_to_runtime:
                            runtime = pid_to_runtime[process_id]
                            process_data['pid'] = runtime['pid']
                            process_data['status'] = runtime['status']
                            process_data['responsive'] = runtime['responsive']
                            process_data['last_updated'] = runtime['timestamp']
                        else:
                            # Process not running
                            process_data['pid'] = None
                            mode = process.get('launch_mode', 'always' if process.get('autolaunch', False) else 'off')
                            process_data['status'] = 'INACTIVE' if mode == 'off' else 'STOPPED'
                            process_data['responsive'] = True
                            process_data['last_updated'] = 0

                        processes_data[process_id] = process_data
        except Exception as e:
            logging.error(f"Error collecting process data: {e}")

        # Build CPU metrics with optional temperature
        cpu_metrics = {
            'name': cpu_name,
            'percent': cpu_percent,
            'unit': '%'
        }
        if cpu_temp is not None:
            cpu_metrics['temperature'] = round(cpu_temp, 1)  # Celsius, 1 decimal place

        # Build GPU metrics with optional temperature
        gpu_metrics = {
            'name': gpu_name,
            'usage_percent': gpu_usage_percent,
            'vram_used_gb': gpu_vram_used_gb,
            'vram_total_gb': gpu_vram_total_gb,
            'unit': 'GB'
        }
        if gpu_temp is not None:
            gpu_metrics['temperature'] = round(gpu_temp, 1)  # Celsius, 1 decimal place

        return {
            'cpu': cpu_metrics,
            'memory': {
                'used_gb': mem_used_gb,
                'total_gb': mem_total_gb,
                'percent': mem_percent,
                'unit': 'GB'
            },
            'disk': {
                'used_gb': disk_used_gb,
                'total_gb': disk_total_gb,
                'percent': disk_percent,
                'unit': 'GB'
            },
            'gpu': gpu_metrics,
            'processes': processes_data
        }
    except Exception as e:
        logging.error(f"Error getting system metrics: {e}")
        return {
            'cpu': {'name': 'Unknown CPU', 'percent': 0, 'unit': '%'},
            'memory': {'used_gb': 0, 'total_gb': 0, 'percent': 0, 'unit': 'GB'},
            'disk': {'used_gb': 0, 'total_gb': 0, 'percent': 0, 'unit': 'GB'},
            'gpu': {'name': 'N/A', 'usage_percent': 0, 'vram_used_gb': 0, 'vram_total_gb': 0, 'unit': 'GB'},
            'processes': {}
        }