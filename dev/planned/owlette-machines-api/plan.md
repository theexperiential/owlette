# owlette-machines-api — plan
**Created**: 2026-04-24 | **Status**: Planned (not started)

## problem

the CLI exposes read-only machine operations today (`owlette machine list/get/deployments`) because `/api/sites/{siteId}/machines/*` is the only public surface. every mutation a dashboard operator does — reboot, shutdown, screenshot, live-view, pair a new agent, unassign, mute alerts, revoke the agent's refresh token — is either admin-session-gated behind `/api/admin/commands/send` or direct Firestore writes. the CLI stubs these verbs with exit 3. this plan makes them real.

## scope

two distinct mutation surfaces:

**a. runtime control** — commands the agent receives + executes on the box. today these queue under `/api/admin/commands/send` with a command-type discriminator. the plan wraps this in per-verb RESTful endpoints so the CLI hits a documented, scope-gated api instead of a bare command queue.

**b. membership + identity** — site assignment, rename, token lifecycle. today these are direct Firestore writes from the dashboard. the plan adds thin public endpoints.

## proposed endpoints

| method | path | purpose | scope |
|---|---|---|---|
| POST | `/api/sites/{id}/machines/{mid}/commands/reboot` | cold reboot w/ optional delay | `site:<id>:write` |
| POST | `/api/sites/{id}/machines/{mid}/commands/shutdown` | graceful shutdown | `site:<id>:write` |
| POST | `/api/sites/{id}/machines/{mid}/commands/screenshot` | capture screen → signed R2 url | `site:<id>:write` |
| POST | `/api/sites/{id}/machines/{mid}/commands/live-view` | start streaming session → webrtc url | `site:<id>:write` |
| POST | `/api/sites/{id}/machines/{mid}/mute-alerts` | suppress alerts (with duration) | `site:<id>:write` |
| POST | `/api/sites/{id}/machines/{mid}/unmute-alerts` | resume alerts | `site:<id>:write` |
| POST | `/api/sites/{id}/machines/{mid}/revoke-token` | invalidate agent refresh token | `site:<id>:admin` |
| PATCH | `/api/sites/{id}/machines/{mid}` | rename, update metadata | `site:<id>:write` |
| DELETE | `/api/sites/{id}/machines/{mid}` | unassign (soft) | `site:<id>:admin` |
| POST | `/api/sites/{id}/machines/pair` | mint device code for new agent | `site:<id>:admin` |
| GET | `/api/sites/{id}/machines/{mid}/commands/{cmdId}` | poll command status (pending/acked/completed/failed) | `site:<id>:read` |

## auth model

- all mutations require `site:<id>:write` scope on an api key, or `site:<id>:admin` for destructive/credential operations.
- command endpoints return `{commandId, status: "queued"}` immediately. polling `GET .../commands/{cmdId}` returns `{status, result?, error?}`. the CLI polls until terminal.
- pairing endpoint mints a device code (same mechanism as CLI device-code login) that the installer consumes.

## cli commands unblocked

```
owlette machine reboot <mid> --site <s> [--delay]
owlette machine shutdown <mid> --site <s>
owlette machine screenshot <mid> --site <s> [--out file.png]
owlette machine live-view <mid> --site <s>
owlette machine mute-alerts <mid> --site <s> [--duration 1h]
owlette machine revoke-token <mid> --site <s>
owlette machine rename <mid> --site <s> --name <n>
owlette machine remove <mid> --site <s>
owlette machine pair --site <s>            # prints device code + install instructions
```

## non-goals

- mutual-TLS pinning for agent auth (separate security hardening plan).
- per-process metrics exposure — see `owlette-processes-api`.
- display-layout management — see `owlette-displays-api`.

## estimated size

~15 tasks across 3 waves: (1) command-queue wrapper endpoints + polling model, (2) membership/token endpoints, (3) tests + docs.

## dependencies

- `owlette-cli` must be at wave 2 before this plan's cli commands promote from stub to real.
- agent protocol needs acknowledgment reporting for commands (may already be there — audit as wave 0 task here).
