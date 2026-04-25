"""``owlette-roost`` — async Python SDK for the roost public API.

Typical usage::

    import asyncio
    from roost import Roost, PushOptions

    async def main() -> None:
        async with Roost(token="owk_live_...") as client:
            result = await client.roosts.push(
                "./dist",
                "rst_abc",
                PushOptions(site_id="site-1", on_progress=print),
            )
            print(result.version_id, "v" + str(result.version_number))

    asyncio.run(main())
"""

from __future__ import annotations

from types import TracebackType
from typing import TYPE_CHECKING

from roost._chunker import (
    CHUNK_SIZE_BYTES,
    ChunkDescriptor,
    ChunkedFileEntry,
    ChunkProgressEvent,
    DiscoverProgress,
    HashProgress,
)
from roost.client import (
    DEFAULT_API_URL,
    DEFAULT_ROOST_VERSION,
    SDK_VERSION,
    ApiResponse,
    Environment,
    RetryPolicy,
    RoostApiError,
    RoostClient,
)
from roost.resources import (
    ApiKeyRecord,
    ApiKeyScope,
    Chunks,
    DeployOptions,
    DeployResult,
    Deployments,
    Keys,
    MachineDeployment,
    MachineDetail,
    MachineSummary,
    Machines,
    PushOptions,
    PushResult,
    QuotaHistoryDay,
    QuotaSnapshot,
    Quotas,
    RollbackOptions,
    RollbackResult,
    RoostDetail,
    Roosts,
    RoostSummary,
    Site,
    Sites,
    VersionSummary,
    Versions,
    WebhookSubscription,
    Webhooks,
)
from roost.signature import (
    DEFAULT_REPLAY_TOLERANCE_SECONDS,
    VerifyReason,
    VerifySignatureResult,
    is_signature_valid,
    sign_body,
    verify_signature,
)

if TYPE_CHECKING:
    import httpx


class Roost:
    """Top-level async client. Use as an async context manager to ensure ``close()``.

    Resources are lazily instantiated on first access — constructor is cheap.
    """

    def __init__(
        self,
        *,
        token: str,
        api_url: str = DEFAULT_API_URL,
        roost_version: str = DEFAULT_ROOST_VERSION,
        environment: Environment | None = None,
        retry: RetryPolicy | None = None,
        transport: "httpx.AsyncBaseTransport | None" = None,
        timeout: float = 30.0,
    ) -> None:
        client_kwargs: dict[str, object] = {
            "token": token,
            "api_url": api_url,
            "roost_version": roost_version,
            "timeout": timeout,
        }
        if environment is not None:
            client_kwargs["environment"] = environment
        if retry is not None:
            client_kwargs["retry"] = retry
        if transport is not None:
            client_kwargs["transport"] = transport
        self._client = RoostClient(**client_kwargs)  # type: ignore[arg-type]

        self._roosts: Roosts | None = None
        self._chunks: Chunks | None = None
        self._versions: Versions | None = None
        self._deployments: Deployments | None = None
        self._webhooks: Webhooks | None = None
        self._keys: Keys | None = None
        self._sites: Sites | None = None
        self._machines: Machines | None = None
        self._quotas: Quotas | None = None

    # ----- async context manager --------------------------------------------

    async def __aenter__(self) -> "Roost":
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.close()

    async def close(self) -> None:
        await self._client.close()

    # ----- resource accessors -----------------------------------------------

    @property
    def http(self) -> RoostClient:
        """The raw low-level client for escape-hatch calls."""
        return self._client

    @property
    def roosts(self) -> Roosts:
        if self._roosts is None:
            self._roosts = Roosts(self._client)
        return self._roosts

    @property
    def chunks(self) -> Chunks:
        if self._chunks is None:
            self._chunks = Chunks(self._client)
        return self._chunks

    @property
    def versions(self) -> Versions:
        if self._versions is None:
            self._versions = Versions(self._client)
        return self._versions

    @property
    def deployments(self) -> Deployments:
        if self._deployments is None:
            self._deployments = Deployments(self._client)
        return self._deployments

    @property
    def webhooks(self) -> Webhooks:
        if self._webhooks is None:
            self._webhooks = Webhooks(self._client)
        return self._webhooks

    @property
    def keys(self) -> Keys:
        if self._keys is None:
            self._keys = Keys(self._client)
        return self._keys

    @property
    def sites(self) -> Sites:
        if self._sites is None:
            self._sites = Sites(self._client)
        return self._sites

    @property
    def machines(self) -> Machines:
        if self._machines is None:
            self._machines = Machines(self._client)
        return self._machines

    @property
    def quotas(self) -> Quotas:
        if self._quotas is None:
            self._quotas = Quotas(self._client)
        return self._quotas


__version__ = SDK_VERSION

__all__ = [
    "CHUNK_SIZE_BYTES",
    "DEFAULT_API_URL",
    "DEFAULT_REPLAY_TOLERANCE_SECONDS",
    "DEFAULT_ROOST_VERSION",
    "SDK_VERSION",
    "ApiKeyRecord",
    "ApiKeyScope",
    "ApiResponse",
    "ChunkDescriptor",
    "ChunkProgressEvent",
    "ChunkedFileEntry",
    "Chunks",
    "DeployOptions",
    "DeployResult",
    "Deployments",
    "DiscoverProgress",
    "Environment",
    "HashProgress",
    "Keys",
    "MachineDeployment",
    "MachineDetail",
    "MachineSummary",
    "Machines",
    "PushOptions",
    "PushResult",
    "QuotaHistoryDay",
    "QuotaSnapshot",
    "Quotas",
    "RetryPolicy",
    "RollbackOptions",
    "RollbackResult",
    "Roost",
    "RoostApiError",
    "RoostClient",
    "RoostDetail",
    "RoostSummary",
    "Roosts",
    "Site",
    "Sites",
    "VerifyReason",
    "VerifySignatureResult",
    "VersionSummary",
    "Versions",
    "WebhookSubscription",
    "Webhooks",
    "__version__",
    "is_signature_valid",
    "sign_body",
    "verify_signature",
]
