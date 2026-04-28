---
hide:
  - navigation
---

# cli readiness matrix

Status as of 2026-04-28. Source of truth for registered commands is `cli/src/index.ts` plus `cli/src/commands/**`.

Legend:

- **ready** - command hits a public API route today.
- **local** - command only changes local CLI state.
- **stub** - command is registered and exits 3 with the canonical stub envelope.
- **planned** - public routes exist, but no `owlette` noun is registered yet.

## top-level commands

| command | status | public route or reason |
|---|---|---|
| `owlette auth login` | ready | `POST /api/cli/device-code`, then `POST /api/cli/device-code/poll` |
| `owlette auth status` | ready | alias of `owlette whoami`; `GET /api/whoami` |
| `owlette auth logout` | local | clears the active profile token in `~/.config/owlette/config.toml`; no API call |
| `owlette whoami` | ready | `GET /api/whoami` |
| `owlette version` | ready | `GET /api/version` |
| `owlette rollback <roostId>` | ready | `GET /api/roosts/{roostId}`, `GET /api/roosts/{roostId}/versions/{versionRef}/diff`, `POST /api/roosts/{roostId}/rollback` |
| `owlette listen` | ready preview | `GET /api/events/stream?siteId=<siteId>`; scoped SSE liveness transport only until production fanout ships |
| `owlette trigger <event>` | ready | direct mode posts to the caller's URL; `--via-api` uses `POST /api/webhooks/probe?siteId=<siteId>` |

## roost

| command | status | public route or reason |
|---|---|---|
| `owlette roost push <dir>` | ready | `POST /api/chunks/check`, `POST /api/chunks/upload-urls`, signed `PUT`, `POST /api/roosts/{roostId}/versions` |
| `owlette roost list` | ready | `GET /api/roosts?siteId=<siteId>` |
| `owlette roost get <roostId>` | ready | `GET /api/roosts/{roostId}?siteId=<siteId>` |
| `owlette roost diff <roostId>` | ready | `GET /api/roosts/{roostId}/versions/{versionRef}/diff?siteId=<siteId>&against=<versionRef>` |
| `owlette roost versions <roostId>` | ready | `GET /api/roosts/{roostId}/versions?siteId=<siteId>` |
| `owlette roost deploy <roostId>` | ready | `POST /api/roosts/{roostId}/deploy` |

## site-scoped operator nouns

| command | status | public route or reason |
|---|---|---|
| `owlette site list` | ready | `GET /api/sites` |
| `owlette site get <siteId>` | ready | `GET /api/sites/{siteId}` |
| `owlette quota show` | ready | `GET /api/sites/{siteId}/quota` |
| `owlette quota history` | ready | `GET /api/sites/{siteId}/quota/history?period=<period>` |
| `owlette audit-log list` | ready | `GET /api/sites/{siteId}/audit-log` |
| `owlette audit-log get <recordHash>` | ready | `GET /api/sites/{siteId}/audit-log/{recordHash}` |

## machine

| command | status | public route or reason |
|---|---|---|
| `owlette machine list` | ready | `GET /api/sites/{siteId}/machines` |
| `owlette machine get <machineId>` | ready | `GET /api/sites/{siteId}/machines/{machineId}` |
| `owlette machine deployments <machineId>` | ready | `GET /api/sites/{siteId}/machines/{machineId}/deployments` |
| `owlette machine reboot <machineId>` | ready | `POST /api/sites/{siteId}/machines/{machineId}/commands` with `type=reboot_machine` |
| `owlette machine shutdown <machineId>` | ready | `POST /api/sites/{siteId}/machines/{machineId}/commands` with `type=shutdown_machine` |
| `owlette machine screenshot <machineId>` | ready | `POST /api/sites/{siteId}/machines/{machineId}/commands` with `type=capture_screenshot`, then `GET /api/sites/{siteId}/machines/{machineId}/commands/{commandId}` |
| `owlette machine live-view <machineId>` | stub | no public route yet; `public-api deferred: live-view-webrtc` |

## cortex chat

| command | status | public route or reason |
|---|---|---|
| `owlette chat new` | ready | `POST /api/cortex/conversations` |
| `owlette chat list` | ready | `GET /api/cortex/conversations?siteId=<siteId>` |
| `owlette chat send <conversationId> <message>` | ready | `POST /api/cortex/conversations/{conversationId}` |
| `owlette chat delete <conversationId>` | ready | `DELETE /api/cortex/conversations/{conversationId}` |
| `owlette chat rename <conversationId> <title>` | ready | `PATCH /api/cortex/conversations/{conversationId}` |

## classic deployments

