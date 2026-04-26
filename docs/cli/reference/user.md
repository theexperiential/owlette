---
hide:
  - navigation
---

# user

`owlette user` manages platform users — promoting, demoting, granting site access, and soft-deleting accounts. **superadmin token required** on every verb. tier: **ready** — all seven verbs are wired to `/api/users/*` shipped in api-sprint wave 3B.

mutations carry an auto-generated `Idempotency-Key` so a retry returns the cached response rather than re-running the cascade. two server-side conflict codes get special handling because they're the common operator-error path: `last_superadmin` on `demote` and `orphan_sites` on `delete`.

---

## verbs

### list

filtered cursor-paged list of platform users.

```bash
owlette user list [--role <r>] [--site <siteId>] [--include-deleted] [--limit <n>] [--cursor <token>]
```

| flag | required | purpose |
|---|---|---|
| `--role <r>` | no | filter to `member`, `admin`, or `superadmin` |
| `--site <siteId>` | no | filter to users assigned to this site |
| `--include-deleted` | no | include soft-deleted users (default: false) |
| `--limit <n>` | no | page size, integer 1–100 (default 20) |
| `--cursor <token>` | no | opaque `page_token` from a prior response |

backing endpoint: `GET /api/users`. table renders `uid | email | role | sites | deleted | created`; `--json` emits `{ users, nextPageToken }`.

### get

print the detail record for one user.

```bash
owlette user get <uid>
```

backing endpoint: `GET /api/users/{uid}`. text mode prints uid, email, role, names, timestamps, and the assigned site list. `--json` emits the raw record.

### promote

raise a user to `admin` or `superadmin`.

```bash
owlette user promote <uid> --role admin|superadmin [--idempotency-key <key>]
```

| flag | required | purpose |
|---|---|---|
| `--role <r>` | yes | target role: `admin` or `superadmin` |
| `--idempotency-key <key>` | no | override the auto-generated key |

backing endpoint: `POST /api/users/{uid}/promote` body `{ role }`. response includes `previousRole`, `role`, and `changed` (false on no-op).

### demote

drop a user back to `member`.

```bash
owlette user demote <uid> [--idempotency-key <key>]
```

backing endpoint: `POST /api/users/{uid}/demote`. rejects the last active superadmin with `409 last_superadmin` — the cli surfaces the active count and the configured floor (default 1) and tells you to promote another user first.

### assign-sites

grant a user access to one or more sites (atomic `arrayUnion`).

```bash
owlette user assign-sites <uid> --sites <csv> [--idempotency-key <key>]
```

| flag | required | purpose |
|---|---|---|
| `--sites <csv>` | yes | comma-separated site ids |
| `--idempotency-key <key>` | no | override the auto-generated key |

backing endpoint: `POST /api/users/{uid}/assign-sites` body `{ siteIds: [...] }`. returns `400 unknown_site` with the offending ids if any site doesn't exist; the cli surfaces the bad ids verbatim.

### remove-sites

revoke a user's access to one or more sites and cancel their pending commands on those sites.

```bash
owlette user remove-sites <uid> --sites <csv> [--idempotency-key <key>]
```

backing endpoint: `POST /api/users/{uid}/remove-sites`. response includes `removedSiteIds` and `cancelledCommandCount` (printed inline so operators see the blast radius).

### delete

soft-delete a user. cascades to api keys and pending commands; if the user owns sites, ownership must transfer.

```bash
owlette user delete <uid> [--successor <uid>] [--yes] [--idempotency-key <key>]
```

| flag | required | purpose |
|---|---|---|
| `--successor <uid>` | conditional | required if the target user owns sites; must be admin or superadmin |
| `--yes` | no | skip the interactive `[y/N]` prompt |
| `--idempotency-key <key>` | no | override the auto-generated key |

backing endpoint: `DELETE /api/users/{uid}?successorUid=`. on `409 orphan_sites` the cli prints the owned site list and tells you to re-run with `--successor`. on `400 successor_invalid` it surfaces the `reason` field. when stdin is not a tty and `--yes` was not supplied, the cli refuses rather than delete silently.

---

## exit codes

- `0` — success (including `alreadyDeleted: true`)
- `1` — generic error (network, 5xx, conflict not specifically handled)
- `2` — usage error (bad `--role`, missing `--sites`, no token, non-tty without `--yes`)

---

## notes

- **scope**: platform-wide. session callers are double-checked against `users/{uid}.role === 'superadmin'` server-side; api keys must carry the matching scope.
- **tier**: ready (api-sprint wave 3B).
- **idempotency**: every mutation auto-generates a unique key. set `--idempotency-key` to dedupe at the script level.
- **floor enforcement**: `demote` cannot drop the platform below the minimum active-superadmin count (default 1). promote a successor first.
- **cascade on delete**: soft-delete revokes all the target's api keys, cancels their pending commands, and (with `--successor`) transfers owned sites in a single transaction.
- **see also**: [user-management api docs](../../api/users.md); the dashboard surface lives at owlette.app/admin/users.
