---
hide:
  - navigation
---

# roost

a `roost` is a content-addressed bundle of files (a touchdesigner project, a media payload, a build artifact — anything) that the cli pushes once and the agent then pulls atomically onto target machines. every roost is site-scoped: every verb on this page requires `--site <siteId>`. tier: `[ready]` for all six verbs.

verbs:

- [`roost push`](#roost-push) — chunk + dedup + upload + publish a directory as a new version
- [`roost list`](#roost-list) — list roosts on a site (auto-paginates)
- [`roost get`](#roost-get) — print the detail record for one roost
- [`roost diff`](#roost-diff) — diff two versions on a roost
- [`roost versions`](#roost-versions) — list all versions published on a roost
- [`roost deploy`](#roost-deploy) — trigger a targeted fan-out (canary then fleet)

> **disambiguation**: `owlette roost deploy` is the **content-addressed** fan-out documented here. `owlette deploy` is the **classic agent-installer** deploy group (silent exe / msi pushes) — see [deploy.md](deploy.md). same word, different surfaces.

---

## roost push

walks `<dir>`, content-addresses every non-empty file into 4 MiB sha-256 chunks, asks the server which chunks it doesn't already have, uploads only the missing ones via signed urls, then publishes a new immutable version on `<roostId>` with optimistic concurrency on the head pointer.

```bash
owlette roost push <dir> --to <roostId> --site <siteId> [flags]
```

| flag | type | required | description |
|---|---|---|---|
| `--to <roostId>` | string | yes | target roost id |
| `--site <siteId>` | string | yes | site id that owns the roost |
| `--name <name>` | string | no | human-readable display name for the roost |
| `-m, --description <text>` | string | no | commit-message-style summary for this version (≤ 500 chars; client + server both enforce) |
| `--targets <machineIds>` | csv string | no | comma-separated machine ids; overrides `roost.targets` for this version |
| `--extract-path <path>` | string | no | extract root override |

### examples

```bash
# first push of a new project
owlette roost push ./my-project --to rst_my_project --site site-1
```

```bash
# subsequent push with a release note + machine override
owlette roost push ./dist --to rst_my_project --site site-1 \
  -m "fix: signage scaling on 4k panels" \
  --targets m_lobby_01,m_lobby_02
```

```bash
# json-mode push for ci pipelines
owlette --json roost push ./build --to rst_ci_build --site site-1 | jq '.versionId'
```

backing: multi-call — `POST /api/chunks/check` → `POST /api/chunks/upload-urls` → parallel `PUT` to signed r2 urls → `POST /api/roosts/{roostId}/versions` (with `expectedCurrentVersionId` for compare-and-swap; on `412` the cli refreshes head + retries up to 5 times).

---

## roost list

cursor-paged list of roosts on a site. walks the server's pagination until exhausted (or `--limit` is reached), so the default output is the full list.

```bash
owlette roost list --site <siteId> [flags]
```

| flag | type | required | description |
|---|---|---|---|
| `--site <siteId>` | string | yes | site id to list roosts for |
| `--page-size <n>` | integer | no | server-side page size (default `20`, max `100`) |
| `--limit <n>` | integer | no | stop after fetching this many roosts in total |
| `--include-deleted` | boolean | no | include tombstoned roosts in the result |

### examples

```bash
owlette roost list --site site-1
```

```bash
# include tombstoned + cap at 50 results
owlette roost list --site site-1 --include-deleted --limit 50
```

```bash
# script-friendly json output (legacy unwrapped envelope: { "roosts": [...] })
owlette --json roost list --site site-1 | jq '.roosts[].roostId'
```

backing: `GET /api/roosts?siteId=<s>&limit=<page-size>&cursor=<...>&includeDeleted=<bool>`.

---

## roost get

prints the full detail record for one roost, including the resolved current + previous version summaries (description, file count, byte size, createdBy / createdAt).

```bash
owlette roost get <roostId> --site <siteId>
```

| flag | type | required | description |
|---|---|---|---|
| `--site <siteId>` | string | yes | site id that owns the roost |

### examples

```bash
owlette roost get rst_my_project --site site-1
```

```bash
# pull the current version id straight out for use in another command
owlette --json roost get rst_my_project --site site-1 | jq -r '.currentVersionId'
```

backing: `GET /api/roosts/{roostId}?siteId=<s>`.

---

## roost diff

shows the file-level diff between two versions on a roost: added, removed, and modified entries plus a summary line with net byte delta. when `--version` is omitted the "to" version defaults to the roost's current version.

```bash
owlette roost diff <roostId> --site <siteId> --against <versionRef> [--version <versionRef>]
```

| flag | type | required | description |
|---|---|---|---|
| `--site <siteId>` | string | yes | site id that owns the roost |
| `--against <versionRef>` | string | yes | "from" version ref to diff against (id, `#N`, `vN`, `current`, `previous`, or `first`) |
| `--version <versionRef>` | string | no | "to" version ref; defaults to the roost's current version |

### examples

```bash
# what changed in the most recent push
owlette roost diff rst_my_project --site site-1 --against previous
```

```bash
# diff between two explicit version numbers
owlette roost diff rst_my_project --site site-1 --against '#3' --version '#5'
```

```bash
# json output for tooling
owlette --json roost diff rst_my_project --site site-1 --against previous | jq '.summary'
```

backing: `GET /api/roosts/{roostId}/versions/{toRef}/diff?siteId=<s>&against=<fromRef>`. when `--version` is omitted the cli first calls `GET /api/roosts/{roostId}` to resolve the current version id.

---

## roost versions

cursor-paged list of every version ever published on a roost, newest first. like `list`, the cli auto-paginates until exhausted (or `--limit`).

```bash
owlette roost versions <roostId> --site <siteId> [flags]
```

| flag | type | required | description |
|---|---|---|---|
| `--site <siteId>` | string | yes | site id that owns the roost |
| `--page-size <n>` | integer | no | server-side page size (default `20`, max `100`) |
| `--limit <n>` | integer | no | stop after fetching this many versions in total |

### examples

```bash
owlette roost versions rst_my_project --site site-1
```

```bash
# last 10 versions only
owlette roost versions rst_my_project --site site-1 --limit 10
```

```bash
# pull every version id as a flat list
owlette --json roost versions rst_my_project --site site-1 | jq -r '.versions[].versionId'
```

backing: `GET /api/roosts/{roostId}/versions?siteId=<s>&limit=<page-size>&cursor=<...>`.

---

## roost deploy

triggers a targeted fan-out for a roost: the server computes a canary / fleet split, queues `sync_pull` commands for the canary wave, and (with `--at`) defers a future rollout. this is the **real fan-out command** for content-addressed deploys — distinct from the `owlette deploy` group (classic installer pushes).

non-dry-run invocations auto-attach an `Idempotency-Key` header so a network blip or accidental retry returns the original rollout instead of starting a second one. dry-run does not mutate state and is not auto-keyed.

```bash
owlette roost deploy <roostId> --site <siteId> [flags]
```

| flag | type | required | description |
|---|---|---|---|
| `--site <siteId>` | string | yes | site id that owns the roost |
| `--version <versionId>` | string | no | version to deploy (default: the roost's `currentVersionId`) |
| `--machines <ids>` | csv string | no | comma-separated machine ids; overrides `roost.targets` |
| `--dry-run` | boolean | no | compute + print the rollout plan without writing |
| `--at <iso8601>` | string | no | schedule the rollout for a future timestamp (parsed with `Date.parse`) |
| `--idempotency-key <key>` | string | no | explicit `Idempotency-Key` header (auto-generated for non-dry-run if omitted) |

### examples

```bash
# preview the canary / fleet split before committing
owlette roost deploy rst_my_project --site site-1 --dry-run
```

```bash
# real fan-out using the roost's current version + targets
owlette roost deploy rst_my_project --site site-1
```

```bash
# pinned version, scheduled overnight, json output for ci
owlette --json roost deploy rst_my_project --site site-1 \
  --version vrs_abc123 \
  --at 2026-05-01T03:00:00Z | jq '.rolloutId'
```

backing: `POST /api/roosts/{roostId}/deploy` with body `{ siteId, versionId?, machines?, scheduleAt?, dryRun? }`. the server returns the resolved `versionUrl`, `extractRoot`, and the canary + fleet machine lists.

---

## exit codes

- `0` — success (push published, list returned, deploy queued, dry-run plan printed)
- `1` — network failure, non-2xx api response, or `412` precondition exhaustion on `roost push` (head changed 5 times mid-flight)
- `2` — usage error: `<dir>` is not a directory, missing required flag, `--description` over 500 chars, no token configured

---

## notes

- **scope**: every verb is site-scoped; `--site <siteId>` is required on all six
- **tier**: `[ready]` — every endpoint is fully public
- **rollback**: `owlette rollback <roostId> --site <siteId>` is a top-level helper that diffs the current version against the rollback target, prompts for confirmation, then flips the head pointer. see [rollback.md](rollback.md)
- **chunk size**: 4 MiB content-addressed via sha-256; dedupe is global per site
- **legacy `roost` binary**: the standalone `roost` exe forwards to `owlette` until 2026-10-01 — switch your scripts to `owlette` now
- **related**: [overview](../overview.md) (config precedence, json envelope, exit codes), [site](site.md) (resolve site ids), [quota](quota.md) (storage usage)
