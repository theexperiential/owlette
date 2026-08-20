"""Query the Windows Registry for installed software and uninstall info."""

import logging
import winreg
import re
from typing import List, Dict, Optional


def get_installed_software() -> List[Dict[str, str]]:
    """
    Installed software from the 64-bit, 32-bit and per-user uninstall keys.

    Each dict: name, version, publisher, install_location, uninstall_command,
    installer_type (inno | nsis | msi | custom).
    """
    software_list = []

    registry_paths = [
        # 64-bit, 32-bit (WOW6432Node), then per-user.
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]

    for hkey, registry_path in registry_paths:
        try:
            software_list.extend(_query_registry_path(hkey, registry_path))
        except Exception as e:
            logging.warning(f"Failed to query registry path {registry_path}: {e}")

    # The same package can appear under several hives.
    unique_software = _remove_duplicates(software_list)

    logging.info(f"Found {len(unique_software)} installed software packages")
    return unique_software


def _query_registry_path(hkey: int, registry_path: str) -> List[Dict[str, str]]:
    """Query one hive+path for installed software."""
    software_list = []

    try:
        with winreg.OpenKey(hkey, registry_path) as key:
            # One subkey per software package.
            index = 0
            while True:
                try:
                    subkey_name = winreg.EnumKey(key, index)
                    index += 1

                    with winreg.OpenKey(key, subkey_name) as subkey:
                        software_info = _extract_software_info(subkey, subkey_name)

                        if software_info and software_info.get('name') and software_info.get('uninstall_command'):
                            software_list.append(software_info)

                except OSError:
                    break
                except Exception as e:
                    logging.debug(f"Error reading registry subkey {subkey_name}: {e}")
                    continue

    except FileNotFoundError:
        logging.debug(f"Registry path not found: {registry_path}")
    except Exception as e:
        logging.error(f"Error querying registry path {registry_path}: {e}")

    return software_list


def _extract_software_info(subkey, subkey_name: str) -> Optional[Dict[str, str]]:
    """Software info from one registry subkey, or None if unusable."""
    try:
        display_name = _read_registry_value(subkey, "DisplayName")

        # Skip system components and updates
        if not display_name or _is_system_component(subkey, display_name):
            return None

        uninstall_string = _read_registry_value(subkey, "UninstallString")
        if not uninstall_string:
            return None

        version = _read_registry_value(subkey, "DisplayVersion") or ""
        publisher = _read_registry_value(subkey, "Publisher") or ""
        install_location = _read_registry_value(subkey, "InstallLocation") or ""

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
    """Read one registry value as str, or None if absent/unreadable."""
    try:
        value, _ = winreg.QueryValueEx(key, value_name)
        return str(value) if value else None
    except FileNotFoundError:
        return None
    except Exception:
        return None


def _is_system_component(subkey, display_name: str) -> bool:
    """Whether this entry is a system component that must not be uninstalled."""
    # Check SystemComponent flag
    try:
        system_component, _ = winreg.QueryValueEx(subkey, "SystemComponent")
        if system_component == 1:
            return True
    except:
        pass

    # ParentKeyName marks an update/component.
    try:
        parent_key, _ = winreg.QueryValueEx(subkey, "ParentKeyName")
        if parent_key:
            return True
    except:
        pass

    if display_name.startswith("Security Update") or \
       display_name.startswith("Update for") or \
       display_name.startswith("Hotfix for") or \
       "KB" in display_name and len(display_name) < 30:
        return True

    return False


def _remove_duplicates(software_list: List[Dict[str, str]]) -> List[Dict[str, str]]:
    """Deduplicate entries by (name, version)."""
    seen = set()
    unique_software = []

    for software in software_list:
        key = (software['name'].lower(), software['version'].lower())

        if key not in seen:
            seen.add(key)
            unique_software.append(software)

    return unique_software


def detect_installer_type(uninstall_command: str) -> str:
    """Installer type from the uninstall command: inno | nsis | msi | custom."""
    command_lower = uninstall_command.lower()

    # Inno: the NUMBERED "unins000.exe" specifically — a generic "Uninstall.exe"
    # is not Inno.
    if re.search(r'unins\d+\.exe', command_lower) or 'inno' in command_lower:
        return 'inno'

    if 'uninst' in command_lower or 'uninstall' in command_lower or 'nsis' in command_lower:
        return 'nsis'

    if 'msiexec' in command_lower or '.msi' in command_lower:
        return 'msi'

    return 'custom'


def get_silent_uninstall_flags(installer_type: str) -> str:
    """Silent uninstall flags for an installer type; '' for custom."""
    flags_map = {
        'inno': '/VERYSILENT /NORESTART /SUPPRESSMSGBOXES /FORCECLOSEAPPLICATIONS',
        'nsis': '/S',
        'msi': '/quiet /norestart',
        'custom': ''  # No standard flags for custom installers
    }

    return flags_map.get(installer_type, '')


def build_silent_uninstall_command(uninstall_command: str, installer_type: str) -> str:
    """The registry uninstall command rewritten to run silently."""
    silent_flags = get_silent_uninstall_flags(installer_type)

    # MSI already carries msiexec flags: swap /I (install) for /X (uninstall).
    if installer_type == 'msi':
        if 'msiexec' in uninstall_command.lower():
            command = re.sub(r'/I\b', '/X', uninstall_command, flags=re.IGNORECASE)

            if '/quiet' not in command.lower() and '/qn' not in command.lower():
                command += f' {silent_flags}'

            return command

    command = uninstall_command.strip()

    if command.startswith('"') and command.endswith('"'):
        command = command[1:-1]

    if silent_flags:
        return f'{command} {silent_flags}'
    else:
        return command


def search_software_by_name(name_query: str) -> List[Dict[str, str]]:
    """Installed software matching `name_query` (case-insensitive substring)."""
    all_software = get_installed_software()
    query_lower = name_query.lower()

    matches = [
        software for software in all_software
        if query_lower in software['name'].lower()
    ]

    logging.info(f"Found {len(matches)} software packages matching '{name_query}'")
    return matches
