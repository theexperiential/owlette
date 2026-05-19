"""Minimal win32gui stub for Linux agent-runner imports."""


class Win32GuiUnavailable(NotImplementedError):
    pass


def _unavailable(*_args, **_kwargs):
    raise Win32GuiUnavailable(
        "win32gui is unavailable in the Linux agent-runner container"
    )


EnumWindows = _unavailable
FindWindow = _unavailable
IsWindowVisible = _unavailable
PostMessage = _unavailable
SetForegroundWindow = _unavailable
ShowWindow = _unavailable
