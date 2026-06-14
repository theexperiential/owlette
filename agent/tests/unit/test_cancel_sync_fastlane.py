"""Regression test for cancel_sync command-lane routing (OWL-06).

cancel_sync only sets a thread-safe cancellation Event, but it used to be
dispatched onto the single serialised slow-command worker — the same worker
that runs sync_pull synchronously. So a cancel issued during an active sync
queued *behind* the sync it was meant to stop and could not fire until that
sync finished. The fix puts cancel_sync on the fast (own-thread) lane.

_process_command is bound onto a tiny fake via the descriptor protocol so the
real routing logic runs without constructing a full FirebaseClient. threading
is patched so the assertion is deterministic (no real threads spawned).
firebase_client is imported lazily inside the helpers/tests (matching
test_display_manager.py) to avoid eagerly initializing the cryptography rust
bindings at collection time (PyO3 single-init ordering issue).
"""

from types import SimpleNamespace
from unittest.mock import MagicMock


def _make_client():
    from firebase_client import FirebaseClient
    svc = SimpleNamespace(
        _FAST_COMMAND_TYPES=FirebaseClient._FAST_COMMAND_TYPES,
        _execute_command=MagicMock(),
        _slow_command_queue=MagicMock(),
        _mark_command_failed=MagicMock(),
        logger=MagicMock(),
    )
    svc._process_command = FirebaseClient._process_command.__get__(svc, FirebaseClient)
    return svc


def _sync_pull_cmd():
    return {
        'type': 'sync_pull',
        'site_id': 'site-1',
        'roost_id': 'roost-1',
        'version_id': 'version-1',
        'version_url': 'https://example.invalid/version.json',
        'extract_root': 'C:\\tmp\\owlette-test',
    }


def test_cancel_sync_is_in_fast_set():
    from firebase_client import FirebaseClient
    assert 'cancel_sync' in FirebaseClient._FAST_COMMAND_TYPES


def test_cancel_sync_routes_to_fast_lane(monkeypatch):
    """OWL-06: cancel_sync runs on its own thread, never the slow queue."""
    import firebase_client
    thread = MagicMock()
    monkeypatch.setattr(firebase_client.threading, 'Thread', thread)
    svc = _make_client()

    svc._process_command('cid', {'type': 'cancel_sync'})

    thread.assert_called_once()                              # ran immediately on its own thread
    svc._slow_command_queue.put_nowait.assert_not_called()   # did NOT queue behind sync_pull


def test_sync_pull_stays_on_slow_lane(monkeypatch):
    """Contrast: heavy roost work remains serialised on the slow worker."""
    import firebase_client
    thread = MagicMock()
    monkeypatch.setattr(firebase_client.threading, 'Thread', thread)
    svc = _make_client()

    svc._process_command('cid', {'type': 'sync_pull'})

    thread.assert_not_called()
    svc._slow_command_queue.put_nowait.assert_called_once()


def test_sync_pull_registers_pending_cancel_before_slow_queue(monkeypatch):
    """OWL-31: cancel_sync can hit sync_pull while it is waiting in queue."""
    import sync_commands

    registered = []
    cancel_event = object()

    def fake_register(site_id, roost_id, version_id):
        registered.append((site_id, roost_id, version_id))
        return cancel_event

    monkeypatch.setattr(sync_commands, 'register_pending_sync', fake_register)
    svc = _make_client()
    cmd = _sync_pull_cmd()

    svc._process_command('cid', cmd)

    assert registered == [('site-1', 'roost-1', 'version-1')]
    svc._slow_command_queue.put_nowait.assert_called_once_with(('cid', cmd))


def test_sync_pull_discards_pending_cancel_when_slow_queue_full(monkeypatch):
    """If enqueue rejects the command, the setup cancel entry is released."""
    import queue
    import sync_commands

    cancel_event = object()
    discarded = []

    monkeypatch.setattr(
        sync_commands,
        'register_pending_sync',
        lambda site_id, roost_id, version_id: cancel_event,
    )
    monkeypatch.setattr(
        sync_commands,
        'discard_pending_sync',
        lambda site_id, roost_id, version_id, event=None: discarded.append(
            (site_id, roost_id, version_id, event)
        ),
    )
    svc = _make_client()
    svc._slow_command_queue.put_nowait.side_effect = queue.Full

    svc._process_command('cid', _sync_pull_cmd())

    assert discarded == [('site-1', 'roost-1', 'version-1', cancel_event)]
    svc._mark_command_failed.assert_called_once()
