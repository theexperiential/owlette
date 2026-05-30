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
