"""``roost.roosts`` — list, crud, push, rollback, deploy."""

from __future__ import annotations

import asyncio
import platform
import socket
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from roost._chunker import (
    ChunkProgressEvent,
    ChunkedFileEntry,
    chunk_directory,
    unique_hashes,
)

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from roost.client import RoostClient


SDK_VERSION = "0.1.0"
UPLOAD_CONCURRENCY = 8
CHECK_BATCH_SIZE = 900
PUSH_MAX_RETRIES = 5


@dataclass(slots=True)
class RoostSummary:
    roost_id: str
    site_id: str
    name: str
    targets: list[str]
    current_version_id: str | None
    previous_version_id: str | None
    created_at: str | None
    updated_at: str | None
    deleted_at: str | None


@dataclass(slots=True)
class VersionSummary:
    version_id: str
    version_number: int
    description: str | None
    version_url: str | None
    created_at: str | None
    created_by: str | None
    total_size: int
    total_files: int
    parent_version_id: str | None


@dataclass(slots=True)
class RoostDetail:
    roost_id: str
    site_id: str
    name: str
    targets: list[str]
    extract_path: str | None
    schema_version: int
    version_counter: int
    current_version_id: str | None
    previous_version_id: str | None
    version_url: str | None
    created_at: str | None
    updated_at: str | None
    deleted_at: str | None
    current_version: VersionSummary | None
    previous_version: VersionSummary | None


@dataclass(slots=True)
class RollbackOptions:
    site_id: str
    # Accepts any `version_ref` form: a positive integer (version number),
    # `#3` / `v3`, a `vrs_*` id, or alias `current` / `previous` / `first`.
    target_version: str | int | None = None
    idempotency_key: str | None = None


@dataclass(slots=True)
class RollbackResult:
    current_version_id: str
    previous_version_id: str | None


@dataclass(slots=True)
class DeployOptions:
    site_id: str
    version_id: str | None = None
    machines: list[str] | None = None
    schedule_at: str | None = None
    dry_run: bool = False
    idempotency_key: str | None = None


@dataclass(slots=True)
class DeployResult:
    rollout_id: str
    version_id: str
    site_id: str
    roost_id: str
    stage: str
    canary: list[str]
    fleet: list[str]
    extract_root: str
    version_url: str
    dry_run: bool = False
    already_running: bool = False
    scheduled: dict[str, Any] | None = None


@dataclass(slots=True)
class PushProgressCheckMissing:
    phase: Literal["check-missing"]
    total: int
    missing: int


@dataclass(slots=True)
class PushProgressUpload:
    phase: Literal["upload"]
    uploaded: int
    total: int


@dataclass(slots=True)
class PushProgressPublish:
    phase: Literal["publish"]
    attempt: int


PushProgressEvent = (
    ChunkProgressEvent | PushProgressCheckMissing | PushProgressUpload | PushProgressPublish
)


@dataclass(slots=True)
class PushOptions:
    site_id: str
    name: str | None = None
    targets: list[str] | None = None
    extract_path: str | None = None
    description: str | None = None
    on_progress: "Callable[[PushProgressEvent], None] | Callable[[PushProgressEvent], Awaitable[None]] | None" = None
    ignore: Sequence[str] = field(default_factory=tuple)


@dataclass(slots=True)
class PushStats:
    file_count: int
    total_bytes: int
    total_chunks: int
    unique_chunks: int
    uploaded_chunks: int


@dataclass(slots=True)
class PushResult:
    version_id: str
    version_number: int
    current_version_id: str
    previous_version_id: str | None
    stats: PushStats