| command | status | public route or reason |
|---|---|---|
| `owlette deploy create` | ready | `POST /api/sites/{siteId}/deployments` |
| `owlette deploy list` | ready | `GET /api/sites/{siteId}/deployments` |
| `owlette deploy get <deploymentId>` | ready | `GET /api/sites/{siteId}/deployments/{deploymentId}` |
| `owlette deploy retry <deploymentId>` | ready | `POST /api/sites/{siteId}/deployments/{deploymentId}/retry` |
| `owlette deploy cancel <deploymentId>` | ready | `POST /api/sites/{siteId}/deployments/{deploymentId}/cancel` |
| `owlette deploy uninstall <deploymentId>` | ready | `POST /api/sites/{siteId}/deployments/{deploymentId}/uninstall` |
| `owlette deploy delete <deploymentId>` | ready | `DELETE /api/sites/{siteId}/deployments/{deploymentId}` |

## process

| command | status | public route or reason |
|---|---|---|
| `owlette process list` | ready | `GET /api/sites/{siteId}/machines/{machineId}/processes` |
| `owlette process get <processId>` | ready | `GET /api/sites/{siteId}/machines/{machineId}/processes/{processId}` |
| `owlette process create` | ready | `POST /api/sites/{siteId}/machines/{machineId}/processes` |
| `owlette process update <processId>` | ready | `PATCH /api/sites/{siteId}/machines/{machineId}/processes/{processId}` |
| `owlette process delete <processId>` | ready | `DELETE /api/sites/{siteId}/machines/{machineId}/processes/{processId}` |
| `owlette process schedule <processId>` | ready | `POST /api/sites/{siteId}/machines/{machineId}/processes/{processId}/schedule` |
| `owlette process start <processId>` | ready | `POST /api/sites/{siteId}/machines/{machineId}/processes/{processId}/start` |
| `owlette process stop <processId>` | ready | `POST /api/sites/{siteId}/machines/{machineId}/processes/{processId}/stop` |
| `owlette process kill <processId>` | ready | `POST /api/sites/{siteId}/machines/{machineId}/processes/{processId}/kill` |

## keys, users, and installer management

| command | status | public route or reason |
|---|---|---|
| `owlette key create` | ready | `POST /api/keys` |
| `owlette key list` | ready | `GET /api/keys` |
| `owlette key rotate <keyId>` | ready | `POST /api/keys/{keyId}/rotate` |
| `owlette key revoke <keyId>` | ready | `DELETE /api/keys/{keyId}` |
| `owlette user list` | ready | `GET /api/users` |
| `owlette user get <uid>` | ready | `GET /api/users/{uid}` |
| `owlette user promote <uid>` | ready | `POST /api/users/{uid}/promote` |
| `owlette user demote <uid>` | ready | `POST /api/users/{uid}/demote` |
| `owlette user assign-sites <uid>` | ready | `POST /api/users/{uid}/assign-sites` |
| `owlette user remove-sites <uid>` | ready | `POST /api/users/{uid}/remove-sites` |
| `owlette user delete <uid>` | ready | `DELETE /api/users/{uid}` |
| `owlette installer list` | ready | `GET /api/installer` |
| `owlette installer latest` | ready | `GET /api/installer/latest` |
| `owlette installer upload <file>` | ready | `POST /api/installer/upload`, signed `PUT`, then `PUT /api/installer/upload` |
| `owlette installer set-latest <version>` | ready | `POST /api/installer/{version}/set-latest` |
| `owlette installer delete <version>` | ready | `DELETE /api/installer/{version}` |

## webhook noun

`owlette webhook` is not registered in `cli/src/index.ts` yet. The public route family is live for developer preview, but CLI CRUD remains a Wave 3 follow-up so the command surface can settle with SDK examples.

| planned command | status | public route or reason |
|---|---|---|
| `owlette webhook create` | planned | `POST /api/webhooks?siteId=<siteId>` |
| `owlette webhook list` | planned | `GET /api/webhooks?siteId=<siteId>` |
| `owlette webhook get <webhookId>` | planned | `GET /api/webhooks/{webhookId}?siteId=<siteId>` |
| `owlette webhook update <webhookId>` | planned | `PATCH /api/webhooks/{webhookId}?siteId=<siteId>` |
| `owlette webhook delete <webhookId>` | planned | `DELETE /api/webhooks/{webhookId}?siteId=<siteId>` |
| `owlette webhook rotate-secret <webhookId>` | planned | `POST /api/webhooks/{webhookId}/rotate-secret?siteId=<siteId>` |
| `owlette webhook deliveries <webhookId>` | planned | `GET /api/webhooks/{webhookId}/deliveries?siteId=<siteId>` |
| `owlette webhook delivery get <webhookId> <deliveryId>` | planned | `GET /api/webhooks/{webhookId}/deliveries/{deliveryId}?siteId=<siteId>` |
| `owlette webhook retry <webhookId> <deliveryId>` | planned | `POST /api/webhooks/{webhookId}/deliveries/{deliveryId}/retry?siteId=<siteId>` |
| `owlette webhook probe` | planned | top-level `owlette trigger --via-api` already uses `POST /api/webhooks/probe?siteId=<siteId>` |

## invariants

- No registered CLI command calls `/api/admin/*`.
- `owlette chat` uses canonical `/api/cortex/conversations/*` routes; `/api/chat/*` is compatibility-only.
- `machine live-view` is the only registered stub.
- `owlette webhook ...` is documented as a planned noun, not a registered command.
