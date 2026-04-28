"""``roost.installer`` — agent installer binary management (superadmin).

Drives the wave-1B routes:

  GET    /api/installer
  POST   /api/installer/upload          — request signed upload url
  PUT    /api/installer/upload          — finalize upload (verify + write metadata)
  POST   /api/installer/{version}/set-latest
  DELETE /api/installer/{version}

``upload()`` is the canonical 3-step flow: it asks the server for a
signed PUT url, streams the binary up to that url, then PUTs back the
finalize call. The same ``Idempotency-Key`` is used on both POSTs and
the finalize PUT so a network retry replays cleanly.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

if TYPE_CHECKING:
    from roost.client import RoostClient


@dataclass(slots=True)
class InstallerVersion:
    version: str
    download_url: str | None
    checksum_sha256: str | None
    release_notes: str | None
    file_size: int | None
    uploaded_at: int | None
    uploaded_by: str | None
    deleted_at: int | None


def _parse_version(raw: dict[str, Any]) -> InstallerVersion:
    return InstallerVersion(
        version=str(raw.get("version", "")),
        download_url=raw.get("download_url"),
        checksum_sha256=raw.get("checksum_sha256"),
        release_notes=raw.get("release_notes"),
        file_size=raw.get("file_size"),
        uploaded_at=raw.get("uploaded_at"),
        uploaded_by=raw.get("uploaded_by"),
        deleted_at=raw.get("deletedAt"),
    )


class Installer:
    """Installer binary metadata + upload flow (wave 1B, superadmin-only)."""

    def __init__(self, client: "RoostClient") -> None:
        self._client = client
        # Test hook — assign an httpx.AsyncBaseTransport instance to route
        # the signed-url PUT through a MockTransport. Production code never
        # touches this.
        self._upload_transport: httpx.AsyncBaseTransport | None = None

    async def list(
        self,
        *,
        include_deleted: bool = False,
        page_size: int | None = None,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        """List uploaded installer versions, newest first."""
        query: dict[str, Any] = {}
        if include_deleted:
            query["includeDeleted"] = True
        if page_size is not None:
            query["page_size"] = page_size
        if page_token:
            query["page_token"] = page_token
        resp = await self._client.request(
            "/api/installer",
            query=query or None,
        )
        data = resp.data if isinstance(resp.data, dict) else {}
        versions = [
            _parse_version(v)
            for v in (data.get("versions") or [])
            if isinstance(v, dict)
        ]
        return {
            "versions": versions,
            "next_page_token": str(data.get("nextPageToken") or ""),
        }

    async def upload(
        self,
        file_path: str | os.PathLike[str],
        *,
        version: str,
        release_notes: str | None = None,
        set_as_latest: bool = True,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Upload an installer binary in 3 steps:

        1. POST /api/installer/upload  → signed PUT url + uploadId
        2. PUT  <signed url>           → binary bytes
        3. PUT  /api/installer/upload  → finalize (server verifies + writes metadata)

        Same ``Idempotency-Key`` is used on the POST + finalize PUT so a
        retry of the whole flow replays cached responses on both ends.
        """
        path = Path(file_path)
        binary = path.read_bytes()
        file_size = len(binary)
        checksum = hashlib.sha256(binary).hexdigest()
        file_name = path.name

        idem = idempotency_key or f"py-sdk-installer-upload-{uuid.uuid4()}"

        # ── step 1: request signed upload url ─────────────────────────────
        start_body: dict[str, Any] = {
            "version": version,
            "fileName": file_name,
            "setAsLatest": set_as_latest,
        }
        if release_notes is not None:
            start_body["releaseNotes"] = release_notes

        start_resp = await self._client.request(
            "/api/installer/upload",
            method="POST",
            body=start_body,
            idempotency_key=idem,
        )
        start_data = start_resp.data if isinstance(start_resp.data, dict) else {}
        upload_url = start_data.get("uploadUrl")
        upload_id = start_data.get("uploadId")
        if not upload_url or not upload_id:
            msg = "installer.upload: server response missing uploadUrl or uploadId"
            raise RuntimeError(msg)

        # ── step 2: PUT binary to signed url (no auth header) ─────────────
        # We use a one-shot httpx.AsyncClient so we don't pollute the SDK
        # client's default Authorization / Roost-Version headers — the
        # signed url is pre-authenticated and rejects extra headers.
        client_kwargs: dict[str, Any] = {}
        if self._upload_transport is not None:
            client_kwargs["transport"] = self._upload_transport
        async with httpx.AsyncClient(**client_kwargs) as raw:
            put_resp = await raw.put(
                str(upload_url),
                content=binary,
                headers={
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(file_size),
                },
            )
        if put_resp.status_code >= 400:
            msg = (
                f"installer.upload: signed PUT failed "
                f"(status={put_resp.status_code}, body={put_resp.text[:200]!r})"
            )
            raise RuntimeError(msg)

        # ── step 3: finalize ──────────────────────────────────────────────
        finalize_resp = await self._client.request(
            "/api/installer/upload",
            method="PUT",
            body={"uploadId": upload_id, "checksum_sha256": checksum},
            idempotency_key=idem,
        )
        return finalize_resp.data if isinstance(finalize_resp.data, dict) else {}

    async def set_latest(
        self,
        version: str,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        resp = await self._client.request(
            f"/api/installer/{version}/set-latest",
            method="POST",
            body={},
            idempotency_key=idempotency_key,
        )
        return resp.data if isinstance(resp.data, dict) else {}

    async def delete(
        self,
        version: str,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        # Preserve a resource-specific prefix rather than the core client's
        # generic py-sdk DELETE key.
        idem = idempotency_key or f"py-sdk-installer-delete-{uuid.uuid4()}"
        resp = await self._client.request(
            f"/api/installer/{version}",
            method="DELETE",
            headers={"Idempotency-Key": idem},
        )
        return resp.data if isinstance(resp.data, dict) else {}


__all__ = ["Installer", "InstallerVersion"]
