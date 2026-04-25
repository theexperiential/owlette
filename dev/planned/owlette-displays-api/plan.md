# owlette-displays-api — plan
**Created**: 2026-04-24 | **Status**: Planned (not started)

## problem

owlette machines often drive multi-monitor kiosk/signage setups. the dashboard has a display-config panel showing per-monitor resolution, orientation, scale, position, and port, plus a "store" / "recall" feature for saving + applying layouts. no public api exposes any of it. `owlette machine displays` + site-wide display-layout management are stubs.

## scope

two related concerns:

1. **read current display config** from a machine (what monitors are connected, how).
2. **manage saved layouts** at the site level (store one machine's config by name, recall it to any machine with matching hardware).

## proposed endpoints

### machine-side (current state)
| method | path | purpose | scope |
|---|---|---|---|
| GET | `/api/sites/{id}/machines/{mid}/displays` | list current monitor config (resolution, orientation, position, port) | `site:<id>:read` |
| POST | `/api/sites/{id}/machines/{mid}/displays/capture` | async capture current layout snapshot → returns `{commandId}` | `site:<id>:write` |

### site-side (saved layouts)
| method | path | purpose | scope |
|---|---|---|---|
| GET | `/api/sites/{id}/display-layouts` | list saved layouts | `site:<id>:read` |
| POST | `/api/sites/{id}/display-layouts` | save layout from a machine (body: `{name, fromMachineId}`) | `site:<id>:write` |
| GET | `/api/sites/{id}/display-layouts/{layoutId}` | layout detail | `site:<id>:read` |
| PATCH | `/api/sites/{id}/display-layouts/{layoutId}` | rename, mark as default | `site:<id>:write` |
| DELETE | `/api/sites/{id}/display-layouts/{layoutId}` | remove saved layout | `site:<id>:write` |
| POST | `/api/sites/{id}/display-layouts/{layoutId}/apply` | async apply to `{machineIds}` | `site:<id>:write` |

## auth model

same tier pattern as machines: reads scoped to `site:<id>:read`, writes + apply scoped to `site:<id>:write`. apply is a command (async) — returns `{commandId}`, poll for terminal state.

## cli commands unblocked

```
owlette machine displays list <mid> --site <s>
owlette machine displays capture <mid> --site <s>

owlette site display-layout list <s>
owlette site display-layout store <name> --from <mid> --site <s>
owlette site display-layout get <layoutId> --site <s>
owlette site display-layout rename <layoutId> --site <s> --name <n>
owlette site display-layout delete <layoutId> --site <s>
owlette site display-layout apply <layoutId> --to <mid-csv> --site <s>
```

## non-goals

- per-machine display policy enforcement (drift detection / auto-reapply on reboot) — follow-up.
- cross-site layout sharing — single-site only in v1.
- display identification via serial / edid — uses port + resolution tuples in v1, good enough for the common kiosk case.

## estimated size

~7 tasks across 2 waves: (1) machine-side read + capture, (2) site-side layout CRUD + apply.

## dependencies

- `owlette-machines-api` command-polling pattern (reused for capture + apply).
- agent protocol must expose display enumeration + layout apply — audit as wave 0 task; may already exist given the dashboard has this.
