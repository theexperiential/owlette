"""
Project distribution utilities for downloading and extracting project files.
"""

import os
import logging
import time
import zipfile
import tempfile
import shutil
from typing import Optional, Callable, List, Dict
import subprocess

# Reuse download function from installer_utils
from installer_utils import download_file


def extract_zip(
    zip_path: str,
    extract_to: str,
    progress_callback: Optional[Callable[[int], None]] = None
) -> tuple[bool, str]:
    """
    Extract a ZIP archive with progress tracking.

    Args:
        zip_path: Path to the ZIP file
        extract_to: Directory to extract files to
        progress_callback: Optional callback function that receives progress percentage (0-100)

    Returns:
        Tuple of (success, error_message)
        - success: True if extraction succeeded, False otherwise
        - error_message: Error message if failed, empty string otherwise
    """
    try:
        logging.info(f"Extracting ZIP file: {zip_path} to {extract_to}")

        if not os.path.exists(zip_path):
            error_msg = f"ZIP file not found: {zip_path}"
            logging.error(error_msg)
            return False, error_msg

        # Create extraction directory if it doesn't exist
        os.makedirs(extract_to, exist_ok=True)

        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            file_list = zip_ref.namelist()
            total_files = len(file_list)

            logging.info(f"Extracting {total_files} files from archive")

            for index, file_name in enumerate(file_list):
                zip_ref.extract(file_name, extract_to)

                # Report progress
                if progress_callback:
                    progress = int(((index + 1) / total_files) * 100)
                    progress_callback(progress)

        logging.info(f"Successfully extracted {total_files} files to {extract_to}")
        return True, ""

    except zipfile.BadZipFile as e:
        error_msg = f"Invalid or corrupted ZIP file: {e}"
        logging.error(error_msg)
        return False, error_msg
    except PermissionError as e:
        error_msg = f"Permission denied while extracting: {e}"
        logging.error(error_msg)
        return False, error_msg
    except Exception as e:
        error_msg = f"Unexpected error during extraction: {e}"
        logging.error(error_msg)
        return False, error_msg


def verify_project_files(base_path: str, verify_files: List[str]) -> tuple[bool, List[str]]:
    """
    Verify that expected project files/directories exist after extraction.

    Args:
        base_path: Base directory where project was extracted
        verify_files: List of files/directories to verify (relative to base_path)

    Returns:
        Tuple of (all_found, missing_files)
        - all_found: True if all files found, False otherwise
        - missing_files: List of files that were not found
    """
    try:
        missing_files = []

        for file_path in verify_files:
            full_path = os.path.join(base_path, file_path)

            if not os.path.exists(full_path):
                missing_files.append(file_path)
                logging.warning(f"Verification failed: {file_path} not found")
            else:
                logging.info(f"Verification passed: {file_path} found")

        if missing_files:
            logging.warning(f"Project verification incomplete: {len(missing_files)} file(s) missing")
            return False, missing_files
        else:
            logging.info("Project verification passed: all files found")
            return True, []

    except Exception as e:
        logging.error(f"Error verifying project files: {e}")
        return False, verify_files


def get_temp_project_path(project_name: str) -> str:
    """
    Generate a temporary path for downloading a project ZIP.

    Args:
        project_name: Name of the project (e.g., "MyProject.zip")

    Returns:
        Full path to temporary project location
    """
    temp_dir = tempfile.gettempdir()
    owlette_temp = os.path.join(temp_dir, "owlette_projects")
    os.makedirs(owlette_temp, exist_ok=True)

    # Clean up temp files older than 24 hours to prevent unbounded disk growth
    cutoff = time.time() - 86400
    try:
        for filename in os.listdir(owlette_temp):
            filepath = os.path.join(owlette_temp, filename)
            try:
                if os.path.isfile(filepath) and os.path.getmtime(filepath) < cutoff:
                    os.remove(filepath)
            except OSError:
                pass
    except OSError:
        pass

    return os.path.join(owlette_temp, project_name)


def cleanup_project_zip(project_path: str) -> bool:
    """
    Remove a temporary project ZIP file after extraction.

    Args:
        project_path: Path to the project ZIP file

    Returns:
        True if cleanup succeeded, False otherwise
    """
    try:
        if os.path.exists(project_path):
            os.remove(project_path)
            logging.info(f"Cleaned up project ZIP: {project_path}")
            return True
        return False
    except Exception as e:
        logging.warning(f"Failed to cleanup project ZIP {project_path}: {e}")
        return False


def cancel_distribution(project_name: str, active_downloads: Dict[str, bool]) -> tuple[bool, str]:
    """
    Cancel an active project distribution.

    Args:
        project_name: Name of the project being cancelled
        active_downloads: Dictionary tracking active downloads

    Returns:
        Tuple of (success, message)
    """
    try:
        if project_name not in active_downloads:
            return False, f"No active distribution found for {project_name}"

        # Mark as cancelled (download/extraction threads should check this)
        active_downloads[project_name] = False

        # Cleanup project ZIP file
        project_path = get_temp_project_path(project_name)
        cleanup_project_zip(project_path)

        logging.info(f"Distribution cancelled successfully: {project_name}")
        return True, f"Distribution cancelled: {project_name}"

    except Exception as e:
        error_msg = f"Error cancelling distribution: {str(e)}"
        logging.error(error_msg)
        return False, error_msg


def get_default_project_directory() -> str:
    """
    Get the default directory for project extraction.

    Returns:
        Path to the default project directory
    """
    # Default to user's Documents folder
    user_home = os.path.expanduser("~")
    default_dir = os.path.join(user_home, "Documents", "OwletteProjects")
    os.makedirs(default_dir, exist_ok=True)
    return default_dir


def download_project(
    url: str,
    project_name: str,
    progress_callback: Optional[Callable[[int], None]] = None
) -> tuple[bool, str]:
    """
    Download a project ZIP file with progress tracking.

    Args:
        url: URL to download from
        project_name: Name for the downloaded file
        progress_callback: Optional callback function that receives progress percentage (0-100)

    Returns:
        Tuple of (success, path_or_error)
        - success: True if download succeeded, False otherwise
        - path_or_error: Downloaded file path if successful, error message otherwise
    """
    try:
        dest_path = get_temp_project_path(project_name)
        success, actual_path = download_file(url, dest_path, progress_callback)

        if success:
            return True, actual_path
        else:
            return False, f"Failed to download project from {url}"

    except Exception as e:
        error_msg = f"Error downloading project: {e}"
        logging.error(error_msg)
        return False, error_msg
