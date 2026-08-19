"""`tmp/service_status.json` — the service→desktop seam.

The desktop app never talks to the cloud: what the status footer and the tray
say about this machine's site comes entirely from the `firebase` section this
file publishes. That makes the section a contract, and these tests hold it —
particularly `site_name`, which is the operator-facing label ("TEC") the
surfaces prefer over the site id ("default_site").
"""

import json
from types import SimpleNamespace

import pytest

import owlette_service
from connection_manager import ConnectionState
from health_probe import HealthState


class FakeFirebaseClient:
    """Only the surface `_write_service_status` reads off the cloud client."""

    def __init__(self, connected=True, site_id='default_site', site_name=None):
        self.connected = connected
        self.site_id = site_id
        self.site_name = site_name
        self._last_heartbeat_time = 1_786_680_000

    def is_connected(self):
        return self.connected

    def write_health_to_firestore(self, status, error_code, message):
        """_update_health_state mirrors health to Firestore when connected."""


class FakeConnectionManager:
    """The two things `_wire_connection_status_listener` touches."""

    def __init__(self, state):
        self.state = state
        self.listeners = []

    def add_state_listener(self, listener):
        self.listeners.append(listener)


def make_service(tmp_path, monkeypatch, firebase_client=None, enabled=True):
    """An OwletteService with only the state `_write_service_status` touches."""
    service = object.__new__(owlette_service.OwletteService)
    service.firebase_client = firebase_client
    service._last_status_signature = None
    service._last_status_write_time = 0.0
    service._health_state = None

    root = tmp_path / 'tmp'
    monkeypatch.setattr(
        owlette_service.shared_utils, 'get_data_path',
        lambda rel: str(tmp_path / rel),
    )
    monkeypatch.setattr(
        owlette_service.shared_utils, 'read_config',
        lambda keys=None: enabled if keys == ['firebase', 'enabled'] else None,
    )
    return service, root / 'service_status.json'


def firebase_section(path):
    with open(path) as handle:
        return json.load(handle)['firebase']


@pytest.fixture(autouse=True)
def _quiet_status_writer(monkeypatch):
    """The writer's own audit log wants ProgramData; a null logger will do."""
    import logging
    monkeypatch.setattr(
        owlette_service, '_status_writer_logger',
        logging.getLogger('test.status_writer'), raising=False,
    )


class TestSiteName:
    def test_publishes_the_display_name_beside_the_id(self, tmp_path, monkeypatch):
        service, path = make_service(
            tmp_path, monkeypatch,
            FakeFirebaseClient(site_id='default_site', site_name='TEC'),
        )

        service._write_service_status()

        section = firebase_section(path)
        # Both, always: the name is what the operator reads, the id is what
        # every log line and support conversation is keyed on.
        assert section['site_name'] == 'TEC'
        assert section['site_id'] == 'default_site'

    def test_an_unknown_name_is_empty_not_missing(self, tmp_path, monkeypatch):
        # The desktop app falls back to the site id on an empty name. A missing
        # key would work too, but publishing it unconditionally means the shape
        # of the section never depends on what the cloud would say.
        service, path = make_service(
            tmp_path, monkeypatch, FakeFirebaseClient(site_name=None))

        service._write_service_status()

        assert firebase_section(path)['site_name'] == ''

    def test_an_unpaired_machine_names_no_site(self, tmp_path, monkeypatch):
        service, path = make_service(tmp_path, monkeypatch, None, enabled=False)

        service._write_service_status()

        section = firebase_section(path)
        assert section['site_id'] == ''
        assert section['site_name'] == ''
        assert section['enabled'] is False

    def test_a_rename_is_published_on_the_next_write_not_the_refresh_floor(
        self, tmp_path, monkeypatch
    ):
        # Writes are throttled by a content signature, so anything left out of
        # it is invisible for up to MIN_STATUS_WRITE_INTERVAL. A site renamed on
        # the dashboard reaches this machine on its next reconnect; it should
        # not then sit in the client for another half-minute.
        client = FakeFirebaseClient(site_name='TEC')
        service, path = make_service(tmp_path, monkeypatch, client)
        service._write_service_status()

        client.site_name = 'TEC — main floor'
        service._write_service_status()

        assert firebase_section(path)['site_name'] == 'TEC — main floor'

    def test_the_early_write_names_no_site_yet(self, tmp_path, monkeypatch):
        # Written before the cloud client exists, so it can only report the
        # shape. Claiming a site here would put a stale name on screen for the
        # whole of startup.
        service, path = make_service(tmp_path, monkeypatch, None)

        service._write_service_status_early()

        section = firebase_section(path)
        assert section['site_name'] == ''
        assert section['site_id'] == ''


