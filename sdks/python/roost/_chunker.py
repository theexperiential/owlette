"""Directory walk + sha-256 4 MiB chunker used by ``Roosts.push``.

Byte-compatible with ``cli/src/lib/chunker.ts`` and ``sdks/node/src/lib/chunker.ts`` —
same chunk size, same sort order, same zero-byte skip, same ignore defaults.
"""

from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator, Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

CHUNK_SIZE_BYTES = 4 * 1024 * 1024
_DEFAULT_IGNORE = frozenset({".git", "node_modules"})


@dataclass(slots=True)
class ChunkDescriptor:
    hash: str
    size: int


@dataclass(slots=True)
class ChunkedFileEntry:
    path: str
    size: int
    chunks: list[ChunkDescriptor]


@dataclass(slots=True)
class DiscoverProgress:
    phase: Literal["discover"]
    file_count: int
    total_bytes: int


@dataclass(slots=True)
class HashProgress:
    phase: Literal["hash"]
    file: str
    files_done: int
    files_total: int
    bytes_done: int
    bytes_total: int


ChunkProgressEvent = DiscoverProgress | HashProgress
ProgressCallback = Callable[[ChunkProgressEvent], None]


def _walk_files(root: Path, ignore: Iterable[str]) -> list[Path]:
    ignore_set = set(_DEFAULT_IGNORE) | set(ignore or ())
    abs_root = root.resolve()
    result: list[Path] = []

    def recur(directory: Path) -> None:
        for entry in directory.iterdir():
            if entry.name in ignore_set:
                continue
            if entry.is_symlink():
                try:
                    target = entry.resolve(strict=True)
                except (OSError, RuntimeError):
                    continue
                if abs_root not in target.parents and target != abs_root:
                    continue
                if target.is_dir():
                    recur(entry)
                elif target.is_file():
                    result.append(entry)
                continue
            if entry.is_dir():
                recur(entry)
            elif entry.is_file():
                result.append(entry)

    recur(abs_root)
    result.sort()
    return result


async def chunk_one_file(abs_path: Path, rel_path: str) -> ChunkedFileEntry:
    """Hash one file into a ChunkedFileEntry. Streaming, bounded memory."""
    size = abs_path.stat().st_size
    if size == 0:
        msg = f"chunker: {rel_path} is zero bytes; zero-byte files cannot be manifested"
        raise ValueError(msg)

    chunks: list[ChunkDescriptor] = []
    remaining_in_chunk = min(CHUNK_SIZE_BYTES, size)
    hasher = hashlib.sha256()
    current_chunk_size = 0
    bytes_read = 0

    with abs_path.open("rb") as fh:
        while bytes_read < size:
            to_read = min(remaining_in_chunk, 64 * 1024)
            buf = fh.read(to_read)
            if not buf:
                break
            hasher.update(buf)
            current_chunk_size += len(buf)
            remaining_in_chunk -= len(buf)
            bytes_read += len(buf)

            if remaining_in_chunk == 0:
                chunks.append(ChunkDescriptor(hash=hasher.hexdigest(), size=current_chunk_size))
                hasher = hashlib.sha256()
                current_chunk_size = 0
                remaining = size - bytes_read
                remaining_in_chunk = min(CHUNK_SIZE_BYTES, remaining)
                if remaining_in_chunk == 0:
                    break

    if current_chunk_size > 0:
        chunks.append(ChunkDescriptor(hash=hasher.hexdigest(), size=current_chunk_size))

    return ChunkedFileEntry(path=rel_path, size=size, chunks=chunks)


async def chunk_directory(
    root: str | Path,
    *,
    ignore: Sequence[str] = (),
    on_progress: ProgressCallback | None = None,
) -> list[ChunkedFileEntry]:
    """Chunk every non-zero file under ``root``."""
    abs_root = Path(root).resolve()
    files = _walk_files(abs_root, ignore)

    with_sizes: list[tuple[Path, str, int]] = []
    for abs_path in files:
        file_size = abs_path.stat().st_size
        if file_size == 0:
            continue
        rel = abs_path.relative_to(abs_root).as_posix()
        with_sizes.append((abs_path, rel, file_size))

    total_bytes = sum(s for _, _, s in with_sizes)
    if on_progress is not None:
        on_progress(DiscoverProgress(phase="discover", file_count=len(with_sizes), total_bytes=total_bytes))

    entries: list[ChunkedFileEntry] = []
    files_done = 0
    bytes_done = 0
    for abs_path, rel, file_size in with_sizes:
        if on_progress is not None:
            on_progress(
                HashProgress(
                    phase="hash",
                    file=rel,
                    files_done=files_done,
                    files_total=len(with_sizes),
                    bytes_done=bytes_done,
                    bytes_total=total_bytes,
                )
            )
        entry = await chunk_one_file(abs_path, rel)
        entries.append(entry)
        files_done += 1
        bytes_done += file_size

    if on_progress is not None:
        on_progress(
            HashProgress(
                phase="hash",
                file="",
                files_done=files_done,
                files_total=len(with_sizes),
                bytes_done=bytes_done,
                bytes_total=total_bytes,
            )
        )

    return entries


def unique_hashes(files: Sequence[ChunkedFileEntry]) -> list[str]:
    seen: dict[str, None] = {}
    for f in files:
        for c in f.chunks:
            seen.setdefault(c.hash)
    return list(seen)


async def _stream_chunk(abs_path: Path, offset: int, size: int) -> AsyncIterator[bytes]:
    """Async generator yielding bytes of one chunk from a file (unused today but handy for streaming uploads)."""
    with abs_path.open("rb") as fh:
        fh.seek(offset)
        remaining = size
        while remaining > 0:
            buf = fh.read(min(remaining, 64 * 1024))
            if not buf:
                break
            remaining -= len(buf)
            yield buf


__all__ = [
    "CHUNK_SIZE_BYTES",
    "ChunkDescriptor",
    "ChunkProgressEvent",
    "ChunkedFileEntry",
    "DiscoverProgress",
    "HashProgress",
    "ProgressCallback",
    "chunk_directory",
    "chunk_one_file",
    "unique_hashes",
]
