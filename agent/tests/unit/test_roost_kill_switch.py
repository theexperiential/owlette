"""tests for roost_kill_switch — per-site v2 kill switch (wave 5.4)."""

import pytest

import roost_kill_switch
from roost_kill_switch import (
    ROOST_ENABLED_FIELD,
    check_enabled,
    invalidate_cache,
    is_enabled_from_doc,
)


@pytest.fixture(autouse=True)
def _clear_cache_between_tests():
    invalidate_cache()
    yield
    invalidate_cache()


# ─── is_enabled_from_doc (pure) ─────────────────────────────────────


def test_missing_doc_is_enabled_failopen():
    assert is_enabled_from_doc(None) is True


def test_non_dict_doc_is_enabled_failopen():
    assert is_enabled_from_doc('oops') is True
    assert is_enabled_from_doc(42) is True


def test_doc_without_field_is_enabled_default():
    assert is_enabled_from_doc({'some_other_field': 1}) is True


def test_explicit_false_disables():
    assert is_enabled_from_doc({ROOST_ENABLED_FIELD: False}) is False


def test_explicit_true_enables():
    assert is_enabled_from_doc({ROOST_ENABLED_FIELD: True}) is True


def test_non_bool_value_is_enabled_failopen():
    # migration glitch / type confusion — we don't trust a string "false"
    # as disabled, and we don't trust a 0 as disabled either. only explicit
    # boolean False flips the switch.
    assert is_enabled_from_doc({ROOST_ENABLED_FIELD: 'false'}) is True
    assert is_enabled_from_doc({ROOST_ENABLED_FIELD: 0}) is True
    assert is_enabled_from_doc({ROOST_ENABLED_FIELD: None}) is True


# ─── check_enabled (cache + reader injection) ──────────────────────


class _FakeReader:
    """minimal site-doc reader for test injection."""

    def __init__(self, docs=None):
        self.docs = docs or {}
        self.calls = 0

    def get_site_doc(self, site_id):
        self.calls += 1
        return self.docs.get(site_id)


class _ErrorReader:
    def get_site_doc(self, site_id):
        raise RuntimeError('network is out')


def test_check_returns_true_when_no_doc():
    reader = _FakeReader()
    assert check_enabled('site-a', reader, now_fn=lambda: 0.0) is True


def test_check_returns_false_when_disabled():
    reader = _FakeReader({'site-a': {ROOST_ENABLED_FIELD: False}})
    assert check_enabled('site-a', reader, now_fn=lambda: 0.0) is False


def test_check_returns_true_on_reader_exception_failopen():
    reader = _ErrorReader()
    # must NOT raise; must return True.
    assert check_enabled('site-a', reader, now_fn=lambda: 0.0) is True


def test_reader_error_is_not_cached_retries_on_next_call():
    reader = _ErrorReader()
    assert check_enabled('site-a', reader, now_fn=lambda: 0.0) is True
    # a second call should attempt the read again (the error path doesn't
    # cache). we can't observe reader.calls here since _ErrorReader has no
    # counter — add one.
    class CountingErrorReader:
        def __init__(self):
            self.calls = 0
        def get_site_doc(self, site_id):
            self.calls += 1
            raise RuntimeError('flaky')
    counter = CountingErrorReader()
    assert check_enabled('site-b', counter, now_fn=lambda: 0.0) is True
    assert check_enabled('site-b', counter, now_fn=lambda: 0.5) is True
    assert counter.calls == 2  # both attempted, neither cached


def test_successful_read_is_cached_within_ttl():
    reader = _FakeReader({'site-a': {ROOST_ENABLED_FIELD: False}})
    # first call reads
    assert check_enabled('site-a', reader, now_fn=lambda: 100.0) is False
    assert reader.calls == 1
    # second call within TTL (30s) hits the cache
    assert check_enabled('site-a', reader, now_fn=lambda: 120.0) is False
    assert reader.calls == 1
    # third call past TTL re-reads
    assert check_enabled('site-a', reader, now_fn=lambda: 140.0) is False
    assert reader.calls == 2


def test_different_site_invalidates_cache_entry():
    # the cache is a single-entry cache keyed by site; switching sites
    # must re-read.
    reader = _FakeReader({
        'site-a': {ROOST_ENABLED_FIELD: True},
        'site-b': {ROOST_ENABLED_FIELD: False},
    })
    assert check_enabled('site-a', reader, now_fn=lambda: 0.0) is True
    assert check_enabled('site-b', reader, now_fn=lambda: 1.0) is False
    assert reader.calls == 2


def test_admin_flip_propagates_within_ttl_window():
    """
    regression for the "within 60s" acceptance:
      - flag starts True (enabled, cached)
      - admin flips to False in firestore
      - after the 30s cache TTL, the next check reads the new value
    """
    docs = {'site-a': {ROOST_ENABLED_FIELD: True}}
    reader = _FakeReader(docs)
    # initial state: enabled, value cached at t=100
    assert check_enabled('site-a', reader, now_fn=lambda: 100.0) is True
    # admin flips at t=105
    docs['site-a'] = {ROOST_ENABLED_FIELD: False}
    # within cache TTL (t=125, still within 30s) — stale True persists
    assert check_enabled('site-a', reader, now_fn=lambda: 125.0) is True
    # past cache TTL (t=135 > 100 + 30) — re-read sees the new False
    assert check_enabled('site-a', reader, now_fn=lambda: 135.0) is False


def test_invalidate_cache_forces_reread():
    reader = _FakeReader({'site-a': {ROOST_ENABLED_FIELD: True}})
    check_enabled('site-a', reader, now_fn=lambda: 0.0)
    assert reader.calls == 1
    invalidate_cache()
    check_enabled('site-a', reader, now_fn=lambda: 0.0)
    assert reader.calls == 2


# ─── constants stability (contract with web/lib/roostKillSwitch.ts) ─


def test_field_name_is_stable():
    # if this ever changes, the web-side mirror file must change together.
    # pinning the name here means a refactor breaks this test loudly.
    assert ROOST_ENABLED_FIELD == 'roostEnabled'
