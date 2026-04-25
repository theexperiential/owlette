# owlette-installer-deploys-api — plan
**Created**: 2026-04-24 | **Status**: Planned (not started)

## problem

owlette has **two** parallel deployment systems:

1. **roost deploys** — content-addressed, atomic, chunked. public api. implemented.
2. **classic installer deploys** — "here's a silent exe + MSI, push it to these machines and run it." admin-session-gated at `/api/admin/deployments/*`. dashboard-only, cli-stubbed.

both exist because they solve different problems: roost pushes data/projects; installer deploys push software (chrome, touchdesigner runtimes, custom exes). this plan promotes the installer-deploy surface to public + site-scoped.

## scope

full CRUD over the deployment lifecycle: create, list, detail, retry failed targets, cancel targets, uninstall, delete history record. all site-scoped.

## proposed endpoints

| method | path | purpose | scope |
|---|---|---|---|
| GET | `/api/sites/{id}/installer-deploys` | list cursor-paged | `site:<id>:read` |
| POST | `/api/sites/{id}/installer-deploys` | create (name, installerUrl, silentFlags, verifyPath, machineIds) | `site:<id>:deploy` |
| GET | `/api/sites/{id}/installer-deploys/{did}` | detail w/ per-target status | `site:<id>:read` |
| POST | `/api/sites/{id}/installer-deploys/{did}/retry` | retry failed targets (body: `{machineIds?}` — default all failed) | `site:<id>:deploy` |
| POST | `/api/sites/{id}/installer-deploys/{did}/cancel` | cancel per-target (body: `{machineIds}`) | `site:<id>:deploy` |
| POST | `/api/sites/{id}/installer-deploys/{did}/uninstall` | trigger uninstall (body: `{machineIds?}` — default all completed) | `site:<id>:deploy` |
| DELETE | `/api/sites/{id}/installer-deploys/{did}` | remove history record (DOES NOT uninstall — separate op) | `site:<id>:deploy` |

## auth model

- new scope permission: `deploy` on the `site` resource. `site:<id>:deploy` is distinct from `site:<id>:write` so operators can have publish-manifests rights without installer-deploy rights (they're destructive in a different way).
- existing admin endpoints under `/api/admin/deployments/*` stay for dashboard use; they 301-redirect to the new public site-scoped paths for ≥ 90 days for back-compat.

## cli commands unblocked

```
owlette deploy create --site <s> --name <n> --url <installerUrl> \
                     --silent-flags <flags> [--verify-path <p>] \
                     --machines <csv>
owlette deploy list --site <s>
owlette deploy get <did> --site <s>
owlette deploy retry <did> --site <s> [--machines <csv>]        # defaults: all failed
owlette deploy cancel <did> --site <s> --machines <csv>
owlette deploy uninstall <did> --site <s> [--machines <csv>]    # defaults: all completed
owlette deploy delete <did> --site <s>                          # removes record, NOT uninstall
```

## disambiguation

help text + docs must make clear: `owlette deploy` ≠ `owlette roost deploy`.
- **`owlette deploy`**: classic installer pushes (silent exes, MSIs).
- **`owlette roost deploy`**: content-addressed roost rollouts.

both remain first-class in v1. merging them is not in scope.

## non-goals

- installer signing / verification (exists today; no api changes needed).
- dependency chains between installer deploys — serial ordering is up to the caller.
- rollback of installer deploys (different semantic than roost rollback — would need uninstall + re-install of the previous version, which is what `owlette deploy uninstall <old-did>` + `owlette deploy create ...` already lets you do manually).

## estimated size

~9 tasks across 2 waves: (1) public endpoints + scope addition + admin-route redirects, (2) retry/cancel/uninstall lifecycle + tests.

## dependencies

- existing `/api/admin/deployments/*` implementation (gets promoted + re-scoped, not rewritten).
- `owlette-machines-api` async-command pattern — reused for per-target lifecycle.
