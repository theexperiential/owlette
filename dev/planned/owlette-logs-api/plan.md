# owlette-logs-api — plan
**Created**: 2026-04-24 | **Status**: Planned (not started)

## problem

the dashboard's logs page shows operational events — `agent_started`, `process_crashed`, `deployment_completed`, `reboot_triggered`, `command_executed` — scoped per machine per site. this is **distinct from audit-log** (hash-chained security events). logs today are Firestore-direct from the dashboard; no public api exists. `owlette log *` is a stub.

## scope

read-heavy CRUD for operational events plus a live-tail SSE stream. no write endpoint — agents write events via their authenticated agent channel, not via public api.

## proposed endpoints

| method | path | purpose | scope |
|---|---|---|---|
| GET | `/api/sites/{id}/logs` | cursor-paged list w/ filters (machine, kind, level, since, until) | `site:<id>:read` |
| GET | `/api/sites/{id}/logs/{logId}` | log detail (full metadata, stack traces, crash screenshots) | `site:<id>:read` |
| GET | `/api/sites/{id}/logs/stream` | SSE live-tail (same filters as list) | `site:<id>:read` |
| DELETE | `/api/sites/{id}/logs` | bulk clear w/ filter (requires filter — no mass-delete w/o scope) | `site:<id>:admin` |

## filtering grammar

`kind`: comma-separated event types. examples: `process_crashed,agent_disconnected`
`level`: `error|warning|info|debug` (cli supports `--level error` → ≥ error)
`machine`: scope to one machine id
`since`/`until`: iso-8601 or relative (`24h`, `7d`, `30d`)

all filters indexable in firestore — composite index required on `(siteId, kind, timestamp desc)` and `(siteId, machineId, timestamp desc)`.

## auth model

- reads scoped to `site:<id>:read` — any site member can see logs.
- delete-clear scoped to `site:<id>:admin` — destructive, admin-gated.
- SSE stream uses the same session pattern as `/api/events/stream`: bearer token, max 30min connection, heartbeat every 15s.

## cli commands unblocked

```
owlette log list --site <s> [--machine --kind --level --since --until --limit --cursor]
owlette log get <logId> --site <s>
owlette log tail --site <s> [--machine --kind --level]    # live-follow via SSE
owlette log clear --site <s> --before <duration> [--kind <csv>]
```

## non-goals

- log aggregation / metrics rollup (that's the quota / telemetry surface).
- export to external SIEM (s3, datadog, etc) — follow-up integration plan.
- log retention policy configuration — hardcoded 30d in v1, config comes later.
- agent-side log forwarding protocol changes — agents already emit the right shape.

## estimated size

~8 tasks across 2 waves: (1) list + detail + filtering + firestore indexes, (2) SSE tail + bulk-clear + tests.

## dependencies

- composite firestore indexes must be deployed before list endpoint goes live.
- `/api/events/stream` SSE infrastructure (already shipped in roost-public-api wave 3.9) reused.
