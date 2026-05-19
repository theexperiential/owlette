---
hide:
  - navigation
---

# whoami

`whoami` prints the server-resolved identity for the active profile — user id, email, the api key's scopes + environment, and the local config context the cli used to make the request. acts on the cli's own state (no site / machine targeting). tier: `[ready]`.

[`auth status`](auth.md#auth-status) is an alias of `whoami` and prints byte-identical output via the same shared `runWhoami` runner; pick whichever name reads better in your script.

---

## whoami

```bash
owlette whoami [--json]
```

no verb-specific flags. inherits `--profile` and `--json` from the global set.

### examples

```bash
# human-readable summary — one key/value pair per line
owlette whoami
# user id     u_abc...
# email       you@example.com
# scopes      site:*=read|write|deploy
# environment live
# apiUrl      https://owlette.app
# profile     default
# configPath  /home/you/.config/owlette/config.toml
# credential  token-file /home/you/.config/owlette/credentials.json
```

```bash
# json envelope — pipe to jq for scripting
owlette whoami --json | jq '.whoami.userId'
```

```bash
# inspect a specific profile without exporting OWLETTE_PROFILE
owlette --profile dev whoami
```

backing: `GET /api/whoami` with `Authorization: Bearer <token>`.

---

## output

### human mode

eight aligned key/value lines on stdout:

| field | source | meaning |
|---|---|---|
| `user id` | api response | firebase uid the api resolved the token to |
| `email` | api response | account email, or `(unknown)` if the key is not tied to a user record |
| `scopes` | api response | `<resource>:<id>=<perms>` summary, or `(legacy key — full access, no scope list)` for pre-scope keys, or `(session auth — no api key)` if the request used a session cookie |
| `environment` | local config first, then api response | `live` \| `test` \| `(unset)` |
| `apiUrl` | local config | resolved api host (flag → env → profile → built-in) |
| `profile` | local config | active profile name |
| `configPath` | local config | absolute path to the toml the cli read, or `(no config file)` |
| `credential` | local credential store | `env`, `keychain`, `token-file <path>`, `config.toml (legacy)`, or `(none)` |

### json mode (`--json`)

emits the historical envelope `auth status` has always produced:

```json
{
  "apiUrl": "https://owlette.app",
  "profile": "default",
  "configPath": "/home/you/.config/owlette/config.toml",
  "credentialPath": "/home/you/.config/owlette/credentials.json",
  "credentialSource": "token-file",
  "environment": "live",
  "whoami": { /* raw GET /api/whoami response — userId, email, key, rateLimit, quota, primarySiteId */ }
}
```

> note: `whoami` predates the `{ ok, data }` wrapper introduced for new commands. its envelope is the raw shape above for backward compatibility — see [overview](../overview.md#json-envelope-schema) for the full envelope policy.

---

## exit codes

- `0` — success
- `1` — network failure or non-2xx response from `GET /api/whoami` (e.g. `401 token_expired`)
- `2` — no token configured for the active profile (run `owlette auth login` first)

---

## notes

- **scope**: user (no site / machine targeting — asks about the cli's own credential)
- **tier**: `[ready]`
- **alias**: [`auth status`](auth.md#auth-status) — same code path, byte-identical stdout/stderr
- **token source**: precedence is `OWLETTE_TOKEN` env var -> OS keychain/token-file credential store -> legacy active profile `token` field in `config.toml`. `--profile <name>` picks the profile; the bare command uses `default`
- **related**: [`auth login`](auth.md#auth-login) to mint + store the token this command introspects, [`key list`](key.md) for the server-side view of every key on your account
