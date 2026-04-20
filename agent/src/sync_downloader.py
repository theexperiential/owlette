"""
sync_downloader — parallel chunk fetcher for roost (project distribution v2).

downloads content-addressed chunks (4 MiB each) from R2 signed URLs into
the local content store at ~/Documents/Owlette/.owlette-content/{hash[0:2]}/{hash}.

design:
- thread pool of N workers (default 4) downloads chunks in parallel
- range-request resume: a partial download (`<hash>.partial`) is resumed
  by sending `Range: bytes=<offset>-` rather than re-fetching from byte 0
- per-chunk SHA-256 verification: the chunk's filename IS its hash;
  bytes that don't match are deleted and the chunk is re-queued
- url refresh: signed urls expire (≤15 min for downloads); the caller
  passes a `url_provider(hash) -> str` callback the worker calls when
  a 403 / expired-url response is received
- cancellation: a `cancel_event` (threading.Event) is checked between
  chunks AND between range-requests within a single chunk
- per-chunk retry budget (default 5) with exponential backoff
- updates SyncState rows so progress survives crash/restart

NOT this module's job:
- chunk-set planning (sync_manifest provides the diff)
- file reassembly (sync_assembler reads from content store)
- signed-url issuance (web/api/chunks/download-urls; passed via url_provider)
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional

import requests
import threading as _threading_for_lock  # alias to avoid shadowing param `threading.Event`

from sync_state import SyncState

logger = logging.getLogger(__name__)

# default content store. one global pool shared across all distributions
# (chunks are content-addressed, so dedup is automatic).
DEFAULT_CONTENT_STORE = '~/Documents/Owlette/.owlette-content'

# tuning constants
DEFAULT_CONCURRENCY = 4
DEFAULT_PER_CHUNK_RETRY_BUDGET = 5
DEFAULT_RETRY_BACKOFF_BASE_S = 2.0
DEFAULT_RETRY_BACKOFF_MAX_S = 60.0
# bulk-prefetch batch size for URL provider. must be ≤ MAX_HASHES_PER_REQUEST
# enforced server-side (currently 1000). 500 leaves headroom + keeps each
# request's payload small enough to fit in a typical TLS write window.
URL_PREFETCH_BATCH_SIZE = 500

# HTTP timing — same shape as installer_utils + sync_manifest.
_CONNECT_TIMEOUT_S = 30
_READ_TIMEOUT_S = 600
_STREAM_CHUNK_BYTES = 64 * 1024


class ChunkDownloadError(Exception):
    """raised when a chunk repeatedly fails (after retry budget exhausted)."""
    pass


@dataclass
class DownloadResult:
    """summary returned by download_all() — for the caller's progress UI."""
    fetched: int          # chunks newly downloaded this run
    already_present: int  # chunks already in content store (dedup hits)
    failed: int           # chunks that hit retry budget
    cancelled: bool       # True if cancel_event triggered before completion


def chunk_path(content_store: Path, chunk_hash: str) -> Path:
    """
    return the canonical on-disk path for a content-addressed chunk.
    sharded by first two hex chars to keep directory entry counts manageable
    (a 500GB project = ~125k chunks; flat dir would be slow on NTFS).
    """
    return content_store / chunk_hash[:2] / chunk_hash


def has_chunk(content_store: Path, chunk_hash: str, expected_size: int) -> bool:
    """
    true if a fully-verified chunk is already in the content store.

    a chunk file is considered "present" iff its size matches expected_size
    AND its SHA-256 matches the filename. partial downloads (`<hash>.partial`)
    are NOT considered present — they trigger a resume.
    """
    target = chunk_path(content_store, chunk_hash)
    if not target.exists():
        return False
    try:
        if target.stat().st_size != expected_size:
            logger.warning(
                f"sync_downloader: chunk {chunk_hash[:12]}… on disk has wrong size "
                f"({target.stat().st_size} vs expected {expected_size}); will refetch"
            )
            target.unlink(missing_ok=True)
            return False
    except OSError as e:
        logger.warning(f"sync_downloader: stat failed for {target}: {e}")
        return False
    if _hash_file(target) != chunk_hash:
        logger.warning(
            f"sync_downloader: chunk {chunk_hash[:12]}… on disk has wrong hash; will refetch"
        )
        target.unlink(missing_ok=True)
        return False
    return True


