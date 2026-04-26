---
hide:
  - navigation
---

# installer

> 🔒 **superadmin only.** every verb on this noun requires a superadmin user session **or** an api key minted with `installer=*:read` (for `list`) / `installer=*:write` (for `upload`, `set-latest`, `delete`). these scopes can only be issued by a superadmin at minting time. forbidden calls return `403 scope_insufficient` with a hint pointing at the missing scope.

agent installer binary management — the platform-level catalogue of `Owlette-Installer-vX.Y.Z.exe` binaries that every new agent pulls during pairing. this is **not** the per-site classic-deploy surface (see [`deploy`](deploy.md)) and **not** roost (see [`roost`](roost.md)) — installer manages the installer exe artefacts themselves: list versions, upload a new one, mark a version as the latest pointer, soft-delete an obsolete version.

scope: platform-wide. tier A — every verb hits a real public api (api-sprint W1B → W5.1 batch B). soft-delete is gated by a `min-active-versions ≥ 2` floor enforced inside a firestore transaction; deleting through that floor returns `409 min_versions_violated`.

---

## list

list uploaded installer versions, newest first. cursor-paged.

**synopsis** — `owlette installer list [--include-deleted] [--limit <n>] [--cursor <token>] [--json]`

| flag | required | purpose |
|---|---|---|
| `--include-deleted` | no | include soft-deleted versions in the listing (hidden by default) |
| `--limit <n>` | no | page size, 1..100 (default 20) |
| `--cursor <token>` | no | opaque `page_token` returned by a previous list call |

```bash
owlette installer list
owlette installer list --include-deleted --limit 50
owlette installer list --json | jq '.versions[] | select(.deletedAt == null) | .version'
```

**backing endpoint**: `GET /api/installer`

---

## upload

upload a new installer binary. this is a **3-step flow** the cli orchestrates end-to-end:

1. `POST /api/installer/upload` — request a signed url, server reserves the version + storage path
2. `PUT <signedUrl>` — push the bytes directly to storage (skips the api server)
3. `PUT /api/installer/upload` — finalize: server verifies the upload, writes `installer_metadata`, optionally flips the `latest` pointer

the **same** `Idempotency-Key` is sent on both server-side calls (steps 1 + 3) so retrying the entire sequence replays the cached responses on both ends. local sha256 is computed from the file and sent on finalize so the server can reject a corrupted upload.

**synopsis** — `owlette installer upload <file> --version <semver> [--release-notes <text>] [--set-latest] [--idempotency-key <key>]`

| flag | required | purpose |
|---|---|---|
| `<file>` | yes | path to the installer exe to upload |
| `--version <semver>` | yes | semver of the installer being uploaded (`X.Y.Z`) |
| `--release-notes <text>` | no | release notes shown on the dashboard |
| `--set-latest` | no | mark this version as the new `latest` after upload |
| `--idempotency-key <key>` | no | pin the `Idempotency-Key` used on both server calls (auto-generated if omitted) |

```bash
owlette installer upload ./Owlette-Installer-v2.11.0.exe \
  --version 2.11.0 \
  --release-notes "fixes display-manager flicker, adds device-code silent-install" \
  --set-latest
```

**backing endpoints**:
- `POST /api/installer/upload` (request signed url)
- `PUT <signedUrl>` (binary upload — direct to storage, not the api)
- `PUT /api/installer/upload` (finalize)

---

## set-latest

mark a previously-uploaded version as the new `latest` pointer. all new agents and the dashboard's "download installer" button will pull this version. atomic transactional pointer flip — old `latest` is unset in the same write. interactive by default; pass `--yes` to skip the confirmation.

**synopsis** — `owlette installer set-latest <version> [--yes] [--idempotency-key <key>]`

| flag | required | purpose |
|---|---|---|
| `<version>` | yes | the semver to promote (must already be uploaded + not soft-deleted) |
| `--yes` | no | skip the confirmation prompt (required for non-tty / scripted use) |
| `--idempotency-key <key>` | no | pin an `Idempotency-Key` (auto-generated if omitted) |

```bash
owlette installer set-latest 2.11.0
owlette installer set-latest 2.11.0 --yes --json
```

**backing endpoint**: `POST /api/installer/{version}/set-latest`

---

## delete

soft-delete an installer version. existing agents that already pulled it keep it; new agents will not see it (it's filtered from list + the dashboard download button). the platform enforces a **floor of 2 active versions** inside a firestore transaction — deleting through the floor returns `409 min_versions_violated` with the current `minActiveVersions` + `currentActiveCount` in the response and a hint to upload a replacement first. interactive by default; pass `--yes` to skip the confirmation.

**synopsis** — `owlette installer delete <version> [--yes] [--idempotency-key <key>]`

| flag | required | purpose |
|---|---|---|
| `<version>` | yes | the semver to soft-delete |
| `--yes` | no | skip the confirmation prompt (required for non-tty / scripted use) |
| `--idempotency-key <key>` | no | pin an `Idempotency-Key` (auto-generated if omitted) |

```bash
owlette installer delete 2.9.0
owlette installer delete 2.9.0 --yes
```

**backing endpoint**: `DELETE /api/installer/{version}`

---

## exit codes

- `0` — success
- `1` — generic error (network, api 5xx, 403 `scope_insufficient`, 409 `min_versions_violated`, signed-url PUT failure, finalize verification failure, unexpected response shape)
- `2` — usage error (missing `--version` on upload, unreadable file, refusal to run without `--yes` on a non-tty, no token configured)

stable problem+json codes surfaced with hints: `scope_insufficient`, `min_versions_violated`, plus the standard `idempotency_key_mismatch` from the shared idempotency layer.

---

## notes

- **scope**: platform-wide; superadmin only. `installer=*:read` for `list`, `installer=*:write` for `upload` / `set-latest` / `delete`. these scopes can only be minted by a superadmin.
- **tier**: A — every verb hits a real public api (api-sprint W1B).
- **idempotency**: every mutation auto-generates an `Idempotency-Key`. for `upload` the same key is reused on both server calls (steps 1 + 3) so retrying the whole 3-step flow replays cached responses cleanly.
- **floor of 2**: the platform refuses to soft-delete the second-to-last active version. this guarantees there's always a fallback to roll forward to if a freshly-uploaded version is broken — upload a replacement first, then delete the old one.
- **related**: [`deploy`](deploy.md) for fanning a specific installer binary out at a fleet (the classic per-site deploy noun consumes the artefacts this command manages).
- see [overview](../overview.md) for global flags (`--profile`, `--json`, `--api-url`) and config precedence.
