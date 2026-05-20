"""Minimal winreg stub for Linux agent-runner imports.

This module only exists so modules that import Windows registry APIs at module
load can be imported in the Linux test container. Calls that require the real
Windows registry raise clearly.
"""


class WindowsRegistryUnavailable(NotImplementedError):
    pass


HKEY_CLASSES_ROOT = 0x80000000
HKEY_CURRENT_USER = 0x80000001
HKEY_LOCAL_MACHINE = 0x80000002
HKEY_USERS = 0x80000003
HKEY_CURRENT_CONFIG = 0x80000005

KEY_READ = 0x20019
KEY_WRITE = 0x20006
KEY_ALL_ACCESS = 0xF003F

REG_NONE = 0
REG_SZ = 1
REG_EXPAND_SZ = 2
REG_BINARY = 3
REG_DWORD = 4
REG_MULTI_SZ = 7


def _unavailable(*_args, **_kwargs):
    raise WindowsRegistryUnavailable(
        "winreg is unavailable in the Linux agent-runner container"
    )


OpenKey = _unavailable
CreateKey = _unavailable
QueryValueEx = _unavailable
SetValueEx = _unavailable
DeleteValue = _unavailable
EnumKey = _unavailable
EnumValue = _unavailable


def CloseKey(_key):
    return None
