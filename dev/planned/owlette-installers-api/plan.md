# owlette-installers-api — plan
**Created**: 2026-04-24 | **Status**: Planned (not started)

## problem

agent installer binaries (`.exe` downloads) are managed via `/api/admin/installer/*` — admin-session-gated. three ops today:

1. list versions (metadata + download count)
2. upload new version (3-step flow: signed-url → PUT binary → finalize)
3. set version as "latest" (default download target)

the CLI's `owlette installer *` is entirely stubbed. superadmins currently upload via CI scripts that hit the admin endpoints with a session cookie — fragile. this plan promotes the surface to a public superadmin-scoped api.

## scope

four operations. minimal surface because installer management is a rare platform-admin task, not an operator one.

## proposed endpoints

| method | path | purpose | scope |
|---|---|---|---|
| GET | `/api/installers` | list all versions (name, version, size, checksum, downloads, createdAt) | `platform:superadmin` |
| POST | `/api/installers` | start 3-step upload: returns `{uploadId, uploadUrl}` for step 2 | `platform:superadmin` |
| PUT | `{uploadUrl}` | step 2: upload binary bytes to signed R2 URL (not an owlette endpoint) | — |
| PUT | `/api/installers/{uploadId}` | step 3: finalize upload (checksum check, writes metadata) | `platform:superadmin` |
| POST | `/api/installers/latest` | mark a version as latest download | `platform:superadmin` |
| GET | `/api/installers/latest` | get current latest (public, unauthenticated — installer download page uses this) | — |
| DELETE | `/api/installers/{version}` | remove a version (can't delete current latest; must promote another first) | `platform:superadmin` |

## auth model

- `platform:superadmin` scope (same tier introduced by `owlette-users-api`).
- the existing 3-step upload flow stays identical, just gated differently — the admin dashboard + the CLI hit the same endpoints via different auth mechanisms (session vs api-key).
- public GET for `/latest` is intentional: the installer download page needs to fetch the current version without auth.

## cli commands unblocked

```
owlette installer list
owlette installer upload <file> --version <v> --notes <txt> [--set-latest]
owlette installer set-latest <version>
owlette installer delete <version>
```

the CLI's `upload` command handles the 3-step choreography internally:
1. POST to request the signed url
2. PUT the binary to R2
3. PUT to finalize

## non-goals

- installer signing key rotation — separate security plan.
- per-architecture binaries (x64 / arm64) — v1 is windows x64 only, same as today.
- release-channel branching (stable / beta / canary) — follow-up if needed.
- unauthenticated download proxying — users hit the R2 signed url directly via the public `/latest` metadata.

## estimated size

~6 tasks across 1 wave: (1) promote admin endpoints to public + superadmin-scoped, add CLI integration tests. small plan because the existing implementation is reused wholesale.

## dependencies

- `owlette-users-api` for the `platform:superadmin` scope tier.
- existing 3-step upload infra (R2 signed PUT, checksum verify) — no changes needed.
