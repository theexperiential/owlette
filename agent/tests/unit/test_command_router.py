"""
tests for command_router — the registry-based dispatcher introduced for
roost (project distribution v2).
"""

import pytest

from command_router import CommandRouter


def test_registers_handler_via_decorator():
    router = CommandRouter()

    @router.register('sync_pull')
    def handle_sync_pull(cmd_data, cmd_id, service):
        return 'ok'

    assert router.has_handler('sync_pull')
    assert router.registered_types() == ['sync_pull']


def test_registers_handler_via_register_fn():
    router = CommandRouter()

    def handler(cmd_data, cmd_id, service):
        return 'ok'

    router.register_fn('sync_pull', handler)
    assert router.has_handler('sync_pull')


def test_dispatch_calls_registered_handler():
    router = CommandRouter()
    seen = {}

    @router.register('test_cmd')
    def handle(cmd_data, cmd_id, service):
        seen['cmd_data'] = cmd_data
        seen['cmd_id'] = cmd_id
        seen['service'] = service
        return 'handler called'

    fake_service = object()
    result = router.dispatch(
        'test_cmd',
        {'type': 'test_cmd', 'foo': 'bar'},
        'cmd-123',
        fake_service,
    )

    assert result == 'handler called'
    assert seen['cmd_data']['foo'] == 'bar'
    assert seen['cmd_id'] == 'cmd-123'
    assert seen['service'] is fake_service


def test_dispatch_unknown_type_raises_keyerror():
    router = CommandRouter()
    with pytest.raises(KeyError, match="no handler registered"):
        router.dispatch('unknown_cmd', {}, 'cmd-1', None)


def test_has_handler_returns_false_for_unknown():
    router = CommandRouter()
    assert not router.has_handler('anything')


def test_duplicate_registration_via_decorator_raises():
    router = CommandRouter()

    @router.register('dup_cmd')
    def first(cmd_data, cmd_id, service):
        return '1'

    with pytest.raises(ValueError, match="already registered"):
        @router.register('dup_cmd')
        def second(cmd_data, cmd_id, service):
            return '2'


def test_duplicate_registration_via_register_fn_raises():
    router = CommandRouter()

    def first(cmd_data, cmd_id, service):
        return '1'

    def second(cmd_data, cmd_id, service):
        return '2'

    router.register_fn('dup_cmd', first)
    with pytest.raises(ValueError, match="already registered"):
        router.register_fn('dup_cmd', second)


def test_handler_exception_propagates_to_caller():
    """
    handler exceptions must NOT be swallowed by dispatch. caller
    (handle_firebase_command) wraps in its own try/except for uniform
    error handling — see owlette_service.py.
    """
    router = CommandRouter()

    @router.register('boom')
    def explode(cmd_data, cmd_id, service):
        raise RuntimeError('boom')

    with pytest.raises(RuntimeError, match="boom"):
        router.dispatch('boom', {}, 'cmd-1', None)


def test_registered_types_returns_sorted_list():
    router = CommandRouter()
    router.register_fn('zebra', lambda d, i, s: '')
    router.register_fn('apple', lambda d, i, s: '')
    router.register_fn('mango', lambda d, i, s: '')
    assert router.registered_types() == ['apple', 'mango', 'zebra']


def test_decorator_returns_wrapped_function():
    """decorator must return the original function so it remains callable."""
    router = CommandRouter()

    @router.register('test')
    def handle(cmd_data, cmd_id, service):
        return 'direct call works'

    # registered, AND directly callable
    assert handle({}, 'id', None) == 'direct call works'
    assert router.has_handler('test')


def test_handlers_isolated_between_router_instances():
    """each CommandRouter instance is independent."""
    router_a = CommandRouter()
    router_b = CommandRouter()

    router_a.register_fn('cmd', lambda d, i, s: 'a')
    router_b.register_fn('cmd', lambda d, i, s: 'b')

    assert router_a.dispatch('cmd', {}, 'id', None) == 'a'
    assert router_b.dispatch('cmd', {}, 'id', None) == 'b'
