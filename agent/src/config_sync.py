"""Three-way reconciliation between config.json, the Firestore config doc, and
the last-known-remote cache.

Deliberately dependency-free (stdlib only, no win32, no firebase) so the
decision can be unit-tested without a service or a network.

Terminology used throughout:
    base   - last-known REMOTE document (cache/firebase_cache.json), None on a
             fresh install
    local  - current config.json
    remote - the document Firestore holds right now
"""

import copy
import json
from typing import Any, Dict, Optional, Tuple

# Never uploaded and never overwritten by a pull. `environment` is the local
# dev/prod routing choice: a stale remote doc seeded on dev would otherwise leave
# a prod `firebase` section beside a dev `environment`.
LOCAL_ONLY_KEYS = ('firebase', 'sentry', 'environment')

# Written by the web as Firestore server timestamps (see
# web/lib/actions/setDisplayLayout.server.ts). A pull lands them in config.json
# as ISO strings, so re-uploading them would rewrite a timestampValue as a
# stringValue and the dashboard would read the field as 0.
#
# Excluded from BOTH payloads and comparisons, and the two must stay in step:
# dropping them from uploads alone would leave local and remote permanently
# unequal on a field we refuse to send, and the agent would push every tick.
#
# circuitBreaker is deliberately NOT here — the agent owns it, and it has to keep
# syncing for the auto-restore breaker to survive a restart.
SERVER_OWNED_FIELD_PATHS = (
    ('displays', 'assigned', 'capturedAt'),
    ('displays', 'autoRestore', 'enabledAt'),
)


# Local-config push retry pacing. The detector polls twice a second, so without
# this a permanent failure (a rules denial) would mean a Firestore write — and a
# ConnectionManager error report — every 500ms. The 5s floor keeps a transient
# failure's first retry prompt while putting a real backoff in front of the rest.
PUSH_RETRY_BASE_SECONDS = 5.0
PUSH_RETRY_MAX_SECONDS = 300.0


class PushBackoff:
    """Consecutive-failure pacing for the local-config push.

    Doubles the wait after each consecutive failure, capped. Any success, or a
    fresh local edit, returns to full speed: an operator who has just changed
    something is owed an immediate attempt, whatever the previous edit's
    failures had grown the delay to. This is what keeps the 2Hz detector from
    turning a permanent failure into a write storm.

    Times are monotonic seconds, supplied by the caller so the schedule is
    testable without sleeping.
    """

    def __init__(self, base: float = PUSH_RETRY_BASE_SECONDS,
                 maximum: float = PUSH_RETRY_MAX_SECONDS):
        self.base = base
        self.maximum = maximum
        self.failures = 0
        self.next_attempt_at = 0.0

    def ready(self, now: float) -> bool:
        """True when the next attempt is due."""
        return now >= self.next_attempt_at

    def reset(self) -> None:
        """Back to full speed — a success, or a new edit worth trying at once."""
        self.failures = 0
        self.next_attempt_at = 0.0

    def record_failure(self, now: float) -> float:
        """Arm the next attempt and return the delay applied."""
        self.failures += 1
        delay = min(self.base * (2 ** (self.failures - 1)), self.maximum)
        self.next_attempt_at = now + delay
        return delay


