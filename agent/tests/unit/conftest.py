"""
unit-test fixtures.

`_neutralize_harden_acl` no-ops sync_assembler._harden_acl by default so unit
tests can read back assembled files without elevation. tests that explicitly
verify ACL-hardening behavior should patch _harden_acl themselves inside the
test (the autouse here is overridden cleanly by inner patches).

without this fixture, post-Wave-4b ACL hardening (SYSTEM + Administrators
only DACL) makes assembled tmp files unreadable by the non-elevated test
runner, breaking ~15 unrelated assembler tests.
"""

import pytest


@pytest.fixture(autouse=True)
def _neutralize_harden_acl(monkeypatch):
    """make _harden_acl a no-op for the duration of each unit test."""
    try:
        import sync_assembler
        monkeypatch.setattr(sync_assembler, '_harden_acl', lambda _path: None)
    except ImportError:
        pass
    yield
