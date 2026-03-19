"""
Installer utilities for downloading and executing software installers.
"""

import os
import logging
import shlex
import subprocess
import tempfile
import requests
import psutil
import hashlib
import time
from typing import Optional, Callable, Dict


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


def execute_installer(
    installer_path: str,
    flags: str = "",
    installer_name: str = "",
    active_processes: Optional[Dict[str, subprocess.Popen]] = None,
    timeout_seconds: int = 1200
) -> tuple[bool, int, str]:
    """
    Execute an installer with silent flags.

    Args:
        installer_path: Path to the installer executable
        flags: Silent installation flags (e.g., "/VERYSILENT /DIR=C:\\Program")
        installer_name: Name of the installer (for tracking cancellable processes)
        active_processes: Dictionary to track active installations (for cancellation)
        timeout_seconds: Maximum time to wait for installation (default: 600 seconds / 10 minutes)

    Returns:
        Tuple of (success, exit_code, error_message)
        - success: True if exit code was 0, False otherwise
        - exit_code: The installer's exit code
        - error_message: Error message if failed, empty string otherwise
    """
    try:
        if not os.path.exists(installer_path):
            error_msg = f"Installer not found: {installer_path}"
            logging.error(error_msg)
            return False, -1, error_msg

        # Build command as list to avoid shell injection
        command = [installer_path]
        if flags:
            # Use shlex.split to safely parse flags into a list
            try:
                command.extend(shlex.split(flags, posix=False))
            except ValueError as e:
                error_msg = f"Invalid installer flags: {e}"
                logging.error(error_msg)
                return False, -1, error_msg

        logging.info(f"Executing installer: {command}")

        # Use Popen instead of run so we can track and cancel the process
        process = subprocess.Popen(
            command,
            shell=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )

        # Track process for potential cancellation
        if active_processes is not None and installer_name:
            active_processes[installer_name] = process
            logging.debug(f"Tracking installer process: {installer_name} (PID: {process.pid})")

        # Wait for installation to complete (configurable timeout)
        try:
            stdout, stderr = process.communicate(timeout=timeout_seconds)
            exit_code = process.returncode
        except subprocess.TimeoutExpired:
            # Kill the process tree (parent + all children)
            try:
                import psutil
                parent = psutil.Process(process.pid)
                children = parent.children(recursive=True)

                # Kill children first, then parent
                for child in children:
                    try:
                        logging.warning(f"Killing child process: {child.name()} (PID: {child.pid})")
                        child.kill()
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass

                parent.kill()
                logging.warning(f"Killed installer process tree (parent PID: {process.pid}, {len(children)} children)")

                # Wait for processes to fully terminate
                gone, alive = psutil.wait_procs([parent] + children, timeout=3)
                for proc in alive:
                    try:
                        proc.kill()  # Force kill if still alive
                    except:
                        pass

            except ImportError:
                # Fallback if psutil not available
                process.kill()
                logging.warning("psutil not available, using basic process.kill()")
            except Exception as kill_error:
                logging.error(f"Error killing process tree: {kill_error}")
                process.kill()  # Fallback to basic kill

            if active_processes and installer_name in active_processes:
                del active_processes[installer_name]

            error_msg = f"Installer execution timeout (exceeded {timeout_seconds} seconds)"
            logging.error(error_msg)
            return False, -1, error_msg

        # Remove from active processes once complete
        if active_processes and installer_name in active_processes:
            del active_processes[installer_name]

        logging.debug(f"Installer exit code: {exit_code}")

        if exit_code == 0:
            return True, exit_code, ""
        else:
            error_msg = f"Installer failed with exit code {exit_code}"
            if stderr:
                error_msg += f": {stderr}"
            logging.error(error_msg)
            return False, exit_code, error_msg

    except Exception as e:
        # Clean up tracking if error occurs
        if active_processes and installer_name in active_processes:
            del active_processes[installer_name]
        error_msg = f"Unexpected error executing installer: {e}"
        logging.error(error_msg)
        return False, -1, error_msg


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


def cancel_installation(installer_name: str, active_processes: Dict[str, subprocess.Popen]) -> tuple[bool, str]:
    """
    Cancel an active installation by killing the installer process.

    Args:
        installer_name: Name of the installer being cancelled
        active_processes: Dictionary mapping installer names to Popen processes

    Returns:
        Tuple of (success, message)
    """
    try:
        if installer_name not in active_processes:
            return False, f"No active installation found for {installer_name}"

        process = active_processes[installer_name]

        # Kill the installer process
        logging.debug(f"Cancelling installation: {installer_name} (PID: {process.pid})")

        # Try graceful termination first
        try:
            parent = psutil.Process(process.pid)
            # Kill all child processes too
            children = parent.children(recursive=True)
            for child in children:
                logging.debug(f"Terminating child process: {child.pid}")
                child.terminate()
            parent.terminate()

            # Wait up to 3 seconds for termination
            gone, alive = psutil.wait_procs([parent] + children, timeout=3)

            # Force kill if still alive
            for p in alive:
                logging.warning(f"Force killing process: {p.pid}")
                p.kill()

        except psutil.NoSuchProcess:
            # Process already terminated
            pass

        # Remove from active processes
        del active_processes[installer_name]

        # Cleanup installer file
        installer_path = get_temp_installer_path(installer_name)
        cleanup_installer(installer_path)

        logging.info(f"Installation cancelled successfully: {installer_name}")
        return True, f"Installation cancelled: {installer_name}"

    except Exception as e:
        error_msg = f"Error cancelling installation: {str(e)}"
        logging.error(error_msg)
        return False, error_msg
