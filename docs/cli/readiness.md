---
hide:
  - navigation
---

# cli readiness matrix

Status as of 2026-05-02. Source of truth for registered commands is `cli/src/index.ts` plus `cli/src/commands/**`.

Legend:

- **ready** - command hits a public API route today.
- **ready preview** - command is registered and calls a preview transport or preview API path.
- **local** - command only changes local CLI state.
- **stub** - command is registered and exits 3 with the canonical stub envelope.
- **planned** - public routes exist, but no `owlette` noun is registered yet.
- **reference page** - linked when a dedicated per-command page exists; `pending` means the command is registered but its dedicated page is not created yet.

## top-level commands

| command | status | reference page | public route or reason |
|---|---|---|---|
| `owlette auth login` | ready | [auth](reference/auth.md) | `POST /api/cli/device-code`, then `POST /api/cli/device-code/poll` |
| `owlette auth status` | ready | [auth](reference/auth.md) | alias of `owlette whoami`; `GET /api/whoami` |
| `owlette auth logout` | local | [auth](reference/auth.md) | clears the active profile token in `~/.config/owlette/config.toml`; no API call |
| `owlette whoami` | ready | [whoami](reference/whoami.md) | `GET /api/whoami` |
| `owlette version` | ready | [version](reference/version.md) | `GET /api/version` |
| `owlette rollback <roostId>` | ready | [rollback](reference/rollback.md) | `GET /api/roosts/{roostId}`, `GET /api/roosts/{roostId}/versions/{versionRef}/diff`, `POST /api/roosts/{roostId}/rollback` |
| `owlette listen` | ready preview | pending dedicated page (Task 4.9) | `GET /api/events/stream?siteId=<siteId>`; scoped SSE liveness transport only until production fanout ships |
| `owlette trigger <event>` | ready | pending dedicated page (Task 4.10) | direct mode posts to the caller's URL; `--via-api` uses `POST /api/webhooks/probe?siteId=<siteId>` |

## roost

| command | status | reference page | public route or reason |
|---|---|---|---|
| `owlette roost push <dir>` | ready | [roost](reference/roost.md) | `POST /api/chunks/check`, `POST /api/chunks/upload-urls`, signed `PUT`, `POST /api/roosts/{roostId}/versions` |
| `owlette roost list` | ready | [roost](reference/roost.md) | `GET /api/roosts?siteId=<siteId>` |
| `owlette roost get <roostId>` | ready | [roost](reference/roost.md) | `GET /api/roosts/{roostId}?siteId=<siteId>` |
| `owlette roost diff <roostId>` | ready | [roost](reference/roost.md) | `GET /api/roosts/{roostId}/versions/{versionRef}/diff?siteId=<siteId>&against=<versionRef>` |
| `owlette roost versions <roostId>` | ready | [roost](reference/roost.md) | `GET /api/roosts/{roostId}/versions?siteId=<siteId>` |
| `owlette roost deploy <roostId>` | ready | [roost](reference/roost.md) | `POST /api/roosts/{roostId}/deploy` |

## site-scoped operator nouns

| command | status | reference page | public route or reason |
|---|---|---|---|
| `owlette site list` | ready | [site](reference/site.md) | `GET /api/sites` |
| `owlette site get <siteId>` | ready | [site](reference/site.md) | `GET /api/sites/{siteId}` |
| `owlette quota show` | ready | [quota](reference/quota.md) | `GET /api/sites/{siteId}/quota` |
| `owlette quota history` | ready | [quota](reference/quota.md) | `GET /api/sites/{siteId}/quota/history?period=<period>` |
| `owlette audit-log list` | ready | [audit-log](reference/audit-log.md) | `GET /api/sites/{siteId}/audit-log` |
| `owlette audit-log get <recordHash>` | ready | [audit-log](reference/audit-log.md) | `GET /api/sites/{siteId}/audit-log/{recordHash}` |

## machine

