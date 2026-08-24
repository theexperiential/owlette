"""tests for config_sync — the three-way startup reconciliation decision.

the incident these guard: since 3.0.0 removed the Tkinter GUI, nothing uploaded
locally-originated config edits, and startup sync was unconditionally
remote-wins. a local edit made while the cloud sat still was reverted on the
next service start. test_local_edit_with_still_cloud_is_pushed is the incident
scenario — it must fail against remote-wins semantics.
"""

import config_sync
from config_sync import decide_startup_sync


def _config(processes=None, **extra):
    cfg = {'processes': processes if processes is not None else []}
    cfg.update(extra)
    return cfg


def _process(pid, name, launch_mode='always'):
    return {'id': pid, 'name': name, 'launch_mode': launch_mode}


TOUCH = _process('p1', 'touch 2110')
TOUCH_OFF = _process('p1', 'touch 2110', launch_mode='off')
RESOLUME = _process('p2', 'resolume')


def test_no_remote_document_seeds():
    action, conflict = decide_startup_sync(None, _config([TOUCH]), None)
    assert action == 'seed'
    assert conflict is None


def test_remote_without_processes_seeds():
    """a doc that exists but has never held processes is not a source of truth."""
    action, _ = decide_startup_sync(None, _config([TOUCH]), {'displays': {'enabled': True}})
    assert action == 'seed'


def test_identical_configs_are_in_sync():
    base = _config([TOUCH])
    action, conflict = decide_startup_sync(base, _config([TOUCH]), _config([TOUCH]))
    assert action == 'in_sync'
    assert conflict is None


def test_local_only_keys_never_count_as_a_difference():
    """firebase/sentry/environment live only on the machine; remote never has them."""
    local = _config([TOUCH], firebase={'enabled': True, 'site_id': 's1'},
                    sentry={'dsn': 'x'}, environment='dev')
    action, _ = decide_startup_sync(_config([TOUCH]), local, _config([TOUCH]))
    assert action == 'in_sync'


def test_local_edit_with_still_cloud_is_pushed():
    """THE INCIDENT: cloud has not moved since the last sync, local has.

    old behaviour (remote exists -> pull) reverted the operator's edit here.
    """
    base = _config([TOUCH])
    remote = _config([TOUCH])
    local = _config([TOUCH_OFF])

    action, conflict = decide_startup_sync(base, local, remote)

    assert action == 'push'
    assert conflict is None


def test_added_process_locally_is_pushed():
    base = _config([TOUCH])
    action, _ = decide_startup_sync(base, _config([TOUCH, RESOLUME]), _config([TOUCH]))
    assert action == 'push'


def test_remote_edit_with_still_local_is_pulled():
    base = _config([TOUCH])
    action, conflict = decide_startup_sync(base, _config([TOUCH]), _config([TOUCH_OFF]))
    assert action == 'pull'
    assert conflict is None


def test_both_moved_pulls_and_names_what_it_discards():
    base = _config([TOUCH])
    local = _config([TOUCH_OFF, RESOLUME], rebootSchedule={'entries': ['02:00']})
    remote = _config([_process('p1', 'touch 2110', launch_mode='scheduled')])

    action, conflict = decide_startup_sync(base, local, remote)

    assert action == 'pull'
    assert 'processes: touch 2110, resolume' in conflict
    assert 'rebootSchedule' in conflict


def test_fresh_install_without_a_base_pulls_as_a_conflict():
    """no cache to compare against — cloud wins, but the loss is named."""
    action, conflict = decide_startup_sync(None, _config([TOUCH_OFF]), _config([TOUCH]))
    assert action == 'pull'
    assert conflict is not None
    assert 'touch 2110' in conflict


def test_fresh_install_matching_cloud_is_in_sync():
    action, conflict = decide_startup_sync(None, _config([TOUCH]), _config([TOUCH]))
    assert action == 'in_sync'
    assert conflict is None


def test_remote_only_fields_do_not_look_like_a_local_edit():
    """merge:true leaves the post-write doc a superset; a field only the cloud
    has still means the cloud moved, so it pulls rather than pushing over it."""
    base = _config([TOUCH])
    remote = _config([TOUCH], displays={'autoRestore': {'circuitBreaker': {'failures': 1}}})
    action, conflict = decide_startup_sync(base, _config([TOUCH]), remote)
    assert action == 'pull'
    assert conflict is None


# the auto-restore circuit breaker round-trips through config.json, so the agent
# mirrors its own breaker writes to disk and cache. that is the shape production
# is in after any breaker update — it must read as in_sync, not as a local edit.

CIRCUIT_BREAKER = {'displays': {'autoRestore': {'circuitBreaker': {'failures': 2}}}}


