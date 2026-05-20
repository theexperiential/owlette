"""Minimal win32security stub for Linux agent-runner imports."""

TOKEN_ADJUST_PRIVILEGES = 0x20
TOKEN_QUERY = 0x0008
TOKEN_DUPLICATE = 0x0002
TOKEN_ALL_ACCESS = 0xF01FF
SE_PRIVILEGE_ENABLED = 0x00000002
SecurityImpersonation = 2
TokenPrimary = 1
ACL_REVISION = 2
DACL_SECURITY_INFORMATION = 0x00000004
PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000


class Win32SecurityUnavailable(NotImplementedError):
    pass


def _unavailable(*_args, **_kwargs):
    raise Win32SecurityUnavailable(
        "win32security is unavailable in the Linux agent-runner container"
    )


ACL = _unavailable
LookupAccountName = _unavailable
GetFileSecurity = _unavailable
SetFileSecurity = _unavailable
OpenProcessToken = _unavailable
LookupPrivilegeValue = _unavailable
AdjustTokenPrivileges = _unavailable
DuplicateTokenEx = _unavailable