def download_all(
    distribution_id: int,
    chunks: Iterable[dict],  # [{hash, size}]
    url_provider: Callable[[List[str]], Dict[str, str]],
    state: SyncState,
    cancel_event: Optional[threading.Event] = None,
    content_store: Optional[str] = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    retry_budget: int = DEFAULT_PER_CHUNK_RETRY_BUDGET,
) -> DownloadResult:
    """
    fetch every chunk in `chunks` into the content store. chunks already
    present (dedup) are skipped. progress is recorded in SyncState.

    url_provider(hashes) -> {hash: url}: BATCH form. takes a list of chunk
    hashes (≤ URL_PREFETCH_BATCH_SIZE per call) and returns a dict of fresh
    signed download URLs. called ONCE upfront in batches to populate a
    cache, then again per-hash on 403 responses (single-element list).

    cancel_event: if set, workers stop after their current chunk completes.

    raises ChunkDownloadError if ANY chunk exhausts its retry budget.
    """
    if cancel_event is None:
        cancel_event = threading.Event()  # never-fires sentinel
    store = Path(os.path.expanduser(content_store or DEFAULT_CONTENT_STORE))
    store.mkdir(parents=True, exist_ok=True)

    chunks_list = list(chunks)
    fetched = 0
    already_present = 0
    failed = 0

    # filter out chunks already on disk before spawning workers — dedup
    # avoids the per-thread overhead for the common re-publish case where
    # most chunks are unchanged.
    pending: List[dict] = []
    for c in chunks_list:
        if cancel_event.is_set():
            break
        if has_chunk(store, c['hash'], c['size']):
            already_present += 1
            state.set_chunk_state(distribution_id, c['hash'], 'verified')
        else:
            pending.append(c)

    if not pending:
        return DownloadResult(
            fetched=0, already_present=already_present, failed=0,
            cancelled=cancel_event.is_set(),
        )

    logger.info(
        f"sync_downloader: distribution {distribution_id}: "
        f"{already_present} dedup hits, {len(pending)} chunks to fetch "
        f"(concurrency={concurrency})"
    )

    # bulk-prefetch URLs upfront in batches. for a 12,500-chunk distribution
    # at batch size 500 = 25 round-trips instead of 12,500. workers then
    # get their URLs from the in-memory cache; on 403 (URL expired mid-
    # download) they fall back to a single-hash refetch via _per_hash_lookup.
    url_cache: Dict[str, str] = {}
    cache_lock = _threading_for_lock.Lock()
    pending_hashes = [c['hash'] for c in pending]
    for i in range(0, len(pending_hashes), URL_PREFETCH_BATCH_SIZE):
        if cancel_event.is_set():
            break
        batch = pending_hashes[i:i + URL_PREFETCH_BATCH_SIZE]
        try:
            urls = url_provider(batch)
        except Exception as e:
            logger.error(
                f"sync_downloader: bulk url prefetch failed for batch of "
                f"{len(batch)} chunks: {e}"
            )
            raise ChunkDownloadError(f"bulk url prefetch failed: {e}") from e
        if not isinstance(urls, dict):
            raise ChunkDownloadError(
                f"url_provider returned {type(urls).__name__}, expected dict"
            )
        with cache_lock:
            url_cache.update(urls)
    logger.debug(
        f"sync_downloader: prefetched {len(url_cache)} urls "
        f"in {(len(pending_hashes) + URL_PREFETCH_BATCH_SIZE - 1) // URL_PREFETCH_BATCH_SIZE} batch(es)"
    )

    # per-hash call counter. _download_one calls _per_hash_lookup once
    # per attempt and retries on 403 / expiry. so the FIRST call returns
    # the cached prefetched URL; SUBSEQUENT calls (= retries) treat the
    # cache as stale and force a refetch. without this, retries on an
    # expired URL would just re-receive the same expired URL forever.
    url_call_counts: Dict[str, int] = {}

    def _per_hash_lookup(chunk_hash: str) -> str:
        """worker-facing per-hash provider: cache hit on first call, refetch on retries."""
        with cache_lock:
            n = url_call_counts.get(chunk_hash, 0) + 1
            url_call_counts[chunk_hash] = n
            if n == 1:
                url = url_cache.get(chunk_hash)
            else:
                # retry → assume previous URL was stale; clear cache entry.
                url_cache.pop(chunk_hash, None)
                url = None
        if url:
            return url
        # refetch single hash from upstream and refresh the cache.
        result = url_provider([chunk_hash])
        if not isinstance(result, dict):
            raise ChunkDownloadError(
                f"url_provider returned {type(result).__name__}, expected dict"
            )
        with cache_lock:
            url_cache.update(result)
        url = result.get(chunk_hash)
        if not url:
            raise ChunkDownloadError(
                f"url_provider did not return a url for {chunk_hash[:12]}…"
            )
        return url

    # was_externally_cancelled snapshots cancel_event BEFORE we (possibly)
    # set it ourselves on per-chunk failure. lets us distinguish "user
    # cancelled" from "chunk failure short-circuit" in the result.
    was_externally_cancelled = cancel_event.is_set()

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(
                _download_one,
                c['hash'], c['size'], store, _per_hash_lookup,
                state, distribution_id, cancel_event, retry_budget,
            ): c
            for c in pending
        }
        for fut in as_completed(futures):
            c = futures[fut]
            try:
                fut.result()
                fetched += 1
            except ChunkDownloadError:
                failed += 1
                # state already marked 'failed' by _download_one; signal
                # cancel to short-circuit any in-flight workers.
                cancel_event.set()
            except Exception as e:
                # unexpected — log + treat as failure
                logger.error(
                    f"sync_downloader: unexpected error on {c['hash'][:12]}…: {e}",
                    exc_info=True,
                )
                state.set_chunk_state(
                    distribution_id, c['hash'], 'failed',
                    error=f"{type(e).__name__}: {e}",
                )
                failed += 1
                cancel_event.set()

    result = DownloadResult(
        fetched=fetched,
        already_present=already_present,
        failed=failed,
        cancelled=was_externally_cancelled and failed == 0,
    )
    logger.info(
        f"sync_downloader: distribution {distribution_id} complete: "
        f"fetched={fetched} dedup={already_present} failed={failed} "
        f"cancelled={result.cancelled}"
    )
    # failure always raises so the caller gets a hard error. external
    # cancellation returns peacefully (result.cancelled tells the story).
    if failed > 0:
        raise ChunkDownloadError(
            f"distribution {distribution_id}: {failed} chunk(s) failed "
            f"after retry budget exhausted"
        )
    return result


