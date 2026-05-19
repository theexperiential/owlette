"""Minimal win32service stub for Linux agent-runner imports."""

SERVICE_STOPPED = 1
SERVICE_START_PENDING = 2
SERVICE_STOP_PENDING = 3
SERVICE_RUNNING = 4
SERVICE_CONTINUE_PENDING = 5
SERVICE_PAUSE_PENDING = 6
SERVICE_PAUSED = 7

SERVICE_CONTROL_PAUSE = 2
SERVICE_CONTROL_CONTINUE = 3
SERVICE_AUTO_START = 2
SERVICE_BOOT_START = 0
SERVICE_DEMAND_START = 3
SERVICE_DISABLED = 4
SERVICE_SYSTEM_START = 1
SERVICE_QUERY_CONFIG = 0x0001
SC_MANAGER_CONNECT = 0x0001


class Win32ServiceUnavailable(NotImplementedError):
    pass


def _unavailable(*_args, **_kwargs):
    raise Win32ServiceUnavailable(
        "win32service is unavailable in the Linux agent-runner container"
    )


OpenSCManager = _unavailable
OpenService = _unavailable
QueryServiceConfig = _unavailable
CloseServiceHandle = _unavailable
