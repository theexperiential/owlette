"""Minimal win32serviceutil stub for Linux agent-runner imports."""


class ServiceFramework:
    def __init__(self, *_args, **_kwargs):
        raise NotImplementedError(
            "Windows services cannot run in the Linux agent-runner container"
        )


def _unavailable(*_args, **_kwargs):
    raise NotImplementedError(
        "win32serviceutil is unavailable in the Linux agent-runner container"
    )


HandleCommandLine = _unavailable
QueryServiceStatus = _unavailable
StartService = _unavailable
StopService = _unavailable
RestartService = _unavailable
ControlService = _unavailable
