"""
sync_commands — roost (project distribution v2) command handlers.

registers `sync_pull`, `cancel_sync`, `rollback_to_manifest` with the
CommandRouter so they're dispatched by `OwletteService.handle_firebase_command`.
each handler runs on the `_slow_command_worker` thread (NOT the main
10-second loop) so blocking sync ops don't stall monitoring.

handler responsibilities:
- parse + validate the command payload
- fetch the manifest (sync_manifest)
- diff against local cache to compute chunk + file delta
- download missing chunks (sync_downloader)
- assemble files atomically (sync_assembler)
- update SyncState throughout so progress survives crash/restart
- report status back to firestore via service.firebase_client

design:
- handlers are pure orchestration: every IO module they touch lives in
  its own file with its own tests. this keeps the integration shallow.
- cancellation: each in-flight distribution registers its threading.Event
  in a process-global registry keyed by distribution_id. cancel_sync
  fires the event by id.

NOT this module's job:
- the actual sync engine logic (downloader / assembler / manifest)
- security floor (destination_allowlist)
- HTTP signed-URL issuance (web/api routes)
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Optional

from command_router import CommandRouter
from destination_allowlist import DestinationAllowlist, DestinationNotAllowedError
from roost_kill_switch import check_enabled as _roost_is_enabled
from sync_assembler import AssembleError, assemble_all
from sync_downloader import ChunkDownloadError, download_all
from sync_manifest import Manifest, ManifestError, diff_manifests, fetch_manifest
from sync_state import SyncState, SyncStateError

logger = logging.getLogger(__name__)

# process-global registry of in-flight distributions. allows cancel_sync
# to reach into a running sync and fire its cancel_event.
# distribution_id -> threading.Event
_inflight_cancels: Dict[int, threading.Event] = {}
_inflight_lock = threading.Lock()


def register_handlers(router: CommandRouter) -> None:
    """
    register all roost v2 handlers on the given CommandRouter. called once
    at OwletteService init time after the router instance is created.
    """
    router.register('sync_pull')(_handle_sync_pull)
    router.register('cancel_sync')(_handle_cancel_sync)
    router.register('rollback_to_manifest')(_handle_rollback_to_manifest)
    logger.info(
        f"sync_commands: registered handlers — {sorted(router.registered_types())}"
    )


# ─── handlers ────────────────────────────────────────────────────────


def _handle_sync_pull(cmd_data: dict, cmd_id: str, service: Any) -> str:
    """
    pull a manifest + download missing chunks + atomically assemble files.

    cmd_data:
      site_id:        str (the agent's site; redundant with token claim but explicit)
      folder_id:      str (which synced_folder)
      manifest_id:    str (which immutable manifest version to pull)
      manifest_url:   str (signed R2 url to fetch the manifest body)
      extract_root:   str (target directory for assembled files)

    NOTE: signed download urls for individual chunks are obtained on-demand
    by sync_downloader via a callback. the callback talks to the web api
    (POST /api/chunks/download-urls) using the agent's existing OAuth token.
    """
    site_id = _require_str(cmd_data, 'site_id')
    folder_id = _require_str(cmd_data, 'folder_id')
    manifest_id = _require_str(cmd_data, 'manifest_id')
    manifest_url = _require_str(cmd_data, 'manifest_url')
    extract_root = _require_str(cmd_data, 'extract_root')

    # Wave 5.4 — kill-switch check. Admin sets sites/{siteId}.roostEnabled=false
    # to halt all new roost work on this site. In-flight distributions are
    # NOT cancelled here (cancel_sync handler owns that). Fail-open: a
    # firestore read error treats the flag as enabled so a transient network
    # blip doesn't pause deploys. See agent/src/roost_kill_switch.py.
    try:
        if not _roost_is_enabled(site_id, _firestore_reader_for(service)):
            logger.warning(
                f"sync_pull: refusing to start — roost is disabled on site {site_id!r} "
                f"(manifest {manifest_id})"
            )
            return f"sync_pull skipped: roost kill-switch engaged for site {site_id}"
    except Exception as e:
        # defensive: the check itself should fail-open internally, but if
        # something above it throws, keep going rather than silently
        # declining commands.
        logger.warning(
            f"sync_pull: roost kill-switch check errored ({type(e).__name__}: {e}) — "
            f"proceeding fail-open"
        )

    state = _state_for(service)
    allowlist = _allowlist_for(service)
    cancel_event = threading.Event()

    # fetch + validate manifest
    try:
        manifest = fetch_manifest(manifest_url, expected_manifest_id=manifest_id)
    except ManifestError as e:
        return f"sync_pull failed: manifest fetch/validate: {e}"

    # diff against the most-recent committed manifest for this folder, if any
    prior = _load_prior_manifest(service, site_id, folder_id, exclude_manifest_id=manifest_id)
    diff = diff_manifests(manifest, prior)

    # register the distribution + planned files/chunks
    files_planned = [{'path': f.path, 'size': f.size} for f in manifest.files]
    chunks_planned = [
        {'hash': h, 'size': manifest.chunk_size_index[h]}
        for h in sorted(manifest.chunks)
    ]
    try:
        dist_id = state.start_distribution(
            site_id=site_id,
            folder_id=folder_id,
            manifest_id=manifest_id,
            manifest_url=manifest_url,
            files=files_planned,
            chunks=chunks_planned,
            extract_root=extract_root,
        )
    except SyncStateError as e:
        # already exists — find it and resume
        existing = state.find_distribution(site_id, folder_id, manifest_id)
        if existing is None:
            return f"sync_pull failed: state error and no existing row: {e}"
        dist_id = existing['id']
        logger.info(f"sync_pull: resuming existing distribution {dist_id}")

    with _inflight_lock:
        _inflight_cancels[dist_id] = cancel_event

    try:
        state.set_distribution_state(dist_id, 'downloading')

        # download chunks. url_provider talks to the web api per-chunk.
        url_provider = _make_chunk_url_provider(service, site_id)
        try:
            dl_result = download_all(
                distribution_id=dist_id,
                chunks=[{'hash': h, 'size': manifest.chunk_size_index[h]}
                        for h in diff.chunks_to_fetch],
                url_provider=url_provider,
                state=state,
                cancel_event=cancel_event,
            )
        except ChunkDownloadError as e:
            state.set_distribution_state(dist_id, 'failed', error=str(e))
            return f"sync_pull failed: chunk download: {e}"

        if cancel_event.is_set() and dl_result.failed == 0:
            state.set_distribution_state(dist_id, 'cancelled')
            return f"sync_pull cancelled during download (distribution {dist_id})"

        # assemble files atomically.
        state.set_distribution_state(dist_id, 'assembling')
        try:
            asm_result = assemble_all(
                distribution_id=dist_id,
                files=manifest.files,
                extract_root=extract_root,
                state=state,
                allowlist=allowlist,
                cancel_event=cancel_event,
            )
        except (AssembleError, DestinationNotAllowedError) as e:
            state.set_distribution_state(dist_id, 'failed', error=str(e))
            return f"sync_pull failed: file assembly: {e}"

        if cancel_event.is_set() and asm_result.failed == 0:
            state.set_distribution_state(dist_id, 'cancelled')
            return f"sync_pull cancelled during assembly (distribution {dist_id})"

        state.set_distribution_state(dist_id, 'committed')
        return (
            f"sync_pull complete (distribution {dist_id}): "
            f"fetched {dl_result.fetched} chunks, "
            f"dedup {dl_result.already_present}, "
            f"assembled {asm_result.assembled} files, "
            f"skipped {asm_result.skipped}"
        )

    finally:
        with _inflight_lock:
            _inflight_cancels.pop(dist_id, None)


def _handle_cancel_sync(cmd_data: dict, cmd_id: str, service: Any) -> str:
    """
    cancel an in-flight sync_pull. the worker checks the cancel_event
    between chunks (and between files in the assembler), so cancellation
    is graceful — current operation completes, no corrupted state.
    """
    site_id = _require_str(cmd_data, 'site_id')
    folder_id = _require_str(cmd_data, 'folder_id')
    manifest_id = _require_str(cmd_data, 'manifest_id')

    state = _state_for(service)
    row = state.find_distribution(site_id, folder_id, manifest_id)
    if row is None:
        return f"cancel_sync: no distribution found for ({site_id}, {folder_id}, {manifest_id})"
    dist_id = row['id']

    with _inflight_lock:
        ev = _inflight_cancels.get(dist_id)
    if ev is None:
        return f"cancel_sync: distribution {dist_id} is not in-flight (state={row['state']})"
    ev.set()
    return f"cancel_sync: cancellation signalled for distribution {dist_id}"


def _handle_rollback_to_manifest(cmd_data: dict, cmd_id: str, service: Any) -> str:
    """
    treat rollback as a sync_pull of an older manifest. agent doesn't need
    special "rollback" logic — the manifest pointer flip happens server-side
    (web /api/roosts/.../rollback), and the agent simply sees a new
    distribute_to_manifest event for the older manifest id.
    """
    return _handle_sync_pull(cmd_data, cmd_id, service)


# ─── helpers ─────────────────────────────────────────────────────────


def _require_str(d: dict, key: str) -> str:
    v = d.get(key)
    if not isinstance(v, str) or not v:
        raise ValueError(f"command payload missing required string field {key!r}")
    return v


def _state_for(service: Any) -> SyncState:
    """
    lazily attach a SyncState to the service so all handlers share one
    connection. the service owns its lifecycle (closed at SvcStop).
    """
    state = getattr(service, '_sync_state', None)
    if state is None:
        state = SyncState()
        service._sync_state = state
    return state


def _firestore_reader_for(service: Any) -> Any:
    """
    wrap the service's firestore client so `roost_kill_switch.check_enabled`
    sees the minimal `get_site_doc(site_id)` surface. lazy-cached on the
    service instance — the real firestore client lives on `service.firebase_client`
    (set up by owlette_service), but for tests the service is often a
    plain object that already exposes `get_site_doc` directly.
    """
    reader = getattr(service, '_roost_site_reader', None)
    if reader is not None:
        return reader

    # if the service itself quacks like a reader (tests, MockService), use it.
    if hasattr(service, 'get_site_doc'):
        service._roost_site_reader = service
        return service

    client = getattr(service, 'firebase_client', None)
    if client is None:
        # no client wired yet (very early boot) — return a stub that
        # returns None, which check_enabled treats as fail-open.
        class _NullReader:
            def get_site_doc(self, _site_id: str):
                return None
        reader = _NullReader()
    else:
        class _FirebaseSiteReader:
            def __init__(self, fc: Any) -> None:
                self._fc = fc

            def get_site_doc(self, site_id: str):
                try:
                    return self._fc.get_document(f'sites/{site_id}')
                except Exception:
                    # check_enabled handles exceptions at a higher level,
                    # but returning None here is a cleaner contract.
                    return None
        reader = _FirebaseSiteReader(client)

    service._roost_site_reader = reader
    return reader


def _allowlist_for(service: Any) -> DestinationAllowlist:
    """
    lazily build a DestinationAllowlist from the agent's config. read from
    config['agent_config']['allowed_extract_roots']; fail-closed if absent.
    """
    allowlist = getattr(service, '_destination_allowlist', None)
    if allowlist is None:
        # defer the import to avoid pulling shared_utils at module load
        # (test isolation — sync_state + sync_manifest don't need it).
        import shared_utils
        config = shared_utils.read_config() or {}
        allowlist = DestinationAllowlist.from_config(config)
        service._destination_allowlist = allowlist
    return allowlist


def _load_prior_manifest(
    service: Any, site_id: str, folder_id: str, exclude_manifest_id: str
) -> Optional[Manifest]:
    """
    find the most recent COMMITTED manifest for this folder (excluding
    the manifest we're about to install) and load it from cache. used
    for diffing.
    """
    state = _state_for(service)
    # we don't currently store manifest_url separately — only the cached
    # file matters for diff. caller's cache lookup keyed by manifest_id.
    # simplification: only look at the immediately prior committed dist.
    # (more sophisticated lineage walk is a v3 concern.)
    with state._lock:  # type: ignore[attr-defined]
        assert state._conn is not None
        cur = state._conn.execute(
            '''SELECT manifest_id, manifest_url FROM distributions
               WHERE site_id = ? AND folder_id = ? AND manifest_id != ?
                 AND state = 'committed'
               ORDER BY updated_at DESC LIMIT 1''',
            (site_id, folder_id, exclude_manifest_id),
        )
        row = cur.fetchone()
    if row is None:
        return None
    try:
        return fetch_manifest(row['manifest_url'], expected_manifest_id=row['manifest_id'])
    except ManifestError as e:
        # prior manifest unfetchable (cache evicted + url expired);
        # treat as "no prior" so the diff includes everything.
        logger.warning(
            f"sync_commands: prior manifest {row['manifest_id']} unfetchable: {e}; "
            f"diffing against nothing"
        )
        return None


def _make_chunk_url_provider(service: Any, site_id: str):
    """
    return a BATCH callback that issues fresh signed download urls for
    chunk hashes. signature: `Callable[[list[str]], dict[str, str]]`.
    matches the contract sync_downloader expects (URL_PREFETCH_BATCH_SIZE
    upfront, then single-hash refetches on 403).

    talks to web api `POST /api/chunks/download-urls` using the agent's
    OAuth bearer token via firebase_client.get_chunk_download_urls.

    raises NotImplementedError ONLY if the service has no firebase_client
    (offline/local-only mode); a clear surface for the misconfiguration.
    """
    fb = getattr(service, 'firebase_client', None)
    if fb is None:
        def _no_client(chunk_hashes):
            raise NotImplementedError(
                "chunk url provider unavailable: agent has no firebase_client "
                "(running in local-only mode?). check agent startup logs."
            )
        return _no_client

    def _provider(chunk_hashes):
        if not chunk_hashes:
            return {}
        return fb.get_chunk_download_urls(list(chunk_hashes))
    return _provider