| command | status | reference page | public route or reason |
|---|---|---|---|
| `owlette machine list` | ready | [machine](reference/machine.md) | `GET /api/sites/{siteId}/machines` |
| `owlette machine get <machineId>` | ready | [machine](reference/machine.md) | `GET /api/sites/{siteId}/machines/{machineId}` |
| `owlette machine deployments <machineId>` | ready | [machine](reference/machine.md) | `GET /api/sites/{siteId}/machines/{machineId}/deployments` |
| `owlette machine reboot <machineId>` | ready | [machine](reference/machine.md) | `POST /api/sites/{siteId}/machines/{machineId}/commands` with `type=reboot_machine` |
| `owlette machine shutdown <machineId>` | ready | [machine](reference/machine.md) | `POST /api/sites/{siteId}/machines/{machineId}/commands` with `type=shutdown_machine` |
| `owlette machine screenshot <machineId>` | ready | [machine](reference/machine.md) | `POST /api/sites/{siteId}/machines/{machineId}/commands` with `type=capture_screenshot`, then `GET /api/sites/{siteId}/machines/{machineId}/commands/{commandId}` |
| `owlette machine live-view <machineId>` | stub | [machine](reference/machine.md) | no public route yet; `public-api deferred: live-view-webrtc` |

## cortex chat

| command | status | reference page | public route or reason |
|---|---|---|---|
| `owlette chat new` | ready | [chat](reference/chat.md) | `POST /api/cortex/conversations` |
| `owlette chat list` | ready | [chat](reference/chat.md) | `GET /api/cortex/conversations?siteId=<siteId>` |
| `owlette chat send <conversationId> <message>` | ready | [chat](reference/chat.md) | `POST /api/cortex/conversations/{conversationId}` |
| `owlette chat delete <conversationId>` | ready | [chat](reference/chat.md) | `DELETE /api/cortex/conversations/{conversationId}` |
| `owlette chat rename <conversationId> <title>` | ready | [chat](reference/chat.md) | `PATCH /api/cortex/conversations/{conversationId}` |

## classic deployments

| command | status | reference page | public route or reason |
|---|---|---|---|
| `owlette deploy create` | ready | [deploy](reference/deploy.md) | `POST /api/sites/{siteId}/deployments` |
| `owlette deploy list` | ready | [deploy](reference/deploy.md) | `GET /api/sites/{siteId}/deployments` |
| `owlette deploy get <deploymentId>` | ready | [deploy](reference/deploy.md) | `GET /api/sites/{siteId}/deployments/{deploymentId}` |
| `owlette deploy retry <deploymentId>` | ready | [deploy](reference/deploy.md) | `POST /api/sites/{siteId}/deployments/{deploymentId}/retry` |
| `owlette deploy cancel <deploymentId>` | ready | [deploy](reference/deploy.md) | `POST /api/sites/{siteId}/deployments/{deploymentId}/cancel` |
| `owlette deploy uninstall <deploymentId>` | ready | [deploy](reference/deploy.md) | `POST /api/sites/{siteId}/deployments/{deploymentId}/uninstall` |
| `owlette deploy delete <deploymentId>` | ready | [deploy](reference/deploy.md) | `DELETE /api/sites/{siteId}/deployments/{deploymentId}` |

## process

| command | status | reference page | public route or reason |
|---|---|---|---|
| `owlette process list` | ready | [process](reference/process.md) | `GET /api/sites/{siteId}/machines/{machineId}/processes` |
| `owlette process get <processId>` | ready | [process](reference/process.md) | `GET /api/sites/{siteId}/machines/{machineId}/processes/{processId}` |
| `owlette process create` | ready | [process](reference/process.md) | `POST /api/sites/{siteId}/machines/{machineId}/processes` |
| `owlette process update <processId>` | ready | [process](reference/process.md) | `PATCH /api/sites/{siteId}/machines/{machineId}/processes/{processId}` |
| `owlette process delete <processId>` | ready | [process](reference/process.md) | `DELETE /api/sites/{siteId}/machines/{machineId}/processes/{processId}` |
| `owlette process schedule <processId>` | ready | [process](reference/process.md) | `POST /api/sites/{siteId}/machines/{machineId}/processes/{processId}/schedule` |
| `owlette process start <processId>` | ready | [process](reference/process.md) | `POST /api/sites/{siteId}/machines/{machineId}/processes/{processId}/start` |
| `owlette process stop <processId>` | ready | [process](reference/process.md) | `POST /api/sites/{siteId}/machines/{machineId}/processes/{processId}/stop` |
| `owlette process restart <processId>` | ready | [process](reference/process.md) | `POST /api/sites/{siteId}/machines/{machineId}/processes/{processId}/restart` |
| `owlette process kill <processId>` | ready | [process](reference/process.md) | `POST /api/sites/{siteId}/machines/{machineId}/processes/{processId}/kill` |

## keys, users, and installer management

