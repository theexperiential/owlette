# @owlette/roost-cli

Command-line interface for the [roost](https://owlette.app) public api.
Scaffold only — real commands are implemented across tasks 4.2–4.9 of the
[roost-public-api plan](../dev/active/roost-public-api/plan.md).

## install (local, pre-publish)

```bash
cd cli
npm install
npm run build
./bin/roost --help
```

The launcher (`./bin/roost`) prefers `dist/index.js` once you've built;
during development it falls back to ts-node so you can run without a
build step if you install ts-node locally.

## config

The cli reads `~/.config/roost/config.toml` on the first call that needs
a token. Environment variables always win over the file; profile-scoped
values win over top-level values.

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

| Variable              | Purpose                                                  |
|-----------------------|----------------------------------------------------------|
| `ROOST_TOKEN`         | Bearer token (overrides file)                           |
| `ROOST_API_URL`       | Base URL the cli points at                              |
| `ROOST_ENVIRONMENT`   | `live` or `test`                                        |
| `ROOST_PROFILE`       | Named profile from config.toml (default: `default`)     |

Active `--profile <name>` cli flag overrides `ROOST_PROFILE`.

## status

Run `roost auth status` to confirm the cli can see your token:

```bash
$ roost auth status
{
  "apiUrl": "https://owlette.app",
  "profile": "default",
  "environment": "live",
  "hasToken": true,
  "configPath": "/home/you/.config/roost/config.toml"
}
```

## subcommands (stubs)

All nouns + verbs are registered; most currently print "not yet implemented"
and exit 1. Filled in across the plan's wave 4 tasks:

| command                       | wave  |
|-------------------------------|-------|
| `auth login / status / logout`| 4.2   |
| `roost push`                  | 4.3   |
| `roost list / get / diff`     | 4.4   |
| `rollback`                    | 4.5   |
| `deploy`                      | 4.6   |
| `key create / list / rotate / revoke` | 4.7 |
| `listen`                      | 4.8   |
| `trigger`                     | 4.9   |
