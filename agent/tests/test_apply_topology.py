"""Unit tests for the service-side ``apply_topology`` state machine.

These tests pin the **service-side** behaviour of ``apply_topology`` in
Session 0 — the production deployment topology. They mock at the
``_spawn_user_session_helper`` boundary (the IPC seam between the service
and the user-session subprocess that actually drives CCD), so the tests
exercise the real:

- pre-apply gate chain (kill switch, remote-apply flag, Mosaic refuse,
  concurrent-apply lock, cooldown rate-limit, input validation),
- helper IPC envelope handling (success payload, ok=False payload,
  ``DisplayEnumerationError`` raised by the spawn = timeout/crash),
- post-apply audit-event emission and watchdog arming (success path).

Mocking the helper boundary instead of CCD primitives keeps the tests in
sync with the production wire format — if the helper ever changes the
``ok`` / ``changes`` / ``code`` keys the tests fail loudly, not silently.

The Session 1+ branch already has dedicated coverage in
``tests/unit/test_display_manager.py`` (``TestApplyTopologyAutoRestore``);
this file focuses on the S0 helper-delegated path.
"""

import threading
import time
from unittest.mock import MagicMock

import pytest

import display_manager as dm
from display_manager import DisplayErrorCode


# A minimally valid layout — passes ``_validate_desired_layout`` so we get
# past the input-shape gate and into the gate chain we're actually testing.
SAMPLE_DESIRED = {
    'monitors': [
        {'edidHash': 'aaaaaaaa', 'primary': True, 'position': {'x': 0, 'y': 0}},
        {'edidHash': 'bbbbbbbb', 'primary': False, 'position': {'x': 1920, 'y': 0}},
    ],
}


@pytest.fixture
def reset_apply_state():
    """Clear ``apply_topology`` module-level state between tests so flag /
    timestamp leakage from a prior test can't contaminate the next case.
    """
    yield
    dm._apply_in_flight = False
    dm._ack_event.clear()
    dm._current_apply_id = None
    dm._last_apply_time = 0.0
    dm._last_apply_finished_at = 0.0


@pytest.fixture
def force_session_0(monkeypatch):
    """Pin ``_is_session_0`` to True so ``apply_topology`` takes the helper
    branch — the boundary we actually want to mock in this file. The S1 path
    is covered by ``test_display_manager.py``.
    """
    monkeypatch.setattr(dm, '_is_session_0', lambda: True)


@pytest.fixture
def enable_remote_apply(monkeypatch):
    """Wire ``shared_utils.read_config`` so the kill switch (``displays.enabled``)
    defaults to enabled (None → enabled per the production read) and the
    Wave 6.1 master gate (``displays.remoteApplyEnabled``) reads True. Tests
    that need a different config override the relevant key inline.
    """
    import shared_utils

    def _read(keys=None, **_kw):
        if keys == ['displays', 'remoteApplyEnabled']:
            return True
        return None

    monkeypatch.setattr(shared_utils, 'read_config', _read)


@pytest.fixture
def mock_mosaic_inactive(monkeypatch):
    """Default the NVIDIA Mosaic probe to inactive — the common-path
    precondition. Tests that exercise the refuse-guard override it inline.
    """
    import nvapi_display
    monkeypatch.setattr(
        nvapi_display, 'detect_mosaic', lambda: {'mosaicActive': False},
    )


@pytest.fixture
def stub_resync(monkeypatch):
    """``_trigger_profile_resync`` is fire-and-forget; stub to a no-op so
    the success path doesn't try to call into a (mocked) firebase client's
    ``_ensure_display_profile``.
    """
    monkeypatch.setattr(dm, '_trigger_profile_resync', lambda fb: None)


def _join_watchdog():
    """If the success path armed the apply watchdog, wait for it to exit.

    The watchdog blocks on ``_ack_event.wait(ack_timeout)`` then clears
    ``_apply_in_flight`` in its finally block. Tests that exercise the
    success path ack the apply (set the event) and then join here so the
    watchdog state doesn't leak into the next test.
    """
    for t in threading.enumerate():
        if t.name == 'display-apply-watchdog':
            t.join(timeout=2.0)