| command | status | reference page | public route or reason |
|---|---|---|---|
| `owlette key create` | not available | [key](reference/key.md) | key management is dashboard/session-only; no CLI command is registered |
| `owlette key list` | not available | [key](reference/key.md) | key management is dashboard/session-only; no CLI command is registered |
| `owlette key rotate <keyId>` | not available | [key](reference/key.md) | key management is dashboard/session-only; no CLI command is registered |
| `owlette key revoke <keyId>` | not available | [key](reference/key.md) | key management is dashboard/session-only; no CLI command is registered |
| `owlette user list` | ready | [user](reference/user.md) | `GET /api/users` |
| `owlette user get <uid>` | ready | [user](reference/user.md) | `GET /api/users/{uid}` |
| `owlette user promote <uid>` | ready | [user](reference/user.md) | `POST /api/users/{uid}/promote` |
| `owlette user demote <uid>` | ready | [user](reference/user.md) | `POST /api/users/{uid}/demote` |
| `owlette user assign-sites <uid>` | ready | [user](reference/user.md) | `POST /api/users/{uid}/assign-sites` |
| `owlette user remove-sites <uid>` | ready | [user](reference/user.md) | `POST /api/users/{uid}/remove-sites` |
| `owlette user delete <uid>` | ready | [user](reference/user.md) | `DELETE /api/users/{uid}` |
| `owlette installer list` | ready | [installer](reference/installer.md) | `GET /api/installer` |
| `owlette installer latest` | ready | [installer](reference/installer.md) | `GET /api/installer/latest` |
| `owlette installer upload <file>` | ready | [installer](reference/installer.md) | `POST /api/installer/upload`, signed `PUT`, then `PUT /api/installer/upload` |
| `owlette installer set-latest <version>` | ready | [installer](reference/installer.md) | `POST /api/installer/{version}/set-latest` |
| `owlette installer delete <version>` | ready | [installer](reference/installer.md) | `DELETE /api/installer/{version}` |

## webhook noun

`owlette webhook` is not registered in `cli/src/index.ts` yet. The public route family is live for developer preview, but CLI CRUD remains a Wave 3 follow-up so the command surface can settle with SDK examples.

| planned command | status | reference page | public route or reason |
|---|---|---|---|
| `owlette webhook create` | planned | [webhook](reference/webhook.md) | `POST /api/webhooks?siteId=<siteId>` |
| `owlette webhook list` | planned | [webhook](reference/webhook.md) | `GET /api/webhooks?siteId=<siteId>` |
| `owlette webhook get <webhookId>` | planned | [webhook](reference/webhook.md) | `GET /api/webhooks/{webhookId}?siteId=<siteId>` |
| `owlette webhook update <webhookId>` | planned | [webhook](reference/webhook.md) | `PATCH /api/webhooks/{webhookId}?siteId=<siteId>` |
| `owlette webhook delete <webhookId>` | planned | [webhook](reference/webhook.md) | `DELETE /api/webhooks/{webhookId}?siteId=<siteId>` |
| `owlette webhook rotate-secret <webhookId>` | planned | [webhook](reference/webhook.md) | `POST /api/webhooks/{webhookId}/rotate-secret?siteId=<siteId>` |
| `owlette webhook deliveries <webhookId>` | planned | [webhook](reference/webhook.md) | `GET /api/webhooks/{webhookId}/deliveries?siteId=<siteId>` |
| `owlette webhook delivery get <webhookId> <deliveryId>` | planned | [webhook](reference/webhook.md) | `GET /api/webhooks/{webhookId}/deliveries/{deliveryId}?siteId=<siteId>` |
| `owlette webhook retry <webhookId> <deliveryId>` | planned | [webhook](reference/webhook.md) | `POST /api/webhooks/{webhookId}/deliveries/{deliveryId}/retry?siteId=<siteId>` |
| `owlette webhook probe` | planned | [webhook](reference/webhook.md); trigger page pending (Task 4.10) | top-level `owlette trigger --via-api` already uses `POST /api/webhooks/probe?siteId=<siteId>` |

## invariants

- No registered CLI command calls `/api/admin/*`.
- `owlette chat` uses canonical `/api/cortex/conversations/*` routes; `/api/chat/*` is compatibility-only.
- `machine live-view` is the only registered stub; `rg 'stubExit\(' cli/src/commands` should only match `cli/src/commands/machine.ts`.
- `owlette listen` and `owlette trigger` are registered commands, but their dedicated reference pages are still pending Tasks 4.9 and 4.10.
- `owlette webhook ...` is documented as a planned noun, not a registered command.
