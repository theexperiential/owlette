"""
roost_kill_switch — emergency stop for v2 project distribution (wave 5.4).

an admin can disable roost on a per-site basis by setting
`sites/{siteId}.roostEnabled = false` in firestore. agents check this
flag before starting any new sync_pull; a running sync is not cancelled
mid-flight (that's cancel_sync's job), but no NEW work begins once the
flag is false.

**fail-open semantics**: a missing flag OR a firestore read error is
treated as ENABLED. the alternative — fail-closed — would grind a site
to a halt on a transient network blip, which is worse than leaking one
extra sync cycle while an admin attempts a kill.

**propagation time**: agents check the flag on every `sync_pull` via a
cached firestore read with a short TTL. the "within 60s" acceptance of
wave 5.4 is satisfied because the agent's main loop drives sync_pull
re-checks ~every 10s when there's queued work, and the cache TTL is
30s so a stale cached `enabled=true` clears before the minute mark.

NOT this module's job:
  - cancelling in-flight sync work (cancel_sync handler)
  - the web-side gate (web/lib/roostKillSwitch.ts mirrors this)
  - actual firestore writes by the admin UI (gate surface, not the
    write surface)
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Field name on `sites/{siteId}` carrying the flag. Shared with the web
# side — if this moves, `web/lib/roostKillSwitch.ts` must move with it.
ROOST_ENABLED_FIELD = 'roostEnabled'

# How long to cache a site-doc read before re-fetching. 30 s balances
# "flip takes effect fast" against firestore read cost. task 5.4's
# "within 60s" acceptance explicitly permits this magnitude.
_CACHE_TTL_SECONDS = 30.0


class _SiteFlagCache:
    """single-entry TTL cache of the roost-enabled flag for one site."""

    def __init__(self) -> None:
        self._enabled: Optional[bool] = None
        self._cached_at: float = 0.0
        self._site_id: Optional[str] = None

    def get(self, site_id: str, now: float) -> Optional[bool]:
        """return cached value or None if stale/empty/site-mismatch."""
        if self._site_id != site_id:
            return None
        if self._enabled is None:
            return None
        if now - self._cached_at > _CACHE_TTL_SECONDS:
            return None
        return self._enabled

    def put(self, site_id: str, enabled: bool, now: float) -> None:
        self._site_id = site_id
        self._enabled = enabled
        self._cached_at = now

    def invalidate(self) -> None:
        self._enabled = None
        self._cached_at = 0.0
        self._site_id = None


_cache = _SiteFlagCache()


def is_enabled_from_doc(site_doc: Optional[dict]) -> bool:
    """
    pure decision: given a site doc (or None), is roost enabled?

    fail-open rules:
      - None (doc not found / read error): ENABLED
      - dict without the field: ENABLED (default for sites created before
        the flag existed, or new sites that haven't had an opinion written)
      - explicit `roostEnabled: false`: DISABLED
      - explicit `roostEnabled: true`: ENABLED
      - non-bool value (migration glitch, type confusion): ENABLED
        (fail-open on malformed data; log a warning elsewhere)
    """
    if site_doc is None:
        return True
    if not isinstance(site_doc, dict):
        return True
    value = site_doc.get(ROOST_ENABLED_FIELD)
    if value is None:
        return True
    if isinstance(value, bool):
        return value
    # malformed — log but fail-open.
    logger.warning(
        f"roost_kill_switch: non-boolean {ROOST_ENABLED_FIELD}={value!r} "
        f"— treating as enabled (fail-open)"
    )
    return True


def check_enabled(
    site_id: str,
    firestore_reader: Any,
    *,
    now_fn: Any = time.time,
) -> bool:
    """
    check whether roost is enabled for `site_id`.

    `firestore_reader` is any callable/object providing a `get_site_doc(site_id)`
    method returning the site doc (or None on missing / error). passing
    the reader in lets tests substitute an in-memory fake without touching
    the real firestore REST client.

    **fail-open on exceptions**: any error reading the flag is logged and
    treated as enabled. see module docstring for why.
    """
    now = now_fn()
    cached = _cache.get(site_id, now)
    if cached is not None:
        return cached

    try:
        doc = firestore_reader.get_site_doc(site_id)
    except Exception as e:
        # treat as enabled (fail-open); don't cache the error so the
        # next check retries the read.
        logger.warning(
            f"roost_kill_switch: failed to read site doc for {site_id!r}: "
            f"{type(e).__name__}: {e} — treating as enabled"
        )
        return True

    enabled = is_enabled_from_doc(doc)
    _cache.put(site_id, enabled, now)
    return enabled


def invalidate_cache() -> None:
    """force the next check_enabled() to re-read. used by tests + explicit admin flows."""
    _cache.invalidate()


class RoostDisabledError(Exception):
    """raised by gated callers when roost is disabled on this site."""
    pass
