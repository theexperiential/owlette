"""Chunker correctness — sha-256 matches stdlib hashlib on the same bytes."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from roost._chunker import CHUNK_SIZE_BYTES, chunk_directory, chunk_one_file, unique_hashes


@pytest.mark.asyncio
async def test_chunks_small_file_single_chunk(tmp_path: Path) -> None:
    f = tmp_path / "a.txt"
    f.write_bytes(b"hello world")
    entry = await chunk_one_file(f, "a.txt")
    expected = hashlib.sha256(b"hello world").hexdigest()
    assert entry.size == 11
    assert len(entry.chunks) == 1
    assert entry.chunks[0].hash == expected
    assert entry.chunks[0].size == 11


@pytest.mark.asyncio
async def test_chunks_file_larger_than_chunk_size(tmp_path: Path) -> None:
    f = tmp_path / "big.bin"
    data = bytes(i % 256 for i in range(CHUNK_SIZE_BYTES + 7))
    f.write_bytes(data)
    entry = await chunk_one_file(f, "big.bin")
    assert len(entry.chunks) == 2
    assert entry.chunks[0].size == CHUNK_SIZE_BYTES
    assert entry.chunks[1].size == 7
    assert entry.chunks[0].hash == hashlib.sha256(data[:CHUNK_SIZE_BYTES]).hexdigest()
    assert entry.chunks[1].hash == hashlib.sha256(data[CHUNK_SIZE_BYTES:]).hexdigest()


@pytest.mark.asyncio
async def test_zero_byte_file_raises(tmp_path: Path) -> None:
    f = tmp_path / "empty.txt"
    f.write_bytes(b"")
    with pytest.raises(ValueError, match="zero bytes"):
        await chunk_one_file(f, "empty.txt")


@pytest.mark.asyncio
async def test_chunk_directory_skips_zero_byte_and_ignored_dirs(tmp_path: Path) -> None:
    (tmp_path / "keep.txt").write_bytes(b"content")
    (tmp_path / "empty.txt").write_bytes(b"")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "nested.txt").write_bytes(b"n")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "ignored.txt").write_bytes(b"skip me")

    entries = await chunk_directory(tmp_path)
    paths = [e.path for e in entries]
    assert "keep.txt" in paths
    assert "sub/nested.txt" in paths
    assert "empty.txt" not in paths
    assert not any("node_modules" in p for p in paths)


@pytest.mark.asyncio
async def test_unique_hashes_dedups_across_files(tmp_path: Path) -> None:
    (tmp_path / "a.txt").write_bytes(b"same")
    (tmp_path / "b.txt").write_bytes(b"same")
    (tmp_path / "c.txt").write_bytes(b"diff")
    entries = await chunk_directory(tmp_path)
    hashes = unique_hashes(entries)
    # `same` dedups to one hash across a.txt + b.txt.
    assert len(hashes) == 2
