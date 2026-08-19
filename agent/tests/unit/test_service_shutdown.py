"""Shutdown, presence flush and desktop-app lifetime.

Covers the three agent-side halves of the 2026-08-13 14:17 incident:

* the desktop app was a child of the service, so NSSM's process-tree kill took
  the operator's UI down with the service (`build_detached_launch_command`);
* NSSM's console Control-C never arrived, so nothing flushed `online: false`
  and nothing was logged (`graceful_shutdown` + the SCM stop watcher);

Both NSSM behaviours are gone in 3.0.0 — owlette-host terminates only the
process it launched, and signals a stop by reporting STOP_PENDING, which is
exactly what the watcher polls for. These assertions still hold the agent side
of the contract: they are what stops a future change from going back to relying
on a signal that may never arrive.
* the tray's connection badge lagged the real connection by ~25s because the
  status file was only rewritten by the main loop
  (`_wire_connection_status_listener`).
"""

import threading
import time

import pytest

import owlette_service
import shared_utils


# ─── the desktop app must not be in the service's process tree ──────────────

class TestDetachedLaunchCommand:
    def test_hands_off_through_cmd_so_the_parent_link_dies(self):
        command = shared_utils.build_detached_launch_command(
            r'C:\ProgramData\Owlette\app\owlette-desktop.exe', ('--tray',))

        # `cmd /c start` is the whole point: cmd exits immediately, so by the
        # time anything walks the tree the app has no live parent to be found
        # from.
        assert command.startswith('cmd.exe /c start ""')
        assert r'"C:\ProgramData\Owlette\app\owlette-desktop.exe"' in command
        assert command.endswith('"--tray"')

    def test_the_empty_title_comes_before_the_path(self):
        # Without it, `start` takes the quoted path for the window title and
        # opens a console instead of the app.
        command = shared_utils.build_detached_launch_command(r'C:\a b\app.exe')
        assert command == 'cmd.exe /c start "" "C:\\a b\\app.exe"'

    def test_a_spaced_path_stays_one_argument(self):
        command = shared_utils.build_detached_launch_command(
            r'C:\Program Files\Owlette\owlette-desktop.exe', ('--restart-prompt',))
        assert '"C:\\Program Files\\Owlette\\owlette-desktop.exe"' in command

    def test_every_argument_is_quoted_separately(self):
        command = shared_utils.build_detached_launch_command(
            r'C:\app.exe', ('--tray', '--other value'))
        assert command == 'cmd.exe /c start "" "C:\\app.exe" "--tray" "--other value"'

    def test_no_arguments_leaves_no_trailing_space(self):
        assert shared_utils.build_detached_launch_command(r'C:\app.exe') == (
            'cmd.exe /c start "" "C:\\app.exe"')


def test_the_service_no_longer_kills_the_desktop_app():
    # A stopped service with no UI is unrecoverable from the machine itself:
    # starting it again is a button in the desktop app's footer.
    assert not hasattr(owlette_service.OwletteService, 'terminate_tray_icon')


# ─── graceful shutdown ──────────────────────────────────────────────────────

class FakeFirebaseClient:
    """Records what a shutdown asked of the cloud client."""

    def __init__(self, fail_log=False, fail_stop=False):
        self.events = []
        self.stop_calls = []
        self.connected = True
        self._fail_log = fail_log
        self._fail_stop = fail_stop

    def log_event(self, action, level, details=None):
        if self._fail_log:
            raise RuntimeError('firestore unreachable')
        self.events.append(action)

    def is_connected(self):
        return self.connected

    def stop(self, intentional=False):
        if self._fail_stop:
            raise RuntimeError('teardown blew up')
        self.stop_calls.append(intentional)


def make_service(firebase_client=None):
    """An OwletteService with only the shutdown state __init__ would set."""
    service = object.__new__(owlette_service.OwletteService)
    service.is_alive = True
    service.firebase_client = firebase_client
    service._shutdown_lock = threading.Lock()
    service._shutdown_trigger = None
    service._connection_status_manager = None
    service._last_status_signature = None
    service._last_status_write_time = 0.0
    service._status_writes = []
    service._write_service_status = lambda running=True: service._status_writes.append(running)
    return service


