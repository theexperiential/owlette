"""Minimal win32api stub for Linux agent-runner imports."""


def _unavailable(*_args, **_kwargs):
    raise NotImplementedError(
        "win32api is unavailable in the Linux agent-runner container"
    )


SetConsoleCtrlHandler = _unavailable
GetCurrentProcess = _unavailable
CloseHandle = _unavailable
