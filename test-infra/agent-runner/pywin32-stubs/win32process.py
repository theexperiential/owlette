"""Minimal win32process stub for Linux agent-runner imports."""

STARTF_USESHOWWINDOW = 0x00000001


class Win32ProcessUnavailable(NotImplementedError):
    pass


class STARTUPINFO:
    def __init__(self):
        self.dwFlags = 0
        self.wShowWindow = 0
        self.lpDesktop = None


def _unavailable(*_args, **_kwargs):
    raise Win32ProcessUnavailable(
        "win32process is unavailable in the Linux agent-runner container"
    )


GetWindowThreadProcessId = _unavailable
GetCurrentProcess = _unavailable
CreateProcessAsUser = _unavailable
TerminateProcess = _unavailable
GetExitCodeProcess = _unavailable
