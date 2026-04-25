"""Resource classes exposed as attributes on the top-level ``Roost`` client."""

from roost.resources.chunks import Chunks
from roost.resources.deployments import Deployments
from roost.resources.keys import ApiKeyRecord, ApiKeyScope, Keys
from roost.resources.machines import MachineDeployment, MachineDetail, MachineSummary, Machines
from roost.resources.quotas import QuotaHistoryDay, QuotaSnapshot, Quotas
from roost.resources.roosts import (
    DeployOptions,
    DeployResult,
    PushOptions,
    PushResult,
    RollbackOptions,
    RollbackResult,
    RoostDetail,
    Roosts,
    RoostSummary,
    VersionSummary,
)
from roost.resources.sites import Site, Sites
from roost.resources.versions import Versions
from roost.resources.webhooks import WebhookSubscription, Webhooks

__all__ = [
    "ApiKeyRecord",
    "ApiKeyScope",
    "Chunks",
    "DeployOptions",
    "DeployResult",
    "Deployments",
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
    "RollbackOptions",
    "RollbackResult",
    "RoostDetail",
    "RoostSummary",
    "Roosts",
    "Site",
    "Sites",
    "VersionSummary",
    "Versions",
    "WebhookSubscription",
    "Webhooks",
]
