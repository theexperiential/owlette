"""Minimal win32profile stub for Linux agent-runner imports."""


def _unavailable(*_args, **_kwargs):
    raise NotImplementedError(
        "win32profile is unavailable in the Linux agent-runner container"
    )


CreateEnvironmentBlock = _unavailable
DestroyEnvironmentBlock = _unavailable