def stale_network_error():
    """The verdict TEC-B4A's boot-time probe recorded seconds before DHCP
    finished — the snapshot that used to outlive the condition it described."""
    return HealthState(
        status='network_error',
        error_code='network_error',
        error_message='Network not reachable at startup (host: dev.owlette.app).',
        checked_at=1_786_680_000,
    )


def make_wired_service(tmp_path, monkeypatch, manager_state):
    """A service + fake client whose connection manager starts in `manager_state`."""
    client = FakeFirebaseClient()
    client.connection_manager = FakeConnectionManager(manager_state)
    service, path = make_service(tmp_path, monkeypatch, client)
    service._connection_status_manager = None
    service._health_state = stale_network_error()
    return service, client.connection_manager, path


def health_section(path):
    with open(path) as handle:
        return json.load(handle)['health']


class TestHealthClearsOnConnect:
    """The connect-clears-health seam (TEC-B4A regression, 2026-08-17).

    Health fields are snapshots — the boot-time probe, or the last outage.
    A live connection disproves them, and the connection status listener is
    the one place both hosting paths and every re-init converge, so that is
    where the clear lives. Without it the tray flashed red for the machine's
    whole uptime while `firebase.connected` sat true in the same document.
    """

    def test_wiring_against_an_already_connected_manager_clears_the_stale_error(
        self, tmp_path, monkeypatch
    ):
        # The constructor connects before anything is listening — by the time
        # the listener is wired, the CONNECTED transition has already happened.
        # This is exactly how the cold-boot probe error used to survive.
        service, _, path = make_wired_service(
            tmp_path, monkeypatch, ConnectionState.CONNECTED)

        service._wire_connection_status_listener()

        assert health_section(path)['status'] == 'ok'
        assert firebase_section(path)['connected'] is True

    def test_a_connected_transition_clears_the_outage_verdict(
        self, tmp_path, monkeypatch
    ):
        service, manager, path = make_wired_service(
            tmp_path, monkeypatch, ConnectionState.DISCONNECTED)
        service._wire_connection_status_listener()
        assert health_section(path)['status'] == 'network_error'

        manager.state = ConnectionState.CONNECTED
        for listener in manager.listeners:
            listener(SimpleNamespace(new_state=ConnectionState.CONNECTED))

        assert health_section(path)['status'] == 'ok'

    def test_a_disconnect_transition_leaves_the_error_standing(
        self, tmp_path, monkeypatch
    ):
        # Only a live connection is evidence. BACKOFF must not launder the
        # error the health callback just recorded.
        service, manager, path = make_wired_service(
            tmp_path, monkeypatch, ConnectionState.DISCONNECTED)
        service._wire_connection_status_listener()

        for listener in manager.listeners:
            listener(SimpleNamespace(new_state=ConnectionState.BACKOFF))

        assert health_section(path)['status'] == 'network_error'

    def test_wiring_while_disconnected_leaves_the_error_standing(
        self, tmp_path, monkeypatch
    ):
        # A re-init whose connect failed must keep its verdict — the old
        # unconditional clear after re-init stamped ok here regardless.
        service, _, path = make_wired_service(
            tmp_path, monkeypatch, ConnectionState.DISCONNECTED)

        service._wire_connection_status_listener()

        assert health_section(path)['status'] == 'network_error'
