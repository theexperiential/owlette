"""tests for sync_commands — handler registration + integration with CommandRouter."""

import pytest

from command_router import CommandRouter
from sync_commands import register_handlers


def test_register_handlers_registers_all_three():
    router = CommandRouter()
    register_handlers(router)
    types = router.registered_types()
    assert 'sync_pull' in types
    assert 'cancel_sync' in types
    assert 'rollback_to_version' in types


def test_handlers_registered_only_once_via_decorator():
    """re-registering on the same router raises (matches CommandRouter contract)."""
    router = CommandRouter()
    register_handlers(router)
    with pytest.raises(ValueError, match="already registered"):
        register_handlers(router)


def test_sync_pull_validates_required_fields():
    """missing required fields surface as ValueError from _require_str."""
    from sync_commands import _handle_sync_pull
    with pytest.raises(ValueError, match="site_id"):
        _handle_sync_pull({}, 'cmd-1', service=object())
    with pytest.raises(ValueError, match="roost_id"):
        _handle_sync_pull({'site_id': 's'}, 'cmd-1', service=object())
    with pytest.raises(ValueError, match="version_id"):
        _handle_sync_pull({'site_id': 's', 'roost_id': 'f'}, 'cmd-1', service=object())


def test_cancel_sync_returns_message_when_no_inflight():
    """cancel_sync gracefully reports when there's nothing to cancel."""
    from sync_commands import _handle_cancel_sync
    from sync_state import SyncState

    class FakeService:
        pass

    fake = FakeService()
    fake._sync_state = SyncState(':memory:')
    try:
        result = _handle_cancel_sync(
            {'site_id': 's', 'roost_id': 'f', 'version_id': 'm'},
            'cmd-1', fake,
        )
        assert 'no distribution' in result.lower()
    finally:
        fake._sync_state.close()


def test_sync_pull_reuses_pending_cancel_registered_before_handler():
    """A cancel set while sync_pull is queued is observed when handler starts."""
    from sync_commands import (
        _handle_cancel_sync,
        _handle_sync_pull,
        _setup_cancel_refcounts,
        _setup_cancels,
        discard_pending_sync,
        register_pending_sync,
    )

    class FakeService:
        firebase_client = None

    key = ('s', 'r', 'v')
    event = register_pending_sync(*key)
    try:
        cancel_result = _handle_cancel_sync(
            {'site_id': 's', 'roost_id': 'r', 'version_id': 'v'},
            'cancel-1',
            FakeService(),
        )
        assert 'pending sync' in cancel_result
        assert event.is_set()

        result = _handle_sync_pull(
            {
                'site_id': 's',
                'roost_id': 'r',
                'version_id': 'v',
                'version_url': 'https://example.invalid/version.json',
                'extract_root': 'C:\\tmp\\owlette-test',
            },
            'sync-1',
            FakeService(),
        )

        assert result == 'sync_pull cancelled before distribution start (accepted)'
        assert key not in _setup_cancels
        assert key not in _setup_cancel_refcounts
    finally:
        discard_pending_sync(*key, event)


# ─── chunk url provider wiring (batch contract) ─────────────────────


def test_chunk_url_provider_calls_firebase_client_with_batch():
    """provider passes a list of hashes through to firebase_client and returns the dict."""
    from unittest.mock import MagicMock
    from sync_commands import _make_chunk_url_provider

    class FakeService:
        pass

    fake = FakeService()
    fake.firebase_client = MagicMock()
    fake.firebase_client.get_chunk_download_urls.return_value = {
        'a' * 64: 'https://r2.example/aaa',
        'b' * 64: 'https://r2.example/bbb',
    }

    provider = _make_chunk_url_provider(fake, 'site_test')
    urls = provider(['a' * 64, 'b' * 64])
    assert urls == {
        'a' * 64: 'https://r2.example/aaa',
        'b' * 64: 'https://r2.example/bbb',
    }
    fake.firebase_client.get_chunk_download_urls.assert_called_once_with(
        ['a' * 64, 'b' * 64]
    )


def test_chunk_url_provider_with_empty_list_returns_empty_dict():
    """no hashes → no http call."""
    from unittest.mock import MagicMock
    from sync_commands import _make_chunk_url_provider

    class FakeService:
        pass

    fake = FakeService()
    fake.firebase_client = MagicMock()
    provider = _make_chunk_url_provider(fake, 'site_test')
    assert provider([]) == {}
    fake.firebase_client.get_chunk_download_urls.assert_not_called()


def test_chunk_url_provider_without_firebase_client_raises_clear_error():
    """when service.firebase_client is None (local-only mode), provider gives a clear error."""
    from sync_commands import _make_chunk_url_provider

    class FakeService:
        firebase_client = None

    provider = _make_chunk_url_provider(FakeService(), 'site_test')
    with pytest.raises(NotImplementedError, match="firebase_client"):
        provider(['a' * 64])