def test_a_mirrored_circuit_breaker_write_is_in_sync():
    breaker = _config([TOUCH], **CIRCUIT_BREAKER)
    action, conflict = decide_startup_sync(breaker, breaker, breaker)
    assert action == 'in_sync'
    assert conflict is None


def test_the_circuit_breaker_is_not_treated_as_server_owned():
    """The agent owns the breaker; it has to keep syncing or the count resets."""
    payload = config_sync.normalize(_config([TOUCH], **CIRCUIT_BREAKER))
    assert payload['displays']['autoRestore']['circuitBreaker'] == {'failures': 2}


# server-owned timestamps: written by the web as Firestore server timestamps,
# they come back to the agent as ISO strings and must never be re-uploaded.

def _with_server_fields(captured_at, enabled_at):
    return _config([TOUCH], displays={
        'assigned': {'layoutId': 'L1', 'capturedAt': captured_at},
        'autoRestore': {'enabled': True, 'enabledAt': enabled_at},
    })


def test_a_doc_differing_only_in_server_owned_fields_is_in_sync():
    base = _with_server_fields('2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')
    local = _with_server_fields('2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')
    remote = _with_server_fields('2026-08-19T12:00:00Z', '2026-08-19T12:00:00Z')

    action, conflict = decide_startup_sync(base, local, remote)

    assert action == 'in_sync'
    assert conflict is None


def test_push_payloads_omit_server_owned_fields():
    payload = config_sync.normalize(
        _with_server_fields('2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'))

    assert 'capturedAt' not in payload['displays']['assigned']
    assert 'enabledAt' not in payload['displays']['autoRestore']
    # siblings on the same branches survive
    assert payload['displays']['assigned']['layoutId'] == 'L1'
    assert payload['displays']['autoRestore']['enabled'] is True


def test_a_branch_holding_only_a_server_field_matches_its_absence():
    """Otherwise the strip itself manufactures a difference that never settles."""
    only_timestamp = _config([TOUCH], displays={'assigned': {'capturedAt': 'X'}})
    assert config_sync.configs_equal(only_timestamp, _config([TOUCH]))


def test_normalize_does_not_mutate_its_input():
    local = _with_server_fields('2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')
    config_sync.normalize(local)
    assert local['displays']['assigned']['capturedAt'] == '2026-08-01T00:00:00Z'


# push retry pacing: a permanently failing push (a rules denial, say) must not
# retry on every 5s tick forever, each attempt reporting an error upstream.

class TestPushBackoff:
    def test_the_first_attempt_is_immediate(self):
        assert config_sync.PushBackoff().ready(0.0) is True

    def test_each_consecutive_failure_doubles_the_wait(self):
        backoff = config_sync.PushBackoff()
        now = 1000.0

        assert [backoff.record_failure(now) for _ in range(6)] == [5, 10, 20, 40, 80, 160]

    def test_the_wait_is_capped(self):
        backoff = config_sync.PushBackoff()
        for _ in range(20):
            delay = backoff.record_failure(1000.0)

        assert delay == config_sync.PUSH_RETRY_MAX_SECONDS
        assert config_sync.PUSH_RETRY_MAX_SECONDS == 300

    def test_a_failure_blocks_attempts_until_the_delay_elapses(self):
        backoff = config_sync.PushBackoff()
        backoff.record_failure(1000.0)  # 5s

        assert backoff.ready(1004.9) is False
        assert backoff.ready(1005.0) is True

    def test_a_success_returns_to_full_speed(self):
        backoff = config_sync.PushBackoff()
        for _ in range(5):
            backoff.record_failure(1000.0)

        backoff.reset()

        assert backoff.failures == 0
        assert backoff.ready(1000.0) is True


def test_summary_reports_a_process_the_cloud_never_had():
    summary = config_sync.summarize_local_differences(
        _config([TOUCH, RESOLUME]), _config([TOUCH]))
    assert summary == 'processes: resolume'


def test_deep_merge_only_replaces_the_leaf():
    merged = config_sync.deep_merge(
        {'displays': {'autoRestore': {'enabled': True, 'circuitBreaker': {'failures': 0}}}},
        {'displays': {'autoRestore': {'circuitBreaker': {'failures': 2, 'tripped': False}}}},
    )
    autorestore = merged['displays']['autoRestore']
    assert autorestore['enabled'] is True
    assert autorestore['circuitBreaker'] == {'failures': 2, 'tripped': False}


def test_strip_local_only_leaves_the_original_untouched():
    local = _config([TOUCH], firebase={'enabled': True})
    stripped = config_sync.strip_local_only(local)
    assert 'firebase' not in stripped
    assert 'firebase' in local