def strip_local_only(config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Return `config` without the keys that only ever live on this machine."""
    if not config:
        return {}
    return {k: v for k, v in config.items() if k not in LOCAL_ONLY_KEYS}


def _strip_path(node: Dict[str, Any], path) -> None:
    """Remove one nested leaf in place, pruning containers the removal empties.

    Pruning matters: a `displays.assigned` holding nothing but capturedAt has to
    compare equal to no `displays.assigned` at all, or the strip itself becomes a
    difference.
    """
    head = path[0]
    if len(path) == 1:
        node.pop(head, None)
        return
    child = node.get(head)
    if not isinstance(child, dict):
        return
    _strip_path(child, path[1:])
    if not child:
        node.pop(head, None)


def strip_server_owned(config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Return a copy of `config` without the fields the server owns."""
    if not config:
        return {}
    stripped = copy.deepcopy(config)
    for path in SERVER_OWNED_FIELD_PATHS:
        _strip_path(stripped, path)
    return stripped


def normalize(config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Everything that participates in sync — the shape both compared and sent.

    Comparisons and upload payloads MUST come from this one function, or the
    agent ends up chasing a difference it will never upload.
    """
    return strip_server_owned(strip_local_only(config))


def _canonical(config: Optional[Dict[str, Any]]) -> str:
    return json.dumps(normalize(config), sort_keys=True, default=str)


def configs_equal(a: Optional[Dict[str, Any]], b: Optional[Dict[str, Any]]) -> bool:
    """True when two configs agree on everything that syncs."""
    return _canonical(a) == _canonical(b)


def deep_merge(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively merge `patch` into a copy of `base`; dict values merge,
    everything else is replaced."""
    merged = dict(base or {})
    for key, value in (patch or {}).items():
        existing = merged.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            merged[key] = deep_merge(existing, value)
        else:
            merged[key] = value
    return merged


def _process_key(process: Dict[str, Any]) -> str:
    return str(process.get('id') or process.get('name') or '')


def _process_label(process: Dict[str, Any]) -> str:
    return str(process.get('name') or process.get('id') or 'unnamed')


def _differing_process_labels(local: Dict[str, Any], remote: Dict[str, Any]):
    """Names of local processes the remote doc would overwrite or drop."""
    remote_by_key = {
        _process_key(p): p
        for p in (remote.get('processes') or [])
        if isinstance(p, dict)
    }
    labels = []
    for process in (local.get('processes') or []):
        if not isinstance(process, dict):
            continue
        counterpart = remote_by_key.get(_process_key(process))
        if counterpart is None or json.dumps(process, sort_keys=True, default=str) != \
                json.dumps(counterpart, sort_keys=True, default=str):
            labels.append(_process_label(process))
    return labels


def summarize_local_differences(local: Optional[Dict[str, Any]],
                                remote: Optional[Dict[str, Any]]) -> str:
    """Human-readable list of what a pull is about to discard.

    Names the differing top-level keys, and for `processes` the individual
    process names — an operator reading the log needs to know which of their
    edits went away, not just that some did.
    """
    local_n = normalize(local)
    remote_n = normalize(remote)

    parts = []
    for key in sorted(set(local_n) | set(remote_n)):
        if json.dumps(local_n.get(key), sort_keys=True, default=str) == \
                json.dumps(remote_n.get(key), sort_keys=True, default=str):
            continue
        if key == 'processes':
            labels = _differing_process_labels(local_n, remote_n)
            parts.append(f"processes: {', '.join(labels)}" if labels else 'processes')
        else:
            parts.append(key)

    return ', '.join(parts) if parts else 'nothing identifiable'


def decide_startup_sync(base: Optional[Dict[str, Any]],
                        local: Optional[Dict[str, Any]],
                        remote: Optional[Dict[str, Any]]) -> Tuple[str, Optional[str]]:
    """Decide what startup reconciliation should do.

    Returns (action, conflict_summary):
        'seed'    - Firestore holds nothing usable; upload local
        'in_sync' - local and remote already agree; apply nothing
        'push'    - only local moved since the last sync; upload it
        'pull'    - remote moved; apply it locally. conflict_summary is None
                    when local was untouched, and otherwise names the local
                    differences the pull discards.

    Cloud wins every genuine conflict (including a fresh install with no base to
    compare against) — the dashboard is the fleet's source of truth. The
    conflict summary exists so the loss is never silent.

    A remote of None must mean "the document is absent", never "the read
    failed"; the caller is responsible for that distinction, because seeding
    over a live document would destroy it.
    """
    if not remote or 'processes' not in remote:
        return 'seed', None

    if configs_equal(local, remote):
        return 'in_sync', None

    if base is not None:
        if configs_equal(remote, base):
            return 'push', None
        if configs_equal(local, base):
            return 'pull', None

    return 'pull', summarize_local_differences(local, remote)
