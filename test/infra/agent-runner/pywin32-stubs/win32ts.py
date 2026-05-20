"""Minimal win32ts stub for Linux agent-runner imports."""


def _unavailable(*_args, **_kwargs):
    raise NotImplementedError(
        "win32ts is unavailable in the Linux agent-runner container"
    )


WTSGetActiveConsoleSessionId = _unavailable
WTSQueryUserToken = _unavailable
