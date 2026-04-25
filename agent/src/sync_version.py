"""
sync_version — version fetch + cache + diff for roost (project distribution v2).

a version is the OCI-derived JSON document that lists every file in a
roost along with its chunk hashes. agents fetch the version from R2
(URL given in the firestore pointer doc), cache it locally, and compute
the chunk-set delta against what's already on disk to know what to download.

design:
- version is JSON conforming to docs/internal/manifest-format.md
- cached at %PROGRAMDATA%\Owlette\versions\{roostId}\{versionId}.json on
  windows (XDG-equivalent on POSIX). kept OUT of the user's Documents tree
  so operators don't see cache data mixed with assembled files.
- diff against previous local version yields: chunks_to_fetch, chunks_to_keep,
  files_to_create, files_to_delete, files_to_keep
- network errors retry via existing requests-library patterns (see installer_utils)
- fail-loud on schema validation: a version with `schemaVersion != 2`
  is rejected outright (forward-compat is via mediaType, not version bumps)

NOT this module's job:
- chunk download (sync_downloader)
- file reassembly (sync_assembler)
- HTTP signed URL refresh (caller passes a fresh URL each fetch)
- writing to firestore (sync_commands does that)
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, List, Optional, Set

import requests

logger = logging.getLogger(__name__)

def _default_cache_dir() -> str:
    """
    resolve the default version cache directory.

    windows: %PROGRAMDATA%\\Owlette\\versions
    POSIX:   $XDG_DATA_HOME/owlette/versions, else ~/.local/share/owlette/versions

    see sync_state._default_state_db_path() for why we avoid `~/Documents/`
    under LocalSystem.
    """
    if os.name == 'nt':
        program_data = os.environ.get('PROGRAMDATA', 'C:\\ProgramData')
        return os.path.join(program_data, 'Owlette', 'versions')
    xdg = os.environ.get('XDG_DATA_HOME')
    if xdg:
        return os.path.join(xdg, 'owlette', 'versions')
    return os.path.join(os.path.expanduser('~'), '.local', 'share', 'owlette', 'versions')


DEFAULT_CACHE_DIR = _default_cache_dir()

# version mediatype + schema version we know how to consume.
VERSION_MEDIA_TYPE = 'application/vnd.owlette.version.v1+json'
VERSION_SCHEMA_VERSION = 2

# HTTP fetch tuning. mirror installer_utils patterns.
_FETCH_CONNECT_TIMEOUT_S = 30
_FETCH_READ_TIMEOUT_S = 120
_FETCH_RETRIES = 3
_FETCH_BACKOFF_BASE_S = 5

# version size sanity check (refuse fetches >50MB; the largest realistic
# version is ~20MB at 500GB project / 4MiB chunks).
MAX_VERSION_SIZE_BYTES = 50 * 1024 * 1024


class VersionError(Exception):
    """raised when version fetch, validation, or parsing fails."""
    pass


@dataclass(frozen=True)
class VersionChunk:
    hash: str
    size: int


@dataclass(frozen=True)
class VersionFile:
    path: str
    size: int
    chunks: List[VersionChunk]


@dataclass(frozen=True)
class Version:
    """parsed, validated version. the canonical in-memory shape."""
    schema_version: int
    media_type: str
    config: dict
    files: List[VersionFile]
    raw_bytes: bytes  # original bytes (for hash + cache write)

    @property
    def total_size(self) -> int:
        return sum(f.size for f in self.files)

    @property
    def total_files(self) -> int:
        return len(self.files)

    @property
    def chunks(self) -> Set[str]:
        """set of unique chunk hashes referenced by this version."""
        return {c.hash for f in self.files for c in f.chunks}

    @property
    def chunk_size_index(self) -> dict:
        """{hash: size} for every unique chunk (dedup-aware)."""
        out: dict = {}
        for f in self.files:
            for c in f.chunks:
                out[c.hash] = c.size
        return out


@dataclass(frozen=True)
class VersionDiff:
    """delta between two versions (or new vs nothing)."""
    chunks_to_fetch: Set[str]    # in new, not in old
    chunks_unused: Set[str]       # in old, not in new (eligible for GC after assemble)
    files_added: List[VersionFile]
    files_removed: List[VersionFile]
    files_changed: List[VersionFile]
    files_unchanged: List[VersionFile]


# ─── public api ──────────────────────────────────────────────────────


def fetch_version(
    url: str,
    expected_version_id: Optional[str] = None,
    cache_dir: Optional[str] = None,
) -> Version:
    """
    fetch a version from an R2 signed URL, validate it, cache it locally,
    return the parsed in-memory shape.

    expected_version_id: if provided, the cached file is named after this
    id and a cache-hit short-circuits the HTTP fetch. callers SHOULD pass
    this so re-fetches of the same version are local hits.

    raises VersionError on any failure (network, parse, schema).
    """
    cache_path: Optional[Path] = None
    if expected_version_id is not None:
        if cache_dir is None:
            cache_root = Path(_default_cache_dir())
        else:
            cache_root = Path(os.path.expanduser(cache_dir))
        cache_path = cache_root / f'{expected_version_id}.json'
        if cache_path.exists():
            logger.debug(f"sync_version: cache hit at {cache_path}")
            try:
                raw = cache_path.read_bytes()
                return _parse_and_validate(raw)
            except (OSError, VersionError) as e:
                # cache corrupt or schema drift — fall through to refetch.
                logger.warning(
                    f"sync_version: cache miss-validate at {cache_path}: {e}; refetching"
                )

    raw = _http_fetch(url)
    version = _parse_and_validate(raw)
    if cache_path is not None:
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_bytes(raw)
        except OSError as e:
            # caching is best-effort; log but don't fail the fetch.
            logger.warning(f"sync_version: failed to cache at {cache_path}: {e}")
    return version


def diff_versions(
    new: Version, old: Optional[Version]
) -> VersionDiff:
    """
    compute the delta between a new version and the previously-installed
    one. if old is None (first install), every chunk + file is "added".
    """
    new_chunks = new.chunks
    new_files_by_path = {f.path: f for f in new.files}
    if old is None:
        return VersionDiff(
            chunks_to_fetch=new_chunks,
            chunks_unused=set(),
            files_added=list(new.files),
            files_removed=[],
            files_changed=[],
            files_unchanged=[],
        )
    old_chunks = old.chunks
    old_files_by_path = {f.path: f for f in old.files}

    files_added: List[VersionFile] = []
    files_removed: List[VersionFile] = []
    files_changed: List[VersionFile] = []
    files_unchanged: List[VersionFile] = []

    for path, nf in new_files_by_path.items():
        of = old_files_by_path.get(path)
        if of is None:
            files_added.append(nf)
        elif _files_identical(nf, of):
            files_unchanged.append(nf)
        else:
            files_changed.append(nf)
    for path, of in old_files_by_path.items():
        if path not in new_files_by_path:
            files_removed.append(of)

    return VersionDiff(
        chunks_to_fetch=new_chunks - old_chunks,
        chunks_unused=old_chunks - new_chunks,
        files_added=files_added,
        files_removed=files_removed,
        files_changed=files_changed,
        files_unchanged=files_unchanged,
    )


# ─── internals ───────────────────────────────────────────────────────


def _http_fetch(url: str) -> bytes:
    """
    fetch the version body with retries + exponential backoff. mirrors
    installer_utils download patterns but smaller-scoped (no streaming
    needed — versions are bounded).
    """
    last_exc: Optional[Exception] = None
    for attempt in range(1, _FETCH_RETRIES + 1):
        try:
            resp = requests.get(
                url,
                timeout=(_FETCH_CONNECT_TIMEOUT_S, _FETCH_READ_TIMEOUT_S),
                allow_redirects=True,
                stream=True,
            )
            resp.raise_for_status()
            content_length = resp.headers.get('Content-Length')
            if content_length and int(content_length) > MAX_VERSION_SIZE_BYTES:
                raise VersionError(
                    f"version too large: {content_length} bytes (max {MAX_VERSION_SIZE_BYTES})"
                )
            # read with size cap so a misconfigured server can't OOM us.
            chunks_buf = []
            received = 0
            for chunk in resp.iter_content(chunk_size=64 * 1024):
                if chunk:
                    received += len(chunk)
                    if received > MAX_VERSION_SIZE_BYTES:
                        raise VersionError(
                            f"version exceeded {MAX_VERSION_SIZE_BYTES} bytes mid-stream"
                        )
                    chunks_buf.append(chunk)
            return b''.join(chunks_buf)
        except (requests.RequestException, ValueError) as e:
            last_exc = e
            if attempt < _FETCH_RETRIES:
                wait = _FETCH_BACKOFF_BASE_S * (2 ** (attempt - 1))
                logger.warning(
                    f"sync_version: fetch attempt {attempt} failed ({e}); "
                    f"retrying in {wait}s"
                )
                time.sleep(wait)
    raise VersionError(f"version fetch failed after {_FETCH_RETRIES} attempts: {last_exc}")


def _parse_and_validate(raw: bytes) -> Version:
    """parse raw bytes as JSON version and run schema validation."""
    try:
        data = json.loads(raw.decode('utf-8'))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise VersionError(f"version is not valid utf-8 json: {e}") from e

    if not isinstance(data, dict):
        raise VersionError(f"version must be a json object, got {type(data).__name__}")

    schema_version = data.get('schemaVersion')
    if schema_version != VERSION_SCHEMA_VERSION:
        raise VersionError(
            f"unsupported version schemaVersion: {schema_version!r} "
            f"(this agent supports {VERSION_SCHEMA_VERSION})"
        )

    media_type = data.get('mediaType')
    if media_type != VERSION_MEDIA_TYPE:
        raise VersionError(
            f"unsupported version mediaType: {media_type!r} "
            f"(this agent supports {VERSION_MEDIA_TYPE})"
        )

    config = data.get('config')
    if not isinstance(config, dict):
        raise VersionError("version.config must be an object")

    raw_files = data.get('files')
    if not isinstance(raw_files, list):
        raise VersionError("version.files must be an array")

    parsed_files: List[VersionFile] = []
    seen_paths: Set[str] = set()
    for i, fdata in enumerate(raw_files):
        if not isinstance(fdata, dict):
            raise VersionError(f"version.files[{i}] must be an object")
        path = fdata.get('path')
        if not isinstance(path, str) or not path:
            raise VersionError(f"version.files[{i}].path must be a non-empty string")
        if path in seen_paths:
            raise VersionError(f"version.files[{i}].path duplicated: {path!r}")
        seen_paths.add(path)
        # path constraints (wave 4b.2): POSIX-style relative path only.
        # rejects absolute paths, traversal segments, drive-letter prefixes,
        # embedded NUL bytes, dot / empty segments. realpath enforcement at
        # write-time is done by destination_allowlist; these checks fail
        # the version loudly BEFORE any disk work begins so a hostile
        # version never gets cached or partially applied.
        if _invalid_version_path(path):
            raise VersionError(
                f"version.files[{i}].path violates path constraints: {path!r}"
            )
        size = fdata.get('size')
        if not isinstance(size, int) or size < 0:
            raise VersionError(f"version.files[{i}].size must be non-negative int")
        raw_chunks = fdata.get('chunks')
        if not isinstance(raw_chunks, list):
            raise VersionError(f"version.files[{i}].chunks must be an array")
        parsed_chunks: List[VersionChunk] = []
        chunk_total = 0
        for j, cdata in enumerate(raw_chunks):
            if not isinstance(cdata, dict):
                raise VersionError(f"version.files[{i}].chunks[{j}] must be an object")
            chash = cdata.get('hash')
            csize = cdata.get('size')
            if not isinstance(chash, str) or len(chash) != 64 or not all(
                c in '0123456789abcdef' for c in chash
            ):
                raise VersionError(
                    f"version.files[{i}].chunks[{j}].hash must be lowercase 64-char sha-256 hex"
                )
            if not isinstance(csize, int) or csize <= 0:
                raise VersionError(
                    f"version.files[{i}].chunks[{j}].size must be positive int"
                )
            parsed_chunks.append(VersionChunk(hash=chash, size=csize))
            chunk_total += csize
        # the sum of chunk sizes must equal the file size — catches versions
        # generated against a different file than what's listed.
        if chunk_total != size:
            raise VersionError(
                f"version.files[{i}] chunk sizes sum to {chunk_total} but file size is {size}"
            )
        parsed_files.append(VersionFile(path=path, size=size, chunks=parsed_chunks))

    return Version(
        schema_version=schema_version,
        media_type=media_type,
        config=config,
        files=parsed_files,
        raw_bytes=raw,
    )


def _invalid_version_path(path: str) -> bool:
    """
    true if `path` is NOT safe to use as a version file path (wave 4b.2).

    reject:
    - NUL byte anywhere (smuggles past string comparisons; truncates on
      some syscalls; rare enough that legitimate versions never contain it)
    - absolute paths (`/foo`, `\foo`, `C:/foo`, `C:\foo`, `\\server\share\foo`)
    - windows drive-letter relative paths (`C:foo` — relative to drive's cwd)
    - `..` as any normalized segment (path traversal)
    - `.` as any segment (ambiguous; would be normalized away anyway —
      reject to keep versions canonical)
    - empty segments (`a//b` splits to `['a', '', 'b']`; reject so the
      version stays canonical across generators)

    realpath + reparse-point checks are destination_allowlist's job at
    write-time; this function filters before any disk touch.
    """
    if not path:
        return True
    if '\x00' in path:
        return True
    # normalize to forward slashes for segment analysis. after this:
    #   "a\\b\\c" -> "a/b/c"
    #   "C:\\foo" -> "C:/foo"
    normalized = path.replace('\\', '/')
    if normalized.startswith('/'):
        return True
    # windows drive-letter prefix: single letter + colon at position 1.
    # catches `C:foo` (drive-relative), `C:/foo` (drive-absolute), and also
    # defeats ADS attempts on the first segment (`foo:bar` in seg 0).
    # NOTE: '.' in file extensions is fine; we only flag an early colon.
    if len(normalized) >= 2 and normalized[1] == ':':
        return True
    segments = normalized.split('/')
    for seg in segments:
        if seg in ('', '.', '..'):
            return True
        # NUL was checked above; colons appearing in non-leading segments
        # are windows ADS (`file.toe:hidden`). destination_allowlist also
        # rejects these at validate-time, but fail-loud at version level.
        if ':' in seg:
            return True
    return False


def _files_identical(a: VersionFile, b: VersionFile) -> bool:
    """two VersionFile entries are identical iff they have the same chunk hash sequence."""
    if a.size != b.size:
        return False
    if len(a.chunks) != len(b.chunks):
        return False
    for ac, bc in zip(a.chunks, b.chunks):
        if ac.hash != bc.hash:
            return False
    return True
