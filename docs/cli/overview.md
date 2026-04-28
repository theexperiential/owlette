---
hide:
  - navigation
---

# owlette cli — overview

`owlette` is the command-line client for the [owlette.app](https://owlette.app) api. It runs on macOS, linux, and windows and lets you authenticate, push roosts, manage sites and machines, mint api keys, and inspect audit logs from your terminal or ci pipeline.

This page is the 15-minute onboarding: install → log in → push your first roost. For per-noun reference (every flag, every example), jump to [docs/cli/reference/](reference/). For route/stub/deferred status across the whole CLI, see the [readiness matrix](readiness.md).

---

## installation

### npm (coming soon)

```bash
npm install -g @owlette/cli
owlette --version
```

The cli is currently shipped as part of the [owlette monorepo](https://github.com/owlette-app/owlette) at `cli/` and is not yet published to npm. Install it from source for now.

### local dev (from the monorepo)

```bash
git clone https://github.com/owlette-app/owlette.git
cd owlette/cli
npm install
npm run build
npm link            # makes `owlette` available on your PATH
owlette --version
```

The `bin/owlette` launcher prefers the compiled `dist/` output but falls back to running the typescript source via `ts-node` so `node bin/owlette …` works without `npm run build`.

### legacy `roost` binary

Until 2026-10-01 the binary is also installed under the old name `roost` as a deprecation wrapper. It prints a one-line notice on stderr and forwards to `owlette`. After that date it will be removed; switch your scripts now.

---

## first 15 minutes

### 1. log in (device-code flow)

```bash
owlette auth login
```

Opens your browser to `owlette.app/cli` with a 3-word pairing phrase pre-filled. Approve the request in the dashboard and the cli stores the issued api key for the `default` profile using the OS keychain when available, or `~/.config/owlette/credentials.json` as a `0600` token-file fallback.

If you can't open a browser on the cli host (ssh, headless ci, etc):

```bash
owlette auth login --no-browser
# copy the pairing phrase + url from stderr, open them on a different machine
```

### 2. confirm who you are

```bash
owlette whoami
# user id     u_abc...
# email       you@example.com
# scopes      site:*=read|write|deploy
# environment live
# apiUrl      https://owlette.app
# profile     default
# configPath  /home/you/.config/owlette/config.toml
```

`owlette auth status` is an alias of `whoami` and prints byte-identical output.

### 3. push your first roost

A "roost" is a content-addressed bundle of files (a touchdesigner project, a media payload, an npm build artifact — anything). Pushing it dedupes chunks against the server and publishes a new immutable version.

```bash
owlette roost push ./my-project --to rst_my_project_id --site site-1
```

The cli walks the directory, computes content-addressed chunks, asks the server which chunks it doesn't have yet, uploads the missing ones via signed urls, then publishes a new version on the named roost. On subsequent pushes only changed chunks upload.

### 4. trigger a deploy

```bash
owlette roost deploy rst_my_project_id --site site-1 --dry-run
# inspect the canary / fleet split + extract path

owlette roost deploy rst_my_project_id --site site-1
# real deploy — auto idempotency-keyed so a network blip can be retried safely
```

That's the loop. `owlette roost diff <roostId> --against <versionRef>` shows what changed between any two versions; top-level `owlette rollback <roostId>` reverts to the previous version.

---

## config precedence

Every config field follows the same first-wins ladder:

```
1. cli flag           (--api-url, --profile)
2. env var            (OWLETTE_API_URL, OWLETTE_PROFILE, OWLETTE_TOKEN, OWLETTE_ENVIRONMENT)
3. credential store   (OS keychain, then ~/.config/owlette/credentials.json)
4. profile in config  (~/.config/owlette/config.toml — selected by --profile or OWLETTE_PROFILE)
5. built-in default   (api_url=https://owlette.app)
```

Legacy `ROOST_*` env vars + `~/.config/roost/config.toml` are read as fallback through 2026-10-01 with a one-time deprecation warning per process.

### config file schema

```toml
# top-level defaults — used when the active profile doesn't override
api_url = "https://owlette.app"
environment = "live"

[profiles.default]
api_url = "https://owlette.app"

[profiles.dev]
api_url = "https://dev.owlette.app"
environment = "test"
```

Legacy `token = "owk_*"` fields are still read for migration, but `owlette auth login` now writes secrets to the credential store and uses `config.toml` for non-secret profile metadata. Switch profiles with `--profile dev` or `OWLETTE_PROFILE=dev`.

---

## global flags

Flags inherited by every command:

| flag | env var | default | purpose |
|---|---|---|---|
| `--profile <name>` | `OWLETTE_PROFILE` | `default` | named profile from config.toml |
| `--json` | — | false | emit structured json instead of ascii tables on stdout |
| `--api-url <url>` | `OWLETTE_API_URL` | `https://owlette.app` | target api host |
| `-h, --help` | — | — | show help for the current command |
| `-V, --version` | — | — | print cli version |

`--json` mode is fully scriptable — every command emits a stable `{ ok, data }` (or `{ ok: false, error }`) envelope so you can pipe to `jq` and trust the shape.

---

## noun matrix

Every command lives under one of these top-level groups. **`[ready]`** verbs hit a public api today. **`[stub]`** verbs reserve the namespace and exit 3 with a pointer to a future plan.

### top-level verbs

| command | tier | description |
|---|---|---|
| [`owlette auth login`](reference/auth.md) | ready | device-code login; stores token in active profile |
| [`owlette auth status`](reference/auth.md) | ready | alias of `owlette whoami` |
| [`owlette auth logout`](reference/auth.md) | ready | clear token from active profile |
| [`owlette whoami`](reference/whoami.md) | ready | print server-resolved identity + scopes |
| [`owlette version`](reference/version.md) | ready | print cli version, server version, supported `Roost-Version` values |

### operator nouns (site-scoped)

| noun | tier | verbs | what it does |
|---|---|---|---|
| [`roost`](reference/roost.md) | ready | `push` `list` `get` `diff` `versions` `deploy` | content-addressed project distribution |
| [`machine`](reference/machine.md) | ready | `list` `get` `deployments` `reboot` `shutdown` `screenshot` | manage windows machines |
| [`machine live-view`](reference/machine.md) | stub | — | streaming desktop feed; deferred as `live-view-webrtc` outside the MVP |
| [`audit-log`](reference/audit-log.md) | ready | `list` `get` | site audit log + hash-chain verification |
| [`quota`](reference/quota.md) | ready | `show` `history` | site storage + bandwidth usage |
| [`chat`](reference/chat.md) | ready | `new` `list` `send` `delete` `rename` | cortex ai chat |
| [`webhook`](reference/webhook.md) | planned | `create` `list` `get` `update` `delete` `rotate-secret` `deliveries` `delivery get` `retry` `probe` | public routes exist; CLI noun group remains deferred |
| [`deploy`](reference/deploy.md) | ready | `create` `list` `get` `retry` `cancel` `uninstall` `delete` | classic agent-installer deploys (NOT `roost deploy`) |
| [`process`](reference/process.md) | ready | `list` `get` `create` `update` `delete` `kill` `start` `stop` `schedule` | process lifecycle on machines |

### user nouns

| noun | tier | verbs | what it does |
|---|---|---|---|
| [`site`](reference/site.md) | ready | `list` `get` | sites you have access to |
| [`key`](reference/key.md) | ready | `create` `list` `rotate` `revoke` | your api keys |

### superadmin nouns

| noun | tier | verbs | what it does |
|---|---|---|---|
| [`user`](reference/user.md) | ready | `list` `get` `promote` `demote` `assign-sites` `remove-sites` `delete` | platform user management |
| [`installer`](reference/installer.md) | ready | `list` `latest` `upload` `set-latest` `delete` | agent installer binary management |

### legacy top-level verbs (kept for muscle memory)

| command | description |
|---|---|
| `owlette rollback <roostId>` | top-level rollback helper for roost versions |
| `owlette listen` | open the scoped SSE liveness stream and forward received events to a local url |
| `owlette trigger <event>` | fire a synthetic webhook for local testing |

> **disambiguation**: `owlette deploy …` is the **classic installer** deploy group (silent exe pushes). `owlette roost deploy <roostId>` is the **content-addressed** deploy that ships per-version diffs to a fleet. Same word, different surfaces — the help text disambiguates.

---

## exit codes

scripts can branch on these — they're stable and meaningful:

| code | meaning | example trigger |
|---|---|---|
| `0` | success | `owlette roost push ./dist --to rst_abc` |
| `1` | generic error — network failure, api 5xx, unexpected state | server unreachable; invalid response shape; transient 429 |
| `2` | usage error — missing required flag, bad arg, unknown command | `owlette roost push` with no path |
| `3` | **stub — noun exists but has no public api yet** | `owlette machine live-view m-1 --site site-1` |

Exit code `3` is intentionally distinct from `1` so ci can tell "the api will never accept this until the backend ships" apart from "transient failure, retry."

---

## json envelope schema

every command with `--json` emits exactly one of these shapes on stdout:

**success**
```json
{ "ok": true, "data": { /* command-specific payload */ } }
```

Some commands (legacy: `roost list`, `whoami`) emit the payload directly without the `ok`/`data` wrapper for backward compatibility — see the per-noun reference for exact shapes. New commands always wrap.

**failure (any non-zero exit)**
```json
{ "ok": false, "error": { "code": "<stable_string>", "message": "human-readable", "detail": { /* optional */ } } }
```

stable `code` values match the api's problem+json codes (`scope_insufficient`, `token_expired`, `idempotency_key_mismatch`, `manifest_stale`, `rate_limited`, `unsupported_version`).

**stub (exit 3 only)**
```json
{ "ok": false, "stub": true, "noun": "machine", "reason": "live-view streaming is being reframed as a webrtc-native feature; resume when prioritized", "dashboard_url": "https://owlette.app/dashboard", "future_plan": "public-api deferred: live-view-webrtc" }
```

---

## next steps

- [per-noun reference](reference/) — every verb, every flag, copy-paste examples
- [migration from roost cli](migration-from-roost-cli.md) — what changed, deprecation timeline
- [api docs](../api/) — the underlying http surface every cli command wraps
