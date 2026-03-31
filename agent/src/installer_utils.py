"""
Installer utilities for downloading and executing software installers.
"""

import os
import logging
import subprocess
import tempfile
import requests
import psutil
import hashlib
import time
from typing import Optional, Callable, Dict, List


def hide_registry_keys(software_name: str) -> List[dict]:
    """
    Temporarily hide existing uninstall registry keys for a software product.

    Some installers (e.g. TouchDesigner) detect existing installations via
    registry keys and force-uninstall them in silent mode. This function
    renames those keys so the installer thinks no previous version exists,
    enabling true side-by-side parallel installation.

    Args:
        software_name: Display name prefix to match (e.g. "TouchDesigner")

    Returns:
        List of dicts with 'original' and 'hidden' key names for restoration.
    """
    import winreg

    uninstall_path = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
    hidden_keys = []

    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, uninstall_path) as parent:
            # Enumerate all subkeys and find matches
            index = 0
            keys_to_hide = []
            while True:
                try:
                    subkey_name = winreg.EnumKey(parent, index)
                    index += 1
                except OSError:
                    break

                try:
                    with winreg.OpenKey(parent, subkey_name) as subkey:
                        display_name, _ = winreg.QueryValueEx(subkey, "DisplayName")
                        if display_name and display_name.strip().startswith(software_name):
                            keys_to_hide.append(subkey_name)
                except (OSError, FileNotFoundError):
                    continue

        # Rename matching keys using reg.exe (winreg has no rename API)
        for key_name in keys_to_hide:
            hidden_name = f"_owlette_hidden_{key_name}"
            full_path = f"HKLM\\{uninstall_path}\\{key_name}"
            hidden_path = f"HKLM\\{uninstall_path}\\{hidden_name}"

            # Copy key to hidden name, then delete original
            result = subprocess.run(
                ['reg', 'copy', full_path, hidden_path, '/s', '/f'],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                logging.error(f"Failed to copy registry key {key_name}: {result.stderr}")
                continue

            result = subprocess.run(
                ['reg', 'delete', full_path, '/f'],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                logging.error(f"Failed to delete original registry key {key_name}: {result.stderr}")
                # Try to clean up the copy
                subprocess.run(['reg', 'delete', hidden_path, '/f'],
                               capture_output=True, text=True, timeout=10)
                continue

            hidden_keys.append({'original': key_name, 'hidden': hidden_name})
            logging.info(f"Hidden registry key: {key_name} -> {hidden_name}")

        if hidden_keys:
            logging.info(f"Hidden {len(hidden_keys)} existing '{software_name}' registry key(s)")
        else:
            logging.debug(f"No existing '{software_name}' registry keys found to hide")

    except Exception as e:
        logging.error(f"Error hiding registry keys for '{software_name}': {e}")

    return hidden_keys


def restore_registry_keys(hidden_keys: List[dict]) -> None:
    """
    Restore previously hidden registry keys after installation completes.

    Args:
        hidden_keys: List from hide_registry_keys() with 'original' and 'hidden' names.
    """
    uninstall_path = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"

    for entry in hidden_keys:
        original_name = entry['original']
        hidden_name = entry['hidden']
        original_path = f"HKLM\\{uninstall_path}\\{original_name}"
        hidden_path = f"HKLM\\{uninstall_path}\\{hidden_name}"

        try:
            # Copy hidden key back to original name
            result = subprocess.run(
                ['reg', 'copy', hidden_path, original_path, '/s', '/f'],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                logging.error(f"Failed to restore registry key {original_name}: {result.stderr}")
                continue

            # Delete the hidden copy
            subprocess.run(
                ['reg', 'delete', hidden_path, '/f'],
                capture_output=True, text=True, timeout=10
            )

            logging.info(f"Restored registry key: {hidden_name} -> {original_name}")

        except Exception as e:
            logging.error(f"Error restoring registry key {original_name}: {e}")

    if hidden_keys:
        logging.info(f"Restored {len(hidden_keys)} registry key(s)")


def download_file(
    url: str,
    dest_path: str,
    progress_callback: Optional[Callable[[int], None]] = None,
    max_retries: int = 3,
    connect_timeout: int = 30,
    read_timeout: int = 600
) -> tuple[bool, str]:
    """
    Download a file from a URL with progress tracking and retry logic.

    Args:
        url: URL to download from
        dest_path: Destination file path
        progress_callback: Optional callback function that receives progress percentage (0-100)
        max_retries: Maximum number of retry attempts (default: 3)
        connect_timeout: Connection timeout in seconds (default: 30)
        read_timeout: Read timeout in seconds (default: 600 = 10 minutes for large files)

    Returns:
        Tuple of (success, actual_path):
        - success: True if download succeeded, False otherwise
        - actual_path: The actual path where the file was saved (may differ from dest_path if file was in use)
    """
    logging.debug(f"Starting download from {url}")

    # Create destination directory if it doesn't exist
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)

    # Pre-download cleanup: handle existing files
    if os.path.exists(dest_path):
        logging.debug(f"File already exists at {dest_path}, attempting cleanup...")
        try:
            os.remove(dest_path)
            logging.debug("Existing file removed successfully")
        except PermissionError as e:
            # File is locked by another process - generate unique filename
            timestamp = int(time.time())
            base_name, ext = os.path.splitext(dest_path)
            dest_path = f"{base_name}_{timestamp}{ext}"
            logging.warning(f"Could not remove existing file (in use), using unique filename: {dest_path}")
        except Exception as e:
            logging.error(f"Error removing existing file: {e}")
            return False, ""

    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            if attempt > 1:
                # Exponential backoff: 5s, 10s, 20s...
                wait_time = 5 * (2 ** (attempt - 2))
                logging.info(f"Retry attempt {attempt}/{max_retries} after {wait_time}s delay...")
                time.sleep(wait_time)

            # Stream the download to avoid loading entire file into memory
            # Use separate connect and read timeouts - large files need more read time
            response = requests.get(
                url,
                stream=True,
                timeout=(connect_timeout, read_timeout),
                allow_redirects=True  # Follow redirects (important for Dropbox/cloud storage)
            )
            response.raise_for_status()

            total_size = int(response.headers.get('content-length', 0))
            downloaded_size = 0

            # Use larger chunk size for better performance on large files
            chunk_size = 64 * 1024  # 64KB chunks

            with open(dest_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=chunk_size):
                    if chunk:
                        f.write(chunk)
                        downloaded_size += len(chunk)

                        # Report progress
                        if total_size > 0 and progress_callback:
                            progress = int((downloaded_size / total_size) * 100)
                            progress_callback(progress)

            # Verify we got a complete file (if content-length was provided)
            if total_size > 0 and downloaded_size < total_size:
                raise requests.exceptions.RequestException(
                    f"Incomplete download: got {downloaded_size} bytes, expected {total_size}"
                )

            logging.info(f"Download completed: {dest_path} ({downloaded_size:,} bytes)")
            return True, dest_path

        except requests.exceptions.Timeout as e:
            last_error = f"Timeout on attempt {attempt}: {e}"
            logging.warning(last_error)
        except requests.exceptions.ConnectionError as e:
            last_error = f"Connection error on attempt {attempt}: {e}"
            logging.warning(last_error)
        except requests.exceptions.RequestException as e:
            last_error = f"Request error on attempt {attempt}: {e}"
            logging.warning(last_error)
        except Exception as e:
            last_error = f"Unexpected error on attempt {attempt}: {e}"
            logging.warning(last_error)

        # Clean up partial download before retry
        if os.path.exists(dest_path):
            try:
                os.remove(dest_path)
            except:
                pass

    # All retries exhausted
    logging.error(f"Download failed after {max_retries} attempts. Last error: {last_error}")
    return False, ""


def _kill_process_tree(pid: int) -> None:
    """Kill a process and all its children."""
    try:
        parent = psutil.Process(pid)
        children = parent.children(recursive=True)

        for child in children:
            try:
                logging.warning(f"Killing child process: {child.name()} (PID: {child.pid})")
                child.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass

        parent.kill()
        logging.warning(f"Killed installer process tree (parent PID: {pid}, {len(children)} children)")

        gone, alive = psutil.wait_procs([parent] + children, timeout=3)
        for proc in alive:
            try:
                proc.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
    except psutil.NoSuchProcess:
        pass
    except Exception as e:
        logging.error(f"Error killing process tree: {e}")


def execute_installer(
    installer_path: str,
    flags: str = "",
    installer_name: str = "",
    active_processes: Optional[Dict[str, int]] = None,
    timeout_seconds: int = 1200,
    user_token=None,
    environment=None,
) -> tuple[bool, int, str]:
    """
    Execute an installer with silent flags.

    Launches in the user's desktop session via CreateProcessAsUser when
    user_token is provided.  Falls back to subprocess.Popen (Session 0)
    when user_token is None.

    Args:
        installer_path: Path to the installer executable
        flags: Silent installation flags (e.g., "/VERYSILENT /DIR=C:\\Program")
        installer_name: Name of the installer (for tracking cancellable processes)
        active_processes: Dictionary mapping installer names to PIDs (for cancellation)
        timeout_seconds: Maximum time to wait for installation
        user_token: Win32 user token for CreateProcessAsUser (from _refresh_user_token)
        environment: Environment block for the user session (from CreateEnvironmentBlock)

    Returns:
        Tuple of (success, exit_code, error_message)
    """
    try:
        if not os.path.exists(installer_path):
            error_msg = f"Installer not found: {installer_path}"
            logging.error(error_msg)
            return False, -1, error_msg

        # Build command as a string — Windows CreateProcess handles arg parsing natively.
        command = f'"{installer_path}"'
        if flags:
            command = f'{command} {flags}'

        logging.info(f"Executing installer: {command}")

        if user_token is not None:
            return _execute_as_user(
                command, user_token, environment,
                installer_name, active_processes, timeout_seconds,
            )
        else:
            return _execute_as_system(
                command, installer_name, active_processes, timeout_seconds,
            )

    except Exception as e:
        if active_processes and installer_name in active_processes:
            del active_processes[installer_name]
        error_msg = f"Unexpected error executing installer: {e}"
        logging.error(error_msg)
        return False, -1, error_msg


def _execute_as_user(
    command: str,
    user_token,
    environment,
    installer_name: str,
    active_processes: Optional[Dict[str, int]],
    timeout_seconds: int,
) -> tuple[bool, int, str]:
    """Run installer in the user's desktop session via CreateProcessAsUser."""
    import win32process
    import win32event
    import win32api
    import win32con

    si = win32process.STARTUPINFO()
    si.dwFlags = win32process.STARTF_USESHOWWINDOW
    # SW_SHOWMINNOACTIVE: window starts minimized but NOT hidden.
    # SW_HIDE causes invisible dialogs that block forever when an installer
    # spawns an unexpected prompt (e.g. TD's "directory exists" dialog).
    si.wShowWindow = win32con.SW_SHOWMINNOACTIVE
    si.lpDesktop = "WinSta0\\Default"

    logging.info("Launching installer in user session (CreateProcessAsUser)")

    h_process, h_thread, pid, _tid = win32process.CreateProcessAsUser(
        user_token,
        None,           # Application name
        command,        # Command line
        None, None,     # Security attributes
        0,              # Inherit handles
        win32con.NORMAL_PRIORITY_CLASS,
        environment,
        None,           # Current directory
        si,
    )
    win32api.CloseHandle(h_thread)

    logging.info(f"Installer launched in user session (PID: {pid})")

    # Track for cancellation
    if active_processes is not None and installer_name:
        active_processes[installer_name] = pid

    # Wait for completion or timeout
    timeout_ms = timeout_seconds * 1000
    result = win32event.WaitForSingleObject(h_process, timeout_ms)

    if result == win32event.WAIT_TIMEOUT:
        logging.error(f"Installer timed out after {timeout_seconds}s (PID: {pid})")
        _kill_process_tree(pid)
        win32api.CloseHandle(h_process)
        if active_processes and installer_name in active_processes:
            del active_processes[installer_name]
        return False, -1, f"Installer execution timeout (exceeded {timeout_seconds} seconds)"

    exit_code = win32process.GetExitCodeProcess(h_process)
    win32api.CloseHandle(h_process)

    if active_processes and installer_name in active_processes:
        del active_processes[installer_name]

    logging.debug(f"Installer exit code: {exit_code}")

    if exit_code == 0:
        return True, exit_code, ""
    elif exit_code == 3010:
        logging.info("Installer returned 3010 (reboot required) — treating as success")
        return True, exit_code, ""
    else:
        error_msg = f"Installer failed with exit code {exit_code}"
        logging.error(error_msg)
        return False, exit_code, error_msg


def _execute_as_system(
    command: str,
    installer_name: str,
    active_processes: Optional[Dict[str, int]],
    timeout_seconds: int,
) -> tuple[bool, int, str]:
    """Run installer in Session 0 via subprocess (fallback when no user session)."""
    process = subprocess.Popen(
        command,
        shell=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    pid = process.pid
    if active_processes is not None and installer_name:
        active_processes[installer_name] = pid
        logging.debug(f"Tracking installer process: {installer_name} (PID: {pid})")

    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
        exit_code = process.returncode
    except subprocess.TimeoutExpired:
        _kill_process_tree(pid)
        if active_processes and installer_name in active_processes:
            del active_processes[installer_name]
        error_msg = f"Installer execution timeout (exceeded {timeout_seconds} seconds)"
        logging.error(error_msg)
        return False, -1, error_msg

    if active_processes and installer_name in active_processes:
        del active_processes[installer_name]

    logging.debug(f"Installer exit code: {exit_code}")

    if exit_code == 0:
        return True, exit_code, ""
    elif exit_code == 3010:
        logging.info("Installer returned 3010 (reboot required) — treating as success")
        return True, exit_code, ""
    else:
        error_msg = f"Installer failed with exit code {exit_code}"
        if stderr:
            error_msg += f": {stderr}"
        logging.error(error_msg)
        return False, exit_code, error_msg


def verify_checksum(file_path: str, expected_sha256: str) -> bool:
    """
    Verify the SHA256 checksum of a downloaded file.

    Args:
        file_path: Path to the file to verify
        expected_sha256: Expected SHA256 hash (case-insensitive)

    Returns:
        True if checksum matches, False otherwise
    """
    try:
        sha256_hash = hashlib.sha256()

        # Read file in chunks to handle large files efficiently
        with open(file_path, 'rb') as f:
            for chunk in iter(lambda: f.read(8192), b''):
                sha256_hash.update(chunk)

        actual_hash = sha256_hash.hexdigest().lower()
        expected_hash = expected_sha256.lower()

        if actual_hash == expected_hash:
            logging.debug(f"Checksum verification passed: {actual_hash}")
            return True
        else:
            logging.error(f"Checksum verification FAILED!")
            logging.error(f"Expected: {expected_hash}")
            logging.error(f"Actual:   {actual_hash}")
            return False

    except Exception as e:
        logging.error(f"Error verifying checksum: {e}")
        return False


def verify_installation(path: str) -> bool:
    """
    Verify that an installation succeeded by checking if a file exists.

    Args:
        path: Path to the installed executable or file

    Returns:
        True if file exists, False otherwise
    """
    exists = os.path.exists(path)
    if exists:
        logging.info(f"Installation verified: {path} exists")
    else:
        logging.warning(f"Installation verification failed: {path} not found")
    return exists


def get_temp_installer_path(installer_name: str) -> str:
    """
    Generate a temporary path for downloading an installer.

    Args:
        installer_name: Name of the installer (e.g., "TouchDesigner.exe")

    Returns:
        Full path to temporary installer location
    """
    temp_dir = tempfile.gettempdir()
    owlette_temp = os.path.join(temp_dir, "owlette_installers")
    os.makedirs(owlette_temp, exist_ok=True)
    return os.path.join(owlette_temp, installer_name)


def cleanup_installer(installer_path: str, force: bool = False) -> bool:
    """
    Remove a temporary installer file after installation.

    Args:
        installer_path: Path to the installer file
        force: If True, attempt to kill processes using the file before deletion

    Returns:
        True if cleanup succeeded, False otherwise
    """
    try:
        if not os.path.exists(installer_path):
            return False

        # Try simple deletion first
        try:
            os.remove(installer_path)
            logging.debug(f"Cleaned up installer: {installer_path}")
            return True
        except PermissionError as e:
            if not force:
                logging.warning(f"Failed to cleanup installer {installer_path}: {e}")
                return False

            # Force mode: Find and kill processes using this file
            logging.warning(f"File is locked: {installer_path}, attempting force cleanup...")

            try:
                import psutil

                # Get the installer filename
                installer_name = os.path.basename(installer_path)
                killed_processes = []

                # Find all processes with this name or using this file
                for proc in psutil.process_iter(['pid', 'name', 'exe']):
                    try:
                        proc_name = proc.info['name']
                        proc_exe = proc.info['exe']

                        # Check if process name or exe matches
                        if (proc_name and installer_name.lower() in proc_name.lower()) or \
                           (proc_exe and installer_path.lower() in proc_exe.lower()):
                            logging.warning(f"Killing process using installer: {proc_name} (PID: {proc.info['pid']})")
                            proc.kill()
                            killed_processes.append(proc.info['pid'])
                    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                        continue

                if killed_processes:
                    # Wait a moment for processes to die
                    import time
                    time.sleep(1)

                    # Retry deletion
                    os.remove(installer_path)
                    logging.debug(f"Force cleanup succeeded: {installer_path} (killed {len(killed_processes)} process(es))")
                    return True
                else:
                    logging.warning(f"No processes found using {installer_path}, but file is still locked")
                    return False

            except ImportError:
                logging.error("psutil not available for force cleanup")
                return False
            except Exception as force_error:
                logging.error(f"Force cleanup failed: {force_error}")
                return False

    except Exception as e:
        logging.warning(f"Failed to cleanup installer {installer_path}: {e}")
        return False


def cancel_installation(installer_name: str, active_processes: Dict[str, int]) -> tuple[bool, str]:
    """
    Cancel an active installation by killing the installer process tree.

    Args:
        installer_name: Name of the installer being cancelled
        active_processes: Dictionary mapping installer names to PIDs

    Returns:
        Tuple of (success, message)
    """
    try:
        if installer_name not in active_processes:
            return False, f"No active installation found for {installer_name}"

        pid = active_processes[installer_name]
        logging.debug(f"Cancelling installation: {installer_name} (PID: {pid})")

        _kill_process_tree(pid)

        del active_processes[installer_name]

        installer_path = get_temp_installer_path(installer_name)
        cleanup_installer(installer_path)

        logging.info(f"Installation cancelled successfully: {installer_name}")
        return True, f"Installation cancelled: {installer_name}"

    except Exception as e:
        error_msg = f"Error cancelling installation: {str(e)}"
        logging.error(error_msg)
        return False, error_msg