class TestApplyTopologyServiceStateMachine:
    """Service-side state-machine coverage for ``apply_topology`` in Session 0.

    Each test exercises one specific gate or one specific helper response
    shape, with the surrounding chain stubbed to the "happy" defaults via
    ``enable_remote_apply`` + ``mock_mosaic_inactive``.
    """

    # ------------------------------------------------------------------
    # 1. Success path

    def test_success_path_arms_watchdog_and_emits_audit(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state,
    ):
        """A successful helper response should: emit ``display_apply_succeeded``,
        arm the revert watchdog, return ``success: True`` with ``applyId`` and
        the ``changes`` list intact.
        """
        changes = [{'monitorId': 'aaaaaaaa', 'field': 'primary'}]
        spawn_calls = []

        def _fake_spawn(helper_args, out_path, timeout):
            spawn_calls.append({'args': helper_args, 'timeout': timeout})
            return {'ok': True, 'changes': changes}

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, ack_timeout=30, firebase_client=fb,
            apply_id='success-id',
        )

        assert result['success'] is True
        assert result['applyId'] == 'success-id'
        assert result['changes'] == changes
        assert result['revertDeadlineSeconds'] == 30
        assert isinstance(result['revertDeadlineEpochMs'], int)

        # The helper boundary was actually crossed exactly once with the
        # apply-json command shape; defensive evidence the test is testing
        # what it claims to test.
        assert len(spawn_calls) == 1
        assert spawn_calls[0]['args'][0] == '--apply-json'

        # Audit event for success was emitted with the apply_id payload.
        assert fb.log_event.called
        call = fb.log_event.call_args
        assert call.kwargs['action'] == 'display_apply_succeeded'
        assert call.kwargs['extra_fields']['applyId'] == 'success-id'
        assert call.kwargs['extra_fields']['changes'] == changes

        # Watchdog armed — _apply_in_flight is held until ack/timeout. Ack
        # the apply so the watchdog exits cleanly before the next test.
        assert dm._apply_in_flight is True
        dm._ack_event.set()
        _join_watchdog()
        assert dm._apply_in_flight is False

    # ------------------------------------------------------------------
    # 2. SDC_VALIDATE failure

    def test_validate_rejected_returns_code_and_emits_failure(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state,
    ):
        """When the helper reports SDC_VALIDATE rejected the requested config,
        the service surfaces the ``validate_rejected`` code and emits a
        ``display_apply_failed`` audit event with the same code stamped in.
        """
        def _fake_spawn(helper_args, out_path, timeout):
            return {
                'ok': False,
                'error': 'set-display-config rejected layout (rc=87)',
                'code': DisplayErrorCode.VALIDATE_REJECTED,
            }

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='validate-id',
        )

        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.VALIDATE_REJECTED
        assert 'rejected' in result['error']

        # Failure audit event surfaces the specific code so dashboard alert
        # routing can distinguish validate-fail from generic apply-fail.
        assert fb.log_event.called
        call = fb.log_event.call_args
        assert call.kwargs['action'] == 'display_apply_failed'
        assert call.kwargs['extra_fields']['code'] == str(
            DisplayErrorCode.VALIDATE_REJECTED,
        )

        # No watchdog on failure — the in-flight flag must clear via finally.
        assert dm._apply_in_flight is False

    # ------------------------------------------------------------------
    # 3. Zero active paths post-verify

    def test_zero_active_paths_post_verify_triggers_defensive_revert(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state, tmp_path,
    ):
        """Helper post-verify caught zero active paths after SDC_APPLY (a
        catastrophic outcome — no displays active). The helper writes a
        sentinel before applying, signals ``sentinel_written: True``, and
        the service responds by spawning a defensive revert helper. Both
        helper invocations land at our mock.
        """
        # Point sentinel at a tmp file so the cleanup branch can run without
        # touching the real ProgramData path.
        sentinel = tmp_path / '.display_revert_pending'
        monkeypatch.setattr(dm, '_SENTINEL_PATH', str(sentinel))
        # Pre-create the sentinel so the `os.path.exists(sentinel_path)` check
        # in the failure branch fires the defensive revert exactly as it
        # would in production (helper wrote sentinel before SDC_APPLY).
        sentinel.write_text('{"version": 1, "snapshot": {}}', encoding='utf-8')

        spawn_calls = []

        def _fake_spawn(helper_args, out_path, timeout):
            spawn_calls.append(list(helper_args))
            if helper_args[0] == '--apply-json':
                return {
                    'ok': False,
                    'error': 'post-verify: zero active paths after apply',
                    'code': DisplayErrorCode.ZERO_ACTIVE_PATHS_POST,
                    'sentinel_written': True,
                }
            # --revert-json — defensive revert succeeded
            return {'ok': True}

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='zero-paths-id',
        )

        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.ZERO_ACTIVE_PATHS_POST
        # The defensive revert ran (apply + revert helper invocations).
        assert any(args[0] == '--apply-json' for args in spawn_calls)
        assert any(args[0] == '--revert-json' for args in spawn_calls)
        # Sentinel cleaned up because the defensive revert succeeded.
        assert not sentinel.exists()
        assert dm._apply_in_flight is False

    # ------------------------------------------------------------------
    # 4. Helper timeout

    def test_helper_timeout_returns_helper_failed_code(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state,
    ):
        """A ``DisplayEnumerationError`` raised by ``_spawn_user_session_helper``
        (e.g. WaitForSingleObject timed out and the process was terminated)
        bubbles through ``_apply_via_user_session`` as
        ``{'ok': False, 'code': HELPER_FAILED}``. The state machine surfaces
        that code unchanged.
        """
        def _fake_spawn(helper_args, out_path, timeout):
            raise dm.DisplayEnumerationError(
                f'display helper timed out after {timeout:.1f}s (process terminated)'
            )

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='timeout-id',
        )

        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.HELPER_FAILED
        assert 'timed out' in result['error']
        assert fb.log_event.called
        assert (
            fb.log_event.call_args.kwargs['action'] == 'display_apply_failed'
        )
        assert dm._apply_in_flight is False

    # ------------------------------------------------------------------
    # 5. Helper crash (non-DisplayEnumerationError exception)

    def test_helper_crash_bubbles_to_unexpected_failure(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state,
    ):
        """An unexpected exception from the helper boundary (i.e. NOT a
        ``DisplayEnumerationError`` — those are caught inside
        ``_apply_via_user_session``) escapes to ``apply_topology``'s outer
        ``except Exception`` and returns the ``unexpected failure`` shape.

        This pins the safety net: even if a refactor changes the spawner to
        raise some new error class, the apply path returns a structured
        failure rather than crashing the calling thread.
        """
        def _fake_spawn(helper_args, out_path, timeout):
            raise RuntimeError('helper subprocess died unexpectedly')

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='crash-id',
        )

        assert result['success'] is False
        assert 'unexpected failure' in result['error']
        # The outer except path emits a generic display_apply_failed event
        # with no code attached (the exception isn't a known taxonomy entry).
        assert fb.log_event.called
        assert (
            fb.log_event.call_args.kwargs['action'] == 'display_apply_failed'
        )
        assert dm._apply_in_flight is False

    # ------------------------------------------------------------------
    # 6. Concurrent apply gate (lock contention)

    def test_concurrent_apply_returns_in_progress_error(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state,
    ):
        """``_apply_lock`` is a non-blocking acquire — a second apply while the
        first holds the lock returns the ``apply already in progress`` error
        without crossing the helper boundary or emitting an audit event
        (it's a pre-apply gate, not an attempt).
        """
        # Ensure no spurious helper call on the contention path — if the
        # state machine ever skips the gate, this assertion catches it.
        spawn_called = []

        def _fake_spawn(*_a, **_kw):
            spawn_called.append(True)
            return {'ok': True, 'changes': []}

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        # Simulate an in-flight apply by holding the lock.
        assert dm._apply_lock.acquire(blocking=False), 'precondition: lock free'
        # Mark in-flight so we can verify the contention return path doesn't
        # clobber the holder's flag.
        dm._apply_in_flight = True
        try:
            fb = MagicMock()
            result = dm.apply_topology(
                SAMPLE_DESIRED, firebase_client=fb, apply_id='contention-id',
            )
            assert result['success'] is False
            assert 'apply already in progress' in result['error']
            assert spawn_called == [], 'helper must not be invoked under contention'
            assert fb.log_event.call_count == 0
            # The contention-return path must NOT touch _apply_in_flight —
            # the existing apply's holder owns its lifecycle.
            assert dm._apply_in_flight is True
        finally:
            dm._apply_lock.release()

    # ------------------------------------------------------------------
    # 7. Cooldown gate

    def test_cooldown_gate_returns_rate_limited(
        self, monkeypatch, force_session_0, enable_remote_apply,
        mock_mosaic_inactive, stub_resync, reset_apply_state,
    ):
        """An apply within ``_APPLY_COOLDOWN_SECONDS`` of the previous one is
        rate-limited. The gate returns a ``rate limited`` error with no
        ``code`` field (rate-limit isn't a failure — it's transient back
        pressure) and no audit event.
        """
        spawn_called = []

        def _fake_spawn(*_a, **_kw):
            spawn_called.append(True)
            return {'ok': True, 'changes': []}

        monkeypatch.setattr(dm, '_spawn_user_session_helper', _fake_spawn)

        # Simulate a recent apply. The gate compares against
        # `time.time() - _last_apply_time < _APPLY_COOLDOWN_SECONDS`.
        dm._last_apply_time = time.time()

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='cooldown-id',
        )

        assert result['success'] is False
        assert 'rate limited' in result['error']
        # No code on the rate-limit return — distinguishes transient from
        # taxonomy-classified failures.
        assert 'code' not in result
        # Helper never reached, no audit emitted (pre-apply gate).
        assert spawn_called == []
        assert fb.log_event.call_count == 0
        assert dm._apply_in_flight is False

    # ------------------------------------------------------------------
    # 8. Feature-flag-off gate (Wave 6.1 master kill switch)

    def test_remote_apply_disabled_returns_disabled_error(
        self, monkeypatch, force_session_0, mock_mosaic_inactive,
        stub_resync, reset_apply_state,
    ):
        """When ``displays.remoteApplyEnabled`` is not True the apply is
        rejected before any locks, audit events, or helper invocations. This
        is the master kill switch for the Wave 6 rollout — a fresh agent
        defaults OFF until the operator opts in.
        """
        # Override read_config so remoteApplyEnabled returns False (vs the
        # enable_remote_apply fixture which returns True). Other keys still
        # default to None.
        import shared_utils

        def _read(keys=None, **_kw):
            if keys == ['displays', 'remoteApplyEnabled']:
                return False
            return None

        monkeypatch.setattr(shared_utils, 'read_config', _read)

        spawn_called = []
        monkeypatch.setattr(
            dm, '_spawn_user_session_helper',
            lambda *a, **kw: spawn_called.append(True),
        )

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='killswitch-id',
        )

        assert result == {
            'success': False,
            'error': 'remote apply disabled by config',
        }
        assert spawn_called == []
        assert fb.log_event.call_count == 0
        # Pre-lock gate — flag never armed, never needs clearing.
        assert dm._apply_in_flight is False

    def test_displays_feature_disabled_returns_feature_off_error(
        self, monkeypatch, force_session_0, mock_mosaic_inactive,
        stub_resync, reset_apply_state,
    ):
        """The ``displays.enabled`` kill switch (separate from the Wave 6.1
        master gate) rejects apply with its own message. Pinning both kill
        switches in this file documents that they're independent — disabling
        the whole feature is distinct from disabling only the write path.
        """
        import shared_utils

        def _read(keys=None, **_kw):
            if keys == ['displays', 'enabled']:
                return False
            return None

        monkeypatch.setattr(shared_utils, 'read_config', _read)

        spawn_called = []
        monkeypatch.setattr(
            dm, '_spawn_user_session_helper',
            lambda *a, **kw: spawn_called.append(True),
        )

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='feature-off-id',
        )

        assert result == {
            'success': False,
            'error': 'displays feature disabled by config',
        }
        assert spawn_called == []
        assert fb.log_event.call_count == 0
        assert dm._apply_in_flight is False

    # ------------------------------------------------------------------
    # 9. Mosaic-active refuse

    def test_mosaic_active_refuses_with_mosaic_active_code(
        self, monkeypatch, force_session_0, enable_remote_apply,
        stub_resync, reset_apply_state,
    ):
        """NVIDIA Mosaic active → refuse the apply cleanly with the
        ``mosaic_active`` code so the operator gets a specific error rather
        than a driver-induced surprise. Emits a ``display_apply_refused_mosaic``
        audit event (not the generic ``display_apply_failed``).
        """
        import nvapi_display
        monkeypatch.setattr(
            nvapi_display, 'detect_mosaic', lambda: {'mosaicActive': True},
        )

        spawn_called = []
        monkeypatch.setattr(
            dm, '_spawn_user_session_helper',
            lambda *a, **kw: spawn_called.append(True),
        )

        fb = MagicMock()
        result = dm.apply_topology(
            SAMPLE_DESIRED, firebase_client=fb, apply_id='mosaic-id',
        )

        assert result['success'] is False
        assert result['code'] == DisplayErrorCode.MOSAIC_ACTIVE
        assert 'Mosaic' in result['error']
        # Helper never reached — refuse-guard fires before the lock.
        assert spawn_called == []
        # Mosaic-specific audit event (not display_apply_failed).
        assert fb.log_event.called
        assert (
            fb.log_event.call_args.kwargs['action']
            == 'display_apply_refused_mosaic'
        )
        # Pre-lock gate — flag never armed.
        assert dm._apply_in_flight is False
