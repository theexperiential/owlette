"""Regression tests for OwletteService._handle_cortex_process_command (OWL-03).

The Cortex Tier-2 process-control path used to pass the process *config dict*
to shared_utils.graceful_terminate(), which expects an integer PID. That raised
TypeError on every restart/kill/start, the broad except swallowed it into a
silent {'status': 'failed'}, and so Cortex Tier-2 / autonomous self-healing
never actually acted. These tests pin the contract: the handler resolves the
running PID from self.last_started and hands an *int* to the kill/relaunch
helpers — never the config dict.

The real method is bound onto a tiny fake via the descriptor protocol
(``OwletteService.<method>.__get__(fake, OwletteService)``) so the production
body runs against controlled attributes without constructing the full Windows
service. owlette_service is imported lazily inside the fixtures/tests (matching
test_display_manager.py) so module collection does not eagerly initialize the
cryptography rust bindings, whose PyO3 single-init trips on certain orderings.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


PROC = {'id': 'proc-1', 'name': 'TouchDesigner'}


def _make_service():
    from owlette_service import OwletteService
    svc = SimpleNamespace(
        last_started={},
        firebase_client=MagicMock(),
        kill_and_relaunch_process=MagicMock(return_value=4321),
        handle_process_launch=MagicMock(return_value=5678),
    )
    svc._handle_cortex_process_command = (
        OwletteService._handle_cortex_process_command.__get__(svc, OwletteService)
    )
    return svc


@pytest.fixture
def graceful_terminate(monkeypatch):
    """Patch the I/O boundary; yield the graceful_terminate spy."""
    import owlette_service
    monkeypatch.setattr(
        owlette_service.shared_utils, 'read_config',
        lambda *a, **k: {'processes': [PROC]},
    )
    gt = MagicMock(return_value=True)
    monkeypatch.setattr(owlette_service.shared_utils, 'graceful_terminate', gt)
    monkeypatch.setattr(
        owlette_service.shared_utils, 'update_process_status_in_json', MagicMock(),
    )
    monkeypatch.setattr(owlette_service.Util, 'is_pid_running', lambda pid: True)
    return gt


def test_kill_passes_int_pid_not_config_dict(graceful_terminate):
    """OWL-03: graceful_terminate must receive the int PID, never the dict."""
    svc = _make_service()
    svc.last_started = {'proc-1': {'pid': 1234}}

    result = svc._handle_cortex_process_command('kill_process', 'TouchDesigner')

    assert result['status'] == 'completed'
    graceful_terminate.assert_called_once_with(1234)
    # The regression guard: the arg is an int PID, not the process config dict.
    (called_arg,), _ = graceful_terminate.call_args
    assert isinstance(called_arg, int) and not isinstance(called_arg, dict)


def test_restart_running_process_relaunches_with_int_pid(graceful_terminate):
    svc = _make_service()
    svc.last_started = {'proc-1': {'pid': 1234}}

    result = svc._handle_cortex_process_command('restart_process', 'TouchDesigner')

    assert result['status'] == 'completed'
    svc.kill_and_relaunch_process.assert_called_once_with(1234, PROC)
    svc.handle_process_launch.assert_not_called()


def test_restart_when_not_running_launches(graceful_terminate, monkeypatch):
    import owlette_service
    monkeypatch.setattr(owlette_service.Util, 'is_pid_running', lambda pid: False)
    svc = _make_service()
    svc.last_started = {}  # no recorded pid

    result = svc._handle_cortex_process_command('restart_process', 'TouchDesigner')

    assert result['status'] == 'completed'
    svc.handle_process_launch.assert_called_once_with(PROC)
    svc.kill_and_relaunch_process.assert_not_called()


def test_kill_when_not_running_is_noop(graceful_terminate, monkeypatch):
    import owlette_service
    monkeypatch.setattr(owlette_service.Util, 'is_pid_running', lambda pid: False)
    svc = _make_service()
    svc.last_started = {'proc-1': {'pid': 1234}}

    result = svc._handle_cortex_process_command('kill_process', 'TouchDesigner')

    assert result['status'] == 'completed'
    assert 'not running' in result['result'].lower()
    graceful_terminate.assert_not_called()


def test_unknown_process_returns_error(graceful_terminate):
    svc = _make_service()
    result = svc._handle_cortex_process_command('kill_process', 'NoSuchProc')
    assert 'error' in result and 'not found' in result['error'].lower()
