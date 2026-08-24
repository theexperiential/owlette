"""
roost_kill_switch — emergency stop for roost sync, per site.

`sites/{siteId}.roostEnabled = false` blocks any NEW sync_pull; in-flight syncs
are cancel_sync's job. Fail-open: missing flag or firestore read error means
ENABLED — fail-closed would halt a site on a transient network blip.

Web mirror of this gate: web/lib/roostKillSwitch.ts.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Shared with web/lib/roostKillSwitch.ts — move both together.
ROOST_ENABLED_FIELD = 'roostEnabled'

# Site-doc read cache TTL. 30s keeps a kill inside the 60s propagation budget.
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

    Only an explicit `roostEnabled: false` disables; None / missing field /
    non-bool all fail open to ENABLED.
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

    `firestore_reader` needs `get_site_doc(site_id) -> dict | None`; injected so
    tests can fake it. Read errors fail open to enabled and are not cached.
    """
    now = now_fn()
    cached = _cache.get(site_id, now)
    if cached is not None:
        return cached

    try:
        doc = firestore_reader.get_site_doc(site_id)
    except Exception as e:
        logger.warning(
            f"roost_kill_switch: failed to read site doc for {site_id!r}: "
            f"{type(e).__name__}: {e} — treating as enabled"
        )
        return True

    enabled = is_enabled_from_doc(doc)
    _cache.put(site_id, enabled, now)
    return enabled


def invalidate_cache() -> None:
    """force the next check_enabled() to re-read."""
    _cache.invalidate()


class RoostDisabledError(Exception):
    """raised by gated callers when roost is disabled on this site."""
    pass