class Roosts:
    """``roost.roosts.*`` — see SDK README for usage examples."""

    def __init__(self, client: "RoostClient") -> None:
        self._client = client

    # ----- paginated helpers -------------------------------------------------

    async def list_page(
        self,
        *,
        site_id: str,
        page_size: int | None = None,
        cursor: str | None = None,
        include_deleted: bool = False,
    ) -> tuple[list[RoostSummary], str]:
        """One page of roosts. Returns ``(rows, next_page_token)``."""
        resp = await self._client.request(
            "/api/roosts",
            query={
                "siteId": site_id,
                "limit": page_size,
                "cursor": cursor,
                "includeDeleted": "true" if include_deleted else None,
            },
        )
        data = resp.data if isinstance(resp.data, dict) else {}
        rows_raw = data.get("roosts", [])
        rows = [_roost_summary(r) for r in rows_raw if isinstance(r, dict)]
        return rows, str(data.get("nextPageToken") or "")

    async def list(
        self,
        *,
        site_id: str,
        include_deleted: bool = False,
        page_size: int = 50,
    ) -> AsyncIterator[RoostSummary]:
        """Auto-paginating async generator over all roosts on ``site_id``."""
        cursor: str | None = None
        while True:
            rows, next_token = await self.list_page(
                site_id=site_id,
                page_size=page_size,
                cursor=cursor,
                include_deleted=include_deleted,
            )
            for r in rows:
                yield r
            if not next_token:
                return
            cursor = next_token

    async def get(self, roost_id: str, *, site_id: str) -> RoostDetail:
        resp = await self._client.request(
            f"/api/roosts/{roost_id}",
            query={"siteId": site_id},
        )
        data = resp.data if isinstance(resp.data, dict) else {}
        return _roost_detail(data)

    async def create(
        self,
        *,
        site_id: str,
        name: str,
        targets: Sequence[str] | None = None,
        extract_path: str | None = None,
        roost_id: str | None = None,
    ) -> RoostSummary:
        body: dict[str, Any] = {"siteId": site_id, "name": name}
        if targets is not None:
            body["targets"] = list(targets)
        if extract_path is not None:
            body["extractPath"] = extract_path
        if roost_id is not None:
            body["roostId"] = roost_id
        resp = await self._client.request("/api/roosts", method="POST", body=body)
        return _roost_summary(resp.data if isinstance(resp.data, dict) else {})

    async def patch(
        self,
        roost_id: str,
        *,
        site_id: str,
        name: str | None = None,
        targets: Sequence[str] | None = None,
        extract_path: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"siteId": site_id}
        if name is not None:
            body["name"] = name
        if targets is not None:
            body["targets"] = list(targets)
        if extract_path is not None:
            body["extractPath"] = extract_path
        resp = await self._client.request(
            f"/api/roosts/{roost_id}",
            method="PATCH",
            body=body,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def remove(self, roost_id: str, *, site_id: str) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/roosts/{roost_id}",
            method="DELETE",
            query={"siteId": site_id},
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def rollback(self, roost_id: str, opts: RollbackOptions) -> RollbackResult:
        body: dict[str, Any] = {"siteId": opts.site_id}
        if opts.target_version is not None:
            body["targetVersion"] = opts.target_version
        headers: dict[str, str] = {}
        if opts.idempotency_key is not None:
            headers["Idempotency-Key"] = opts.idempotency_key
        resp = await self._client.request(
            f"/api/roosts/{roost_id}/rollback",
            method="POST",
            body=body,
            headers=headers or None,
        )
        data = resp.data if isinstance(resp.data, dict) else {}
        return RollbackResult(
            current_version_id=str(data.get("currentVersionId", "")),
            previous_version_id=data.get("previousVersionId"),
        )

    async def deploy(self, roost_id: str, opts: DeployOptions) -> DeployResult:
        body: dict[str, Any] = {"siteId": opts.site_id}
        if opts.version_id is not None:
            body["versionId"] = opts.version_id
        if opts.machines is not None:
            body["machines"] = list(opts.machines)
        if opts.schedule_at is not None:
            body["scheduleAt"] = opts.schedule_at
        if opts.dry_run:
            body["dryRun"] = True
        headers: dict[str, str] = {}
        if opts.idempotency_key is not None:
            headers["Idempotency-Key"] = opts.idempotency_key
        resp = await self._client.request(
            f"/api/roosts/{roost_id}/deploy",
            method="POST",
            body=body,
            headers=headers or None,
        )
        return _deploy_result(resp.data if isinstance(resp.data, dict) else {})

    # ----- flagship: push ----------------------------------------------------

    async def push(
        self,
        dir_path: str | Path,
        roost_id: str,
        opts: PushOptions,
    ) -> PushResult:
        async def emit(evt: PushProgressEvent) -> None:
            cb = opts.on_progress
            if cb is None:
                return
            result = cb(evt)
            if asyncio.iscoroutine(result):
                await result

        root = Path(dir_path)
        files = await chunk_directory(
            root,
            ignore=list(opts.ignore),
            on_progress=lambda evt: asyncio.get_event_loop().create_task(emit(evt))
            if asyncio.iscoroutinefunction(opts.on_progress)
            else (opts.on_progress(evt) if opts.on_progress else None),
        )
        if not files:
            msg = f"push: no non-empty files found under {root}"
            raise ValueError(msg)

        stats = _summarise(files)
        all_hashes = unique_hashes(files)
        missing = await self._check_missing(opts.site_id, all_hashes)
        await emit(
            PushProgressCheckMissing(phase="check-missing", total=len(all_hashes), missing=len(missing))
        )

        uploaded_chunks = 0
        if missing:
            urls = await self._mint_upload_urls(opts.site_id, missing)

            async def report_upload(done: int, total: int) -> None:
                await emit(PushProgressUpload(phase="upload", uploaded=done, total=total))

            uploaded_chunks = await self._upload_chunks(
                root, files, missing, urls, report_upload
            )

        version_body = _build_version_body(files)
        result = await self._publish_with_retry(
            roost_id=roost_id,
            site_id=opts.site_id,
            version=version_body,
            name=opts.name,
            targets=list(opts.targets) if opts.targets is not None else None,
            extract_path=opts.extract_path,
            description=opts.description,
            on_retry=lambda attempt: asyncio.create_task(
                emit(PushProgressPublish(phase="publish", attempt=attempt))
            ),
        )

        return PushResult(
            version_id=result["versionId"],
            version_number=int(result.get("versionNumber") or 0),
            current_version_id=result["currentVersionId"],
            previous_version_id=result.get("previousVersionId"),
            stats=PushStats(**{**stats, "uploaded_chunks": uploaded_chunks}),
        )

    # ----- internal helpers --------------------------------------------------

    async def _check_missing(self, site_id: str, hashes: Sequence[str]) -> list[str]:
        missing: list[str] = []
        for i in range(0, len(hashes), CHECK_BATCH_SIZE):
            batch = hashes[i : i + CHECK_BATCH_SIZE]
            resp = await self._client.request(
                "/api/chunks/check",
                method="POST",
                body={"siteId": site_id, "hashes": list(batch)},
            )
            data = resp.data if isinstance(resp.data, dict) else {}
            missing.extend(data.get("missing", []))
        return missing

    async def _mint_upload_urls(
        self, site_id: str, hashes: Sequence[str]
    ) -> dict[str, str]:
        out: dict[str, str] = {}
        for i in range(0, len(hashes), CHECK_BATCH_SIZE):
            batch = hashes[i : i + CHECK_BATCH_SIZE]
            resp = await self._client.request(
                "/api/chunks/upload-urls",
                method="POST",
                body={"siteId": site_id, "hashes": list(batch)},
            )
            data = resp.data if isinstance(resp.data, dict) else {}
            urls = data.get("urls", {})
            if isinstance(urls, dict):
                out.update({k: str(v) for k, v in urls.items() if isinstance(v, str)})
        return out

    async def _upload_chunks(
        self,
        root: Path,
        files: Sequence[ChunkedFileEntry],
        missing: Sequence[str],
        urls: dict[str, str],
        report: "Callable[[int, int], Awaitable[None]]",
    ) -> int:
        source_by_hash: dict[str, tuple[Path, int, int]] = {}
        for f in files:
            offset = 0
            for c in f.chunks:
                if c.hash not in source_by_hash:
                    source_by_hash[c.hash] = (root.joinpath(*f.path.split("/")), offset, c.size)
                offset += c.size

        queue: list[str] = list(missing)
        total = len(queue)
        uploaded = 0
        lock = asyncio.Lock()

        async def worker() -> None:
            nonlocal uploaded
            while True:
                async with lock:
                    if not queue:
                        return
                    digest = queue.pop(0)
                source = source_by_hash[digest]
                url = urls.get(digest)
                if url is None:
                    msg = f"internal: no upload url for {digest}"
                    raise RuntimeError(msg)
                await self._put_chunk(digest, *source, url)
                async with lock:
                    uploaded += 1
                    current = uploaded
                if current % 4 == 0 or current == total:
                    await report(current, total)

        tasks = [asyncio.create_task(worker()) for _ in range(min(UPLOAD_CONCURRENCY, total))]
        await asyncio.gather(*tasks)
        return uploaded

    async def _put_chunk(
        self, digest: str, abs_path: Path, offset: int, size: int, url: str
    ) -> None:
        with abs_path.open("rb") as fh:
            fh.seek(offset)
            body = fh.read(size)
        if len(body) != size:
            msg = f"chunk {digest}: expected {size} bytes, read {len(body)} from {abs_path}"
            raise RuntimeError(msg)

        last_err: Exception | None = None
        for attempt in range(2):
            try:
                response = await self._client._http.put(  # noqa: SLF001 — deliberate use of raw client
                    url,
                    content=body,
                    headers={"Content-Type": "application/octet-stream"},
                )
                if response.status_code >= 300:
                    msg = f"PUT {digest} → {response.status_code}"
                    raise RuntimeError(msg)
                return
            except Exception as err:  # noqa: BLE001
                last_err = err
                if attempt == 0:
                    await asyncio.sleep(0.25)
        if last_err is not None:
            raise last_err

    async def _publish_with_retry(
        self,
        *,
        roost_id: str,
        site_id: str,
        version: dict[str, Any],
        name: str | None,
        targets: list[str] | None,
        extract_path: str | None,
        description: str | None,
        on_retry: "Callable[[int], Any] | None",
    ) -> dict[str, Any]:
        from roost.client import RoostApiError  # local to avoid circular import

        expected_current: str | None = None
        last_err: Exception | None = None

        for attempt in range(PUSH_MAX_RETRIES):
            if attempt > 0 and on_retry is not None:
                on_retry(attempt)
            body: dict[str, Any] = {"siteId": site_id, "version": version}
            if expected_current is not None:
                body["expectedCurrentVersionId"] = expected_current
            if name is not None:
                body["name"] = name
            if targets is not None:
                body["targets"] = targets
            if extract_path is not None:
                body["extractPath"] = extract_path
            if description is not None:
                body["description"] = description
            try:
                resp = await self._client.request(
                    f"/api/roosts/{roost_id}/versions",
                    method="POST",
                    body=body,
                    no_retry=True,  # we drive the 412-retry ourselves
                )
                return resp.data if isinstance(resp.data, dict) else {}
            except RoostApiError as err:
                last_err = err
                if err.status != 412:
                    raise
                detail = err.problem.get("detail", "")
                if isinstance(detail, str):
                    # Parse "(<currentId>)" out of the 412 detail.
                    import re

                    match = re.search(r"\(([A-Za-z0-9_-]+|null)\)", detail)
                    if match is not None and match.group(1) != "null":
                        expected_current = match.group(1)
                        continue
                expected_current = None

        if last_err is not None:
            raise last_err
        msg = "version publish failed after retries"
        raise RuntimeError(msg)


# --------------------------------------------------------------------- #
#  parsers                                                              #
# --------------------------------------------------------------------- #

def _roost_summary(data: dict[str, Any]) -> RoostSummary:
    return RoostSummary(
        roost_id=str(data.get("roostId", "")),
        site_id=str(data.get("siteId", "")),
        name=str(data.get("name", "")),
        targets=list(data.get("targets") or []),
        current_version_id=data.get("currentVersionId"),
        previous_version_id=data.get("previousVersionId"),
        created_at=data.get("createdAt"),
        updated_at=data.get("updatedAt"),
        deleted_at=data.get("deletedAt"),
    )


def _version_summary(data: dict[str, Any] | None) -> VersionSummary | None:
    if data is None:
        return None
    return VersionSummary(
        version_id=str(data.get("versionId", "")),
        version_number=int(data.get("versionNumber") or 0),
        description=data.get("description"),
        version_url=data.get("versionUrl"),
        created_at=data.get("createdAt"),
        created_by=data.get("createdBy"),
        total_size=int(data.get("totalSize") or 0),
        total_files=int(data.get("totalFiles") or 0),
        parent_version_id=data.get("parentVersionId"),
    )


def _roost_detail(data: dict[str, Any]) -> RoostDetail:
    return RoostDetail(
        roost_id=str(data.get("roostId", "")),
        site_id=str(data.get("siteId", "")),
        name=str(data.get("name", "")),
        targets=list(data.get("targets") or []),
        extract_path=data.get("extractPath"),
        schema_version=int(data.get("schemaVersion") or 2),
        version_counter=int(data.get("versionCounter") or 0),
        current_version_id=data.get("currentVersionId"),
        previous_version_id=data.get("previousVersionId"),
        version_url=data.get("versionUrl"),
        created_at=data.get("createdAt"),
        updated_at=data.get("updatedAt"),
        deleted_at=data.get("deletedAt"),
        current_version=_version_summary(data.get("currentVersion")),
        previous_version=_version_summary(data.get("previousVersion")),
    )


def _deploy_result(data: dict[str, Any]) -> DeployResult:
    return DeployResult(
        rollout_id=str(data.get("rolloutId", "")),
        version_id=str(data.get("versionId", "")),
        site_id=str(data.get("siteId", "")),
        roost_id=str(data.get("roostId", "")),
        stage=str(data.get("stage", "")),
        canary=list(data.get("canary") or []),
        fleet=list(data.get("fleet") or []),
        extract_root=str(data.get("extractRoot", "")),
        version_url=str(data.get("versionUrl", "")),
        dry_run=bool(data.get("dryRun", False)),
        already_running=bool(data.get("alreadyRunning", False)),
        scheduled=data.get("scheduled") if isinstance(data.get("scheduled"), dict) else None,
    )


def _summarise(files: Sequence[ChunkedFileEntry]) -> dict[str, int]:
    total_bytes = 0
    total_chunks = 0
    unique: set[str] = set()
    for f in files:
        total_bytes += f.size
        total_chunks += len(f.chunks)
        for c in f.chunks:
            unique.add(c.hash)
    return {
        "file_count": len(files),
        "total_bytes": total_bytes,
        "total_chunks": total_chunks,
        "unique_chunks": len(unique),
    }


def _build_version_body(files: Sequence[ChunkedFileEntry]) -> dict[str, Any]:
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    sorted_files = sorted(files, key=lambda f: f.path)
    return {
        "schemaVersion": 2,
        "mediaType": "application/vnd.owlette.version.v1+json",
        "config": {
            "producer": "owlette-api python-sdk",
            "cliVersion": SDK_VERSION,
            "createdAt": now,
            "hostname": socket.gethostname(),
            "platform": platform.system().lower(),
        },
        "files": [
            {
                "path": f.path,
                "size": f.size,
                "chunks": [{"hash": c.hash, "size": c.size} for c in f.chunks],
            }
            for f in sorted_files
        ],
    }


__all__ = [
    "DeployOptions",
    "DeployResult",
    "PushOptions",
    "PushProgressCheckMissing",
    "PushProgressEvent",
    "PushProgressPublish",
    "PushProgressUpload",
    "PushResult",
    "PushStats",
    "RollbackOptions",
    "RollbackResult",
    "RoostDetail",
    "RoostSummary",
    "Roosts",
    "VersionSummary",
]