def _download_one(
    chunk_hash: str,
    expected_size: int,
    content_store: Path,
    url_provider: Callable[[str], str],
    state: SyncState,
    distribution_id: int,
    cancel_event: threading.Event,
    retry_budget: int,
) -> None:
    """download a single chunk with range-resume + retries. raises on exhaustion."""
    target = chunk_path(content_store, chunk_hash)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + '.partial')

    state.set_chunk_state(distribution_id, chunk_hash, 'downloading')
    last_err: Optional[Exception] = None

    for attempt in range(1, retry_budget + 1):
        if cancel_event.is_set():
            logger.debug(f"sync_downloader: {chunk_hash[:12]}… cancelled before attempt {attempt}")
            return
        try:
            # how far did we get last time? resume from there.
            offset = partial.stat().st_size if partial.exists() else 0
            if offset >= expected_size:
                # corrupt partial — start over
                partial.unlink(missing_ok=True)
                offset = 0

            url = url_provider(chunk_hash)
            headers = {}
            if offset > 0:
                headers['Range'] = f'bytes={offset}-'
                logger.debug(
                    f"sync_downloader: resuming {chunk_hash[:12]}… from offset {offset}"
                )

            resp = requests.get(
                url,
                headers=headers,
                timeout=(_CONNECT_TIMEOUT_S, _READ_TIMEOUT_S),
                stream=True,
                allow_redirects=True,
            )
            # 403 = signed url expired; refetch url + retry without backoff
            if resp.status_code in (403, 401):
                logger.info(
                    f"sync_downloader: {chunk_hash[:12]}… got {resp.status_code}; "
                    f"refreshing signed url"
                )
                resp.close()
                continue
            # 416 = our range header is past the file — corrupt partial.
            # delete + retry full.
            if resp.status_code == 416:
                logger.warning(
                    f"sync_downloader: {chunk_hash[:12]}… got 416 (range past file); "
                    f"deleting partial + restarting"
                )
                partial.unlink(missing_ok=True)
                resp.close()
                continue
            resp.raise_for_status()

            mode = 'ab' if offset > 0 else 'wb'
            with open(partial, mode) as f:
                for buf in resp.iter_content(chunk_size=_STREAM_CHUNK_BYTES):
                    if cancel_event.is_set():
                        logger.debug(
                            f"sync_downloader: {chunk_hash[:12]}… cancelled mid-stream"
                        )
                        resp.close()
                        return
                    if buf:
                        f.write(buf)

            # verify the completed download matches the expected hash.
            if partial.stat().st_size != expected_size:
                raise ChunkDownloadError(
                    f"size mismatch: got {partial.stat().st_size} expected {expected_size}"
                )
            actual = _hash_file(partial)
            if actual != chunk_hash:
                # bad data on the wire, or storage corruption. delete + retry.
                logger.warning(
                    f"sync_downloader: {chunk_hash[:12]}… hash mismatch "
                    f"(got {actual[:12]}…); discarding + retrying"
                )
                partial.unlink(missing_ok=True)
                last_err = ChunkDownloadError(f"hash mismatch (got {actual})")
                _backoff(attempt)
                continue

            # success — atomically move into final location.
            os.replace(str(partial), str(target))
            state.set_chunk_state(distribution_id, chunk_hash, 'verified')
            return

        except requests.RequestException as e:
            last_err = e
            logger.warning(
                f"sync_downloader: {chunk_hash[:12]}… attempt {attempt}/{retry_budget} "
                f"network error: {e}"
            )
            _backoff(attempt)
        except OSError as e:
            last_err = e
            logger.warning(
                f"sync_downloader: {chunk_hash[:12]}… attempt {attempt}/{retry_budget} "
                f"disk error: {e}"
            )
            _backoff(attempt)
        except ChunkDownloadError as e:
            last_err = e
            logger.warning(
                f"sync_downloader: {chunk_hash[:12]}… attempt {attempt}/{retry_budget}: {e}"
            )
            _backoff(attempt)

    # retry budget exhausted
    state.set_chunk_state(
        distribution_id, chunk_hash, 'failed',
        error=f"after {retry_budget} attempts: {last_err}",
        increment_attempts=True,
    )
    raise ChunkDownloadError(
        f"chunk {chunk_hash[:12]}… failed after {retry_budget} attempts: {last_err}"
    )


def _backoff(attempt: int) -> None:
    wait = min(
        DEFAULT_RETRY_BACKOFF_BASE_S * (2 ** (attempt - 1)),
        DEFAULT_RETRY_BACKOFF_MAX_S,
    )
    time.sleep(wait)


def _hash_file(path: Path) -> str:
    """compute the lowercase-hex SHA-256 of a file's contents."""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            buf = f.read(_STREAM_CHUNK_BYTES)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()
