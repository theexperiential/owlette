# owlette-processes-api — plan
**Created**: 2026-04-24 | **Status**: Planned (not started)

## problem

processes are a per-machine sub-collection (`sites/{siteId}/machines/{machineId}/processes/{processId}`) today — the most-used feature in the dashboard after machine listing. the CLI has `owlette process *` as stubs because every operation (list/create/update/delete/kill/start/stop/schedule) is dashboard-only. this plan adds the public api.

## scope

full CRUD over process definitions plus lifecycle commands (kill/start/stop are runtime, go through the agent command queue like `owlette-machines-api` runtime-control verbs).

## proposed endpoints

### CRUD
| method | path | purpose | scope |
|---|---|---|---|
| GET | `/api/sites/{id}/machines/{mid}/processes` | list processes on a machine | `site:<id>:read` |
| GET | `/api/sites/{id}/machines/{mid}/processes/{pid}` | process detail (incl. current state) | `site:<id>:read` |
| POST | `/api/sites/{id}/machines/{mid}/processes` | create (name, exe, cwd, priority, visibility, launch_mode, auto_launch, retry_policy) | `site:<id>:write` |
| PATCH | `/api/sites/{id}/machines/{mid}/processes/{pid}` | update any field | `site:<id>:write` |
| DELETE | `/api/sites/{id}/machines/{mid}/processes/{pid}` | remove (soft; preserves history) | `site:<id>:write` |

### lifecycle commands
| method | path | purpose | scope |
|---|---|---|---|
| POST | `/api/sites/{id}/machines/{mid}/processes/{pid}/start` | launch now | `site:<id>:write` |
| POST | `/api/sites/{id}/machines/{mid}/processes/{pid}/stop` | graceful stop | `site:<id>:write` |
| POST | `/api/sites/{id}/machines/{mid}/processes/{pid}/kill` | force kill | `site:<id>:write` |
| POST | `/api/sites/{id}/machines/{mid}/processes/{pid}/schedule` | set time-based launch blocks | `site:<id>:write` |

all lifecycle commands follow the async-command pattern from `owlette-machines-api` — return `{commandId}`, poll for terminal state.

## auth model

same scope model as machines: `site:<id>:read` for reads, `:write` for all mutations. no admin tier needed — processes belong to the machine, which belongs to the site.

## cli commands unblocked

```
owlette process list --machine <mid> --site <s>
owlette process get <pid> --machine <mid> --site <s>
owlette process create --machine <mid> --site <s> --name --exe --cwd \
                      [--priority --visibility --launch-mode off|always|scheduled \
                       --auto-launch --retry-attempts]
owlette process update <pid> --machine <mid> --site <s> [...any field]
owlette process delete <pid> --machine <mid> --site <s>
owlette process start <pid> --machine <mid> --site <s>
owlette process stop <pid> --machine <mid> --site <s>
owlette process kill <pid> --machine <mid> --site <s>
owlette process schedule <pid> --machine <mid> --site <s> \
                        --mode scheduled --add-block "mon 9-17"
```

## non-goals

- environment variable management per process (follow-up plan).
- process dependency chains (e.g. "start B after A succeeds") — future feature.
- real-time stdout streaming from running processes — separate `owlette process logs tail` plan.
- preset/template management (save process config as reusable template) — separate.

## estimated size

~12 tasks across 2 waves: (1) CRUD + firestore-rules updates, (2) lifecycle commands + tests.

## dependencies

- `owlette-machines-api` for the async-command pattern (reuses polling + status model).
- agent protocol for lifecycle acks (should already exist for start/stop/kill — audit first).
