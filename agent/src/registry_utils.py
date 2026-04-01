"""
Registry utilities for detecting installed software on Windows.

This module provides functions to query the Windows Registry for installed
software and extract uninstall information.
"""

import logging
import winreg
import re
from typing import List, Dict, Optional


def get_installed_software() -> List[Dict[str, str]]:
    """
    Query Windows Registry to get list of installed software.

    Searches both 64-bit and 32-bit registry locations for installed software.

    Returns:
        List of dictionaries containing software information:
        - name: Display name of the software
        - version: Version string (if available)
        - publisher: Publisher/manufacturer name
        - install_location: Installation directory
        - uninstall_command: Command to uninstall the software
        - installer_type: Detected installer type (inno, nsis, msi, custom)
    """
    software_list = []

    # Registry paths to check
    registry_paths = [
        # 64-bit software on 64-bit Windows
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        # 32-bit software on 64-bit Windows
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        # Current user installations
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]

    for hkey, registry_path in registry_paths:
        try:
            software_list.extend(_query_registry_path(hkey, registry_path))
        except Exception as e:
            logging.warning(f"Failed to query registry path {registry_path}: {e}")

    # Remove duplicates (same software might appear in multiple locations)
    unique_software = _remove_duplicates(software_list)

    logging.info(f"Found {len(unique_software)} installed software packages")
    return unique_software


def _query_registry_path(hkey: int, registry_path: str) -> List[Dict[str, str]]:
    """
    Query a specific registry path for installed software.

    Args:
        hkey: Registry hive (e.g., winreg.HKEY_LOCAL_MACHINE)
        registry_path: Path within the hive to query

    Returns:
        List of software dictionaries
    """
    software_list = []

    try:
        with winreg.OpenKey(hkey, registry_path) as key:
            # Iterate through all subkeys (each represents a software package)
            index = 0
            while True:
                try:
                    subkey_name = winreg.EnumKey(key, index)
                    index += 1

                    # Open the subkey to read its values
                    with winreg.OpenKey(key, subkey_name) as subkey:
                        software_info = _extract_software_info(subkey, subkey_name)

                        # Only include if it has a display name and uninstall command
                        if software_info and software_info.get('name') and software_info.get('uninstall_command'):
                            software_list.append(software_info)

                except OSError:
                    # No more subkeys to enumerate
                    break
                except Exception as e:
                    # Log but continue with other entries
                    logging.debug(f"Error reading registry subkey {subkey_name}: {e}")
                    continue

    except FileNotFoundError:
        logging.debug(f"Registry path not found: {registry_path}")
    except Exception as e:
        logging.error(f"Error querying registry path {registry_path}: {e}")

    return software_list


def _extract_software_info(subkey, subkey_name: str) -> Optional[Dict[str, str]]:
    """
    Extract software information from a registry subkey.

    Args:
        subkey: Open registry subkey handle
        subkey_name: Name of the subkey (for logging)

    Returns:
        Dictionary with software information, or None if invalid
    """
    try:
        # Read standard registry values
        display_name = _read_registry_value(subkey, "DisplayName")

        # Skip system components and updates
        if not display_name or _is_system_component(subkey, display_name):
            return None

        uninstall_string = _read_registry_value(subkey, "UninstallString")
        if not uninstall_string:
            return None

        # Extract other useful information
        version = _read_registry_value(subkey, "DisplayVersion") or ""
        publisher = _read_registry_value(subkey, "Publisher") or ""
        install_location = _read_registry_value(subkey, "InstallLocation") or ""

        # Detect installer type from uninstall command
        installer_type = detect_installer_type(uninstall_string)

        return {
            'name': display_name,
            'version': version,
            'publisher': publisher,
            'install_location': install_location.rstrip('\\'),  # Remove trailing slash
            'uninstall_command': uninstall_string,
            'installer_type': installer_type,
            'registry_key': subkey_name  # Store for reference
        }

    except Exception as e:
        logging.debug(f"Error extracting software info from {subkey_name}: {e}")
        return None


def _read_registry_value(key, value_name: str) -> Optional[str]:
    """
    Safely read a registry value.

    Args:
        key: Open registry key handle
        value_name: Name of the value to read

    Returns:
        String value, or None if not found
    """
    try:
        value, _ = winreg.QueryValueEx(key, value_name)
        return str(value) if value else None
    except FileNotFoundError:
        return None
    except Exception:
        return None


