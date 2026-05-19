"""Minimal win32event stub for Linux agent-runner imports."""

WAIT_OBJECT_0 = 0
WAIT_ABANDONED = 0x00000080
WAIT_TIMEOUT = 0x00000102
INFINITE = 0xFFFFFFFF


class _DummyHandle:
    pass


def CreateMutex(_security, _initial_owner, _name):
    return _DummyHandle()


def CreateEvent(_security, _manual_reset, _initial_state, _name):
    return _DummyHandle()


def WaitForSingleObject(_handle, _timeout):
    return WAIT_OBJECT_0


def ReleaseMutex(_handle):
    return None


def SetEvent(_handle):
    return None