class TestGracefulShutdown:
    def test_flushes_presence_and_logs_the_stop(self):
        client = FakeFirebaseClient()
        service = make_service(client)

        assert service.graceful_shutdown('scm_stop') is True

        # `intentional=False` is the flag that actually writes `online: false`;
        # an intentional stop deliberately leaves presence alone.
        assert client.stop_calls == [False]
        assert client.events == ['agent_stopped']
        assert service.is_alive is False
        assert service._status_writes == [False]

    def test_runs_once_however_many_triggers_fire(self):
        client = FakeFirebaseClient()
        service = make_service(client)

        assert service.graceful_shutdown('console_sigint') is True
        assert service.graceful_shutdown('scm_stop') is False
        assert service.graceful_shutdown('svc_stop') is False

        # The two triggers exist to cover each other, not to double up: one
        # agent_stopped event, one offline write.
        assert client.events == ['agent_stopped']
        assert client.stop_calls == [False]
        assert service._shutdown_trigger == 'console_sigint'

    def test_concurrent_triggers_still_shut_down_exactly_once(self):
        # The console handler runs on a thread Windows injects while the SCM
        # watcher is on its own — they really can arrive together.
        client = FakeFirebaseClient()
        service = make_service(client)
        results = []
        start = threading.Event()

        def trigger(name):
            start.wait()
            results.append(service.graceful_shutdown(name))

        threads = [
            threading.Thread(target=trigger, args=(f'trigger_{i}',))
            for i in range(8)
        ]
        for thread in threads:
            thread.start()
        start.set()
        for thread in threads:
            thread.join(timeout=5)

        assert sorted(results) == [False] * 7 + [True]
        assert client.events == ['agent_stopped']
        assert client.stop_calls == [False]

    def test_a_failed_event_log_still_flushes_presence(self):
        # Losing the audit line is survivable; leaving the machine reading
        # online forever is what put a stale machine on the dashboard.
        client = FakeFirebaseClient(fail_log=True)
        service = make_service(client)

        assert service.graceful_shutdown('scm_stop') is True
        assert client.stop_calls == [False]

    def test_a_failed_teardown_still_writes_the_final_status(self):
        client = FakeFirebaseClient(fail_stop=True)
        service = make_service(client)

        assert service.graceful_shutdown('scm_stop') is True
        assert service._status_writes == [False]

    def test_survives_having_no_cloud_client(self):
        service = make_service(None)

        assert service.graceful_shutdown('scm_stop') is True
        assert service.is_alive is False
        assert service._status_writes == [False]


# ─── the SCM stop watcher ───────────────────────────────────────────────────

class TestScmStopWatcher:
    def test_reads_the_live_service_without_elevation(self):
        # The watcher runs as LocalSystem in production, but SERVICE_QUERY_STATUS
        # is readable unelevated — if this ever needs rights the agent does not
        # have, the watcher silently never fires.
        service = object.__new__(owlette_service.OwletteService)
        assert service._query_scm_stop_requested() in (True, False)

    def test_fires_graceful_shutdown_when_the_scm_reports_stopping(self, monkeypatch):
        client = FakeFirebaseClient()
        service = make_service(client)
        monkeypatch.setattr(owlette_service, 'SCM_STOP_POLL_INTERVAL', 0.01)

        polls = []

        def fake_query(_self=None):
            polls.append(1)
            return len(polls) >= 3

        service._query_scm_stop_requested = fake_query
        thread = service.start_scm_stop_watcher()
        thread.join(timeout=5)

        assert not thread.is_alive()
        assert service._shutdown_trigger == 'scm_stop'
        assert client.stop_calls == [False]

    def test_does_not_fire_while_the_service_is_running(self, monkeypatch):
        client = FakeFirebaseClient()
        service = make_service(client)
        monkeypatch.setattr(owlette_service, 'SCM_STOP_POLL_INTERVAL', 0.01)

        service._query_scm_stop_requested = lambda: False
        thread = service.start_scm_stop_watcher()
        time.sleep(0.1)
        service.is_alive = False
        thread.join(timeout=5)

        assert service._shutdown_trigger is None
        assert client.stop_calls == []

    def test_gives_up_rather_than_spinning_when_the_scm_cannot_be_read(self, monkeypatch):
        service = make_service(FakeFirebaseClient())
        monkeypatch.setattr(owlette_service, 'SCM_STOP_POLL_INTERVAL', 0.001)

        attempts = []

        def always_raises():
            attempts.append(1)
            raise OSError('the SCM is not reachable')

        service._query_scm_stop_requested = always_raises
        thread = service.start_scm_stop_watcher()
        thread.join(timeout=5)

        assert not thread.is_alive()
        assert len(attempts) == 10
        assert service._shutdown_trigger is None

    def test_the_poll_interval_fits_inside_the_hosts_kill_budget(self):
        # owlette-host terminates the agent CHILD_STOP_GRACE (20s) after the
        # stop control; NSSM did it at ~4.5s. A poll slower than the budget
        # would notice the stop only after the process was already gone.
        assert owlette_service.SCM_STOP_POLL_INTERVAL < owlette_service.SCM_STOP_GRACE_SECONDS
        assert owlette_service.SCM_STOP_POLL_INTERVAL <= 0.5