def _is_system_component(subkey, display_name: str) -> bool:
    """
    Check if a registry entry represents a system component that shouldn't be uninstalled.

    Args:
        subkey: Open registry subkey handle
        display_name: Display name of the software

    Returns:
        True if this is a system component, False otherwise
    """
    # Check SystemComponent flag
    try:
        system_component, _ = winreg.QueryValueEx(subkey, "SystemComponent")
        if system_component == 1:
            return True
    except:
        pass

    # Check ParentKeyName (indicates it's an update/component)
    try:
        parent_key, _ = winreg.QueryValueEx(subkey, "ParentKeyName")
        if parent_key:
            return True
    except:
        pass

    # Filter out Windows updates and hotfixes
    if display_name.startswith("Security Update") or \
       display_name.startswith("Update for") or \
       display_name.startswith("Hotfix for") or \
       "KB" in display_name and len(display_name) < 30:
        return True

    return False


def _remove_duplicates(software_list: List[Dict[str, str]]) -> List[Dict[str, str]]:
    """
    Remove duplicate software entries (same name and version).

    Args:
        software_list: List of software dictionaries

    Returns:
        Deduplicated list
    """
    seen = set()
    unique_software = []

    for software in software_list:
        # Create a unique key based on name and version
        key = (software['name'].lower(), software['version'].lower())

        if key not in seen:
            seen.add(key)
            unique_software.append(software)

    return unique_software


def detect_installer_type(uninstall_command: str) -> str:
    """
    Detect the installer type from the uninstall command string.

    Args:
        uninstall_command: Uninstall command from registry

    Returns:
        One of: 'inno', 'nsis', 'msi', 'custom'
    """
    command_lower = uninstall_command.lower()

    # Inno Setup - uses "unins000.exe" (numbered) or contains "inno"
    # Must check for the numbered pattern specifically — generic "Uninstall.exe" is NOT Inno
    if re.search(r'unins\d+\.exe', command_lower) or 'inno' in command_lower:
        return 'inno'

    # NSIS - typically "uninst.exe", "uninstall.exe", or contains "nsis"
    if 'uninst' in command_lower or 'uninstall' in command_lower or 'nsis' in command_lower:
        return 'nsis'

    # MSI - uses msiexec
    if 'msiexec' in command_lower or '.msi' in command_lower:
        return 'msi'

    # Default to custom if can't determine
    return 'custom'


def get_silent_uninstall_flags(installer_type: str) -> str:
    """
    Get the appropriate silent uninstall flags for a given installer type.

    Args:
        installer_type: Type of installer ('inno', 'nsis', 'msi', 'custom')

    Returns:
        String of silent uninstall flags
    """
    flags_map = {
        'inno': '/VERYSILENT /NORESTART /SUPPRESSMSGBOXES /FORCECLOSEAPPLICATIONS',
        'nsis': '/S',
        'msi': '/quiet /norestart',
        'custom': ''  # No standard flags for custom installers
    }

    return flags_map.get(installer_type, '')


def build_silent_uninstall_command(uninstall_command: str, installer_type: str) -> str:
    """
    Build a complete silent uninstall command with appropriate flags.

    Args:
        uninstall_command: Original uninstall command from registry
        installer_type: Type of installer

    Returns:
        Complete uninstall command with silent flags
    """
    silent_flags = get_silent_uninstall_flags(installer_type)

    # For MSI, the uninstall command already includes msiexec flags
    # We need to replace /I with /X and add silent flags
    if installer_type == 'msi':
        # Handle msiexec commands
        if 'msiexec' in uninstall_command.lower():
            # Replace /I (install) with /X (uninstall) if present
            command = re.sub(r'/I\b', '/X', uninstall_command, flags=re.IGNORECASE)

            # Add silent flags if not already present
            if '/quiet' not in command.lower() and '/qn' not in command.lower():
                command += f' {silent_flags}'

            return command

    # For other installers, append silent flags
    command = uninstall_command.strip()

    # Remove any existing quotes around the entire command
    if command.startswith('"') and command.endswith('"'):
        command = command[1:-1]

    # Build final command
    if silent_flags:
        return f'{command} {silent_flags}'
    else:
        return command


def search_software_by_name(name_query: str) -> List[Dict[str, str]]:
    """
    Search for installed software by name (case-insensitive partial match).

    Args:
        name_query: Software name to search for

    Returns:
        List of matching software dictionaries
    """
    all_software = get_installed_software()
    query_lower = name_query.lower()

    matches = [
        software for software in all_software
        if query_lower in software['name'].lower()
    ]

    logging.info(f"Found {len(matches)} software packages matching '{name_query}'")
    return matches
