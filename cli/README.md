# @owlette/cli

Command-line interface for [owlette](https://owlette.app). Talks to the
public API — content-addressed roost distribution, scoped api keys,
webhook subscriptions, and (over time) the rest of the owlette product
surface.

> **Renamed from `@owlette/roost-cli` (binary `roost`)**. See
> [MIGRATION.md](MIGRATION.md) for the upgrade path. The legacy `roost`
> binary still works as a deprecation wrapper through 2026-10-01.

## install (local, pre-publish)

```bash
cd cli
npm install
npm run build
./bin/owlette --help
```

The launcher (`./bin/owlette`) prefers `dist/index.js` once you've built;
during development it falls back to ts-node so you can run without a
build step if you install ts-node locally.

## hello world

```bash
owlette auth login                 # device-code flow → stores key
owlette auth status                # whoami
owlette roost list --site <siteId> # list roosts on a site
owlette roost push ./my-build --to my-roost --site <siteId>
```

## config

The cli reads `~/.config/owlette/config.toml` on the first call that
needs a token. If only `~/.config/roost/config.toml` exists (legacy
location), it's copied to the new path on first read with a one-time
migration notice. Environment variables always win over the file;
profile-scoped values win over top-level values.

```toml
# top-level defaults
api_url = "https://owlette.app"
environment = "live"

[profiles.default]
token = "owk_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
api_url = "https://owlette.app"

[profiles.dev]
token = "owk_test_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
api_url = "https://dev.owlette.app"
environment = "test"
```

| Variable               | Purpose                                            |
|------------------------|----------------------------------------------------|
| `OWLETTE_TOKEN`        | Bearer token (overrides file)                      |
| `OWLETTE_API_URL`      | Base URL the cli points at                         |
| `OWLETTE_ENVIRONMENT`  | `live` or `test`                                   |
| `OWLETTE_PROFILE`      | Named profile from config.toml (default: `default`)|

Legacy `ROOST_*` env vars are read as a fallback through 2026-10-01 and
emit a one-time deprecation warning per process.

The `--profile <name>` cli flag overrides `OWLETTE_PROFILE`.

> **TOML comments are NOT preserved** when the cli writes the file
> (`auth login` / `auth logout`). Hand-edits to the file are read back
> on the next mutation but comments and richer structures (inline
> tables, arrays of tables) get dropped on rewrite.

## subcommands

| command                                    | description                                     |
|--------------------------------------------|-------------------------------------------------|
| `auth login`                               | device-code flow; stores token                  |
| `auth status`                              | print server-resolved identity + scopes         |
| `auth logout`                              | clear token from active profile                 |
| `roost push <dir> --to <id> --site <id>`   | chunk + upload + publish a folder               |
| `roost list --site <id>`                   | cursor-paged list                               |
| `roost get <id> --site <id>`               | detail incl. current + previous version ids    |
| `roost diff <id> --against <ref>`          | file-level diff between two versions            |
| `roost versions <id>`                      | list versions for a roost                       |
| `rollback <id>`                            | revert; defaults to one step back               |
| `deploy <id>`                              | trigger fan-out with optional scheduling        |
| `key create / list / rotate / revoke`      | manage api keys                                 |
| `listen --forward-to <url>`                | local-dev webhook tunnel                        |
| `trigger <event>`                          | fire a synthetic webhook for testing            |

The full noun-verb surface (including planned commands) lives in
[`dev/active/owlette-cli/reference/command-surface.md`](../dev/active/owlette-cli/reference/command-surface.md).

## tests

```bash
npm test          # offline unit + http-shape suites
OWLETTE_CLI_SMOKE=1 \
  OWLETTE_CLI_SMOKE_API_URL=https://dev.owlette.app \
  OWLETTE_CLI_SMOKE_TOKEN=owk_test_… \
  OWLETTE_CLI_SMOKE_SITE=site_… \
  npm test         # also runs read-only smoke tests against dev api
```