# ─── the tray's connection badge ────────────────────────────────────────────

class FakeConnectionManager:
    def __init__(self):
        self.listeners = []

    def add_state_listener(self, listener):
        self.listeners.append(listener)


class TestConnectionStatusListener:
    def test_publishes_the_state_the_client_already_reached(self):
        # CONNECTING -> CONNECTED happens inside FirebaseClient.__init__, before
        # anything is listening; without this write the tray shows a red badge
        # until the first main-loop status write.
        service = make_service(FakeFirebaseClient())
        service.firebase_client.connection_manager = FakeConnectionManager()

        service._wire_connection_status_listener()

        assert service._status_writes == [True]
        assert len(service.firebase_client.connection_manager.listeners) == 1

    def test_every_later_transition_rewrites_the_file(self):
        service = make_service(FakeFirebaseClient())
        manager = FakeConnectionManager()
        service.firebase_client.connection_manager = manager

        service._wire_connection_status_listener()
        service._status_writes.clear()

        # A disconnect has to turn the badge red as fast as a connect turns it
        # green — the listener is not connect-only.
        manager.listeners[0](object())
        manager.listeners[0](object())

        assert service._status_writes == [True, True]

    def test_registering_twice_does_not_stack_listeners(self):
        service = make_service(FakeFirebaseClient())
        manager = FakeConnectionManager()
        service.firebase_client.connection_manager = manager

        service._wire_connection_status_listener()
        service._wire_connection_status_listener()

        assert len(manager.listeners) == 1
        # ...but the state is republished each time, which is what makes the
        # call safe to repeat from the runner, main() and a Firebase re-init.
        assert service._status_writes == [True, True]

    def test_a_replaced_client_gets_its_own_listener(self):
        service = make_service(FakeFirebaseClient())
        first = FakeConnectionManager()
        service.firebase_client.connection_manager = first
        service._wire_connection_status_listener()

        # _initialize_firebase_client builds a whole new client; the listener
        # has to follow it or the badge freezes on the old one's last state.
        service.firebase_client = FakeFirebaseClient()
        second = FakeConnectionManager()
        service.firebase_client.connection_manager = second
        service._wire_connection_status_listener()

        assert len(first.listeners) == 1
        assert len(second.listeners) == 1

    def test_does_nothing_without_a_cloud_client(self):
        service = make_service(None)
        service._wire_connection_status_listener()
        assert service._status_writes == []


@pytest.mark.parametrize('attribute', [
    '_shutdown_lock',
    '_shutdown_trigger',
    '_connection_status_manager',
])
def test_mockservice_mirrors_every_new_attribute(attribute):
    """owlette_runner.MockService must carry everything OwletteService.__init__
    sets, or the hosted path raises AttributeError in production."""
    import pathlib
    source = pathlib.Path(owlette_service.__file__).with_name('owlette_runner.py')
    assert f'self.{attribute}' in source.read_text(encoding='utf-8'), (
        f'{attribute} is missing from MockService.__init__'
    )
